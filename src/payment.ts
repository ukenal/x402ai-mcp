import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import {
  BASE_URL, EXPECTED, MAX_PER_PAYMENT_USD, PAID_TIMEOUT_MS, PROBE_TIMEOUT_MS, ROUTES,
  atomicToUsd, log, type Config, type PaidTool,
} from "./config.js";

/** An error whose message is safe and useful to show to the AI client. */
export class UserError extends Error {}

// ---- guard (pure; shared by the live hook and dry-run) ---------------------

/** Exact match of the challenge's resource URL against BASE_URL + route.path. */
function routeForResource(resourceUrl: string | undefined) {
  if (!resourceUrl) return undefined;
  for (const route of Object.values(ROUTES)) {
    if (resourceUrl === BASE_URL + route.path) return route;
  }
  return undefined;
}

export function checkRequirement(
  r: { payTo: string; asset: string; network: string; amount: string },
  resourceUrl: string | undefined,
): string | undefined {
  if (r.network !== EXPECTED.network) return `network ${r.network} is not ${EXPECTED.network}`;
  if (r.asset.toLowerCase() !== EXPECTED.asset.toLowerCase()) return `asset ${r.asset} is not the expected USDC contract`;
  if (r.payTo.toLowerCase() !== EXPECTED.payTo.toLowerCase()) return `payTo ${r.payTo} is not the expected recipient`;
  const route = routeForResource(resourceUrl);
  if (!route) return `resource ${resourceUrl ?? "(none)"} is not a known x402ai route`;
  if (!/^\d+$/.test(r.amount)) return `amount ${r.amount} is not an atomic integer`;
  if (BigInt(r.amount) > route.maxAtomic) {
    return `amount ${r.amount} exceeds this route's cap of ${route.maxAtomic} (${route.price})`;
  }
  return undefined;
}

// ---- session budget ---------------------------------------------------------

export class SessionBudget {
  private spent = 0n;
  constructor(readonly cap: bigint) {}
  get spentAtomic(): bigint { return this.spent; }
  get remainingAtomic(): bigint { return this.cap > this.spent ? this.cap - this.spent : 0n; }
  /** Synchronous on purpose: no await between check and increment, so concurrent calls cannot overshoot. */
  reserve(amount: bigint): string | undefined {
    if (this.spent + amount > this.cap) {
      return `session cap reached: spent $${atomicToUsd(this.spent)} of $${atomicToUsd(this.cap)}, this payment is $${atomicToUsd(amount)}`;
    }
    this.spent += amount;
    return undefined;
  }
  release(amount: bigint): void { this.spent = this.spent > amount ? this.spent - amount : 0n; }
}

// ---- decoding the challenge ------------------------------------------------

const AcceptSchema = z.object({
  scheme: z.string(),
  network: z.string(),
  asset: z.string(),
  amount: z.string(),
  payTo: z.string(),
  maxTimeoutSeconds: z.number().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});
