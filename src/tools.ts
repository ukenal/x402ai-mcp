import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { BASE_URL, MAX_INPUT_CHARS, ROUTES, atomicToUsd, type PaidTool } from "./config.js";
import { inspectUrl } from "./inspect.js";
import { PaymentRuntime, UserError, noRedirectFetch } from "./payment.js";

const ok = (data: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });

export function registerTools(server: McpServer, rt: PaymentRuntime): void {
  const run = (fn: () => Promise<unknown>) => async (): Promise<CallToolResult> => {
    try { return ok(await fn()); }
    catch (e) { return fail(rt.scrub(e instanceof UserError || e instanceof Error ? e.message : "Unexpected error.")); }
  };

  const inputSchema = z.object({
    input: z
      .string()
      .min(1)
      .max(MAX_INPUT_CHARS)
      .describe(`The text to process, passed as "input": the text to embed or summarize, or for ask, the question. 1-${MAX_INPUT_CHARS} characters.`),
  });
  const paid: Record<PaidTool, string> = {
    embed: "Compute a text embedding vector. Costs $0.01 (USDC on Base) per call.",
    summarize: "Summarize text. Costs $0.02 (USDC on Base) per call; takes 5-16 s.",
    ask: "Ask a question and get an answer. Costs $0.04 (USDC on Base) per call; takes 5-16 s.",
  };
  for (const tool of Object.keys(ROUTES) as PaidTool[]) {
    server.registerTool(
      tool,
      {
        title: `x402ai ${tool}`,
        description: `${paid[tool]} Spends real money; subject to a per-payment and per-session cap. Pass the ${tool === "ask" ? "question" : "text"} in \`input\` (max ${MAX_INPUT_CHARS} chars).`,
        inputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ input }) => run(() => rt.runPaid(tool, input))(),
    );
  }

  server.registerTool(
    "health",
    {
      title: "x402ai health",
      description: "Free. Check GET /health on api.x402ai.dev and show local session spend. No key needed.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async () => {
      let api: unknown;
      try {
        const res = await noRedirectFetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(15_000) });
        api = { status: res.status, body: (await res.text()).slice(0, 2000) };
      } catch (e) { api = { error: e instanceof Error ? e.message : String(e) }; }
      return {
        api,
        session: {
          keyConfigured: Boolean(rt.config.privateKey),
          dryRun: rt.config.dryRun,
          spentUsd: atomicToUsd(rt.budget.spentAtomic),
          capUsd: atomicToUsd(rt.budget.cap),
          remainingUsd: atomicToUsd(rt.budget.remainingAtomic),
        },
      };
    }),
  );

  server.registerTool(
    "inspect",
    {
      title: "x402 inspect",
      description: "Free, never signs or pays. Fetch an https URL unpaid, decode its x402 payment-required header, and check it with Coinbase CDP validate and merchant discovery. Sends the URL to api.cdp.coinbase.com.",
      inputSchema: z.object({
        url: z.string().min(1).max(2048).describe("The https URL of the x402-protected endpoint to inspect (max 2048 chars)."),
        method: z.enum(["GET", "POST"]).default("POST").describe("HTTP method for the unpaid probe request. Defaults to POST."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url, method }) => run(() => inspectUrl(url, method))(),
  );
}