const PaymentRequiredSchema = z.object({
  x402Version: z.number(),
  error: z.string().optional(),
  resource: z.object({
    url: z.string().optional(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
  }).optional(),
  accepts: z.array(AcceptSchema),
});
export type ParsedPaymentRequired = z.infer<typeof PaymentRequiredSchema>;

export interface ProbeResult {
  status: number;
  headerPresent: boolean;
  paymentRequired?: ParsedPaymentRequired;
  decodeError?: string;
}

/** Unpaid request that never signs anything. redirect:"manual" so we never follow a redirect off-host. */
export async function probe(url: string, method: "GET" | "POST"): Promise<ProbeResult> {
  const res = await fetch(url, {
    method,
    headers: { accept: "application/json", ...(method === "POST" ? { "content-type": "application/json" } : {}) },
    body: method === "POST" ? JSON.stringify({ input: "x402ai-mcp probe" }) : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  await res.body?.cancel().catch(() => {});
  const header = res.headers.get("payment-required");
  if (!header) return { status: res.status, headerPresent: false };
  try {
    const parsed = PaymentRequiredSchema.safeParse(decodePaymentRequiredHeader(header));
    if (!parsed.success) return { status: res.status, headerPresent: true, decodeError: "payment-required header does not match the expected shape" };
    return { status: res.status, headerPresent: true, paymentRequired: parsed.data };
  } catch (e) {
    return { status: res.status, headerPresent: true, decodeError: e instanceof Error ? e.message : "decode failed" };
  }
}

// ---- runtime ----------------------------------------------------------------

export class PaymentRuntime {
  readonly budget: SessionBudget;
  private payingFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  buyerAddress?: string;

  constructor(readonly config: Config) {
    this.budget = new SessionBudget(config.maxSessionAtomic);
  }

  /** Remove the key (with and without 0x) from any text before it can reach a client or the log. */
  scrub(text: string): string {
    const key = this.config.privateKey;
    if (!key) return text;
    return text.split(key).join("[redacted]").split(key.slice(2)).join("[redacted]");
  }

  private getFetch() {
    if (this.payingFetch) return this.payingFetch;
    if (this.config.keyProblem) throw new UserError(this.config.keyProblem);
    if (!this.config.privateKey) {
      throw new UserError("X402AI_BUYER_PRIVATE_KEY is not set. Paid tools (embed, summarize, ask) need a funded Base USDC buyer key; health and inspect work without it.");
    }
    let account;
    try {
      account = privateKeyToAccount(this.config.privateKey as `0x${string}`);
    } catch {
      throw new UserError("X402AI_BUYER_PRIVATE_KEY could not be used to create a signer."); // never echo the key or viem's message
    }
    this.buyerAddress = account.address;

    const client = x402Client.fromConfig({
      schemes: [{ network: EXPECTED.network, client: new ExactEvmScheme(account) }],
      spendControls: { maxAmountPerPayment: MAX_PER_PAYMENT_USD },
    });
    // Hook order matters: guard first, session cap second (a guard abort must not reserve budget).
    client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements: r }) => {
      const problem = checkRequirement(r, paymentRequired.resource?.url);
      if (problem) return { abort: true as const, reason: problem };
    });
    client.onBeforePaymentCreation(async ({ selectedRequirements: r }) => {
      const refusal = this.budget.reserve(BigInt(r.amount));
      if (refusal) return { abort: true as const, reason: refusal };
    });
    client.onPaymentCreationFailure(async ({ selectedRequirements: r }) => {
      this.budget.release(BigInt(r.amount)); // nothing was signed
    });

    this.payingFetch = wrapFetchWithPayment(fetch, client);
    log(`buyer address ${account.address}; session cap $${atomicToUsd(this.budget.cap)}`);
    return this.payingFetch;
  }

  /** Dry run: decode the price quote without signing. */
  async quote(tool: PaidTool) {
    const route = ROUTES[tool];
    const url = `${BASE_URL}${route.path}`;
    const p = await probe(url, "POST");
    if (!p.paymentRequired) {
      throw new UserError(`No usable payment quote from ${url} (HTTP ${p.status}${p.decodeError ? `, ${p.decodeError}` : ""}).`);
    }
    // Same inputs the live hook sees: the server-reported resource URL, matched against its own route.
    const resourceUrl = p.paymentRequired.resource?.url;
    return {
      dryRun: true,
      signed: false,
      tool,
      expectedPrice: route.price,
      resource: resourceUrl ?? url,
      accepts: p.paymentRequired.accepts.map((a) => {
        const guardFailure = checkRequirement(a, resourceUrl);
        return {
          scheme: a.scheme,
          network: a.network,
          asset: a.asset,
          payTo: a.payTo,
          amountAtomic: a.amount,
          amountUsd: /^\d+$/.test(a.amount) ? atomicToUsd(BigInt(a.amount)) : undefined,
          wouldPass: guardFailure === undefined,
          guardFailure,
        };
      }),
      sessionRemainingUsd: atomicToUsd(this.budget.remainingAtomic),
    };
  }

  async runPaid(tool: PaidTool, input: string) {
    if (this.config.dryRun) return this.quote(tool);
    const pay = this.getFetch();
    const route = ROUTES[tool];
    let res: Response;
    try {
      res = await pay(`${BASE_URL}${route.path}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ input }),
        signal: AbortSignal.timeout(PAID_TIMEOUT_MS),
      });
    } catch (e) {
      const msg = this.scrub(e instanceof Error ? e.message : String(e));
      if (/timeout|aborted/i.test(msg) && !/Payment creation aborted/.test(msg)) {
        throw new UserError(`Request timed out after ${PAID_TIMEOUT_MS / 1000}s. A payment may already have been signed and settled; it is still counted against the session cap. Do not retry blindly.`);
      }
      throw new UserError(msg);
    }

    const text = (await res.text()).slice(0, 200_000);
    const settlement = (() => {
      const h = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
      if (!h) return undefined;
      try {
        const s = decodePaymentResponseHeader(h);
        return { success: s.success, transaction: s.transaction, network: s.network, payer: s.payer, errorReason: s.errorReason };
      } catch { return undefined; }
    })();

    if (res.status === 402) {
      throw new UserError("Payment was not accepted by the server (HTTP 402 after paying). The attempt stays counted against the session cap.");
    }
    if (!res.ok) throw new UserError(`API error HTTP ${res.status}: ${this.scrub(text.slice(0, 500))}`);

    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new UserError("API returned a non-JSON response."); }
    const value = (body as Record<string, unknown> | null)?.[route.field];
    if (value === undefined) throw new UserError(`API response is missing "${route.field}".`);
    return {
      tool,
      [route.field]: value,
      payment: {
        priceUsd: route.price,
        settlement,
        sessionSpentUsd: atomicToUsd(this.budget.spentAtomic),
        sessionCapUsd: atomicToUsd(this.budget.cap),
      },
    };
  }
}
