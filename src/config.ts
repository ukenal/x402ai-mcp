export const VERSION = "0.1.0"; // keep in sync with package.json

export const BASE_URL = "https://api.x402ai.dev";
export const EXPECTED = {
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0xecE637d74aB1a000abcf69956e22f1131501ae8b",
} as const;

export const MAX_PER_PAYMENT_USD = "$0.04"; // backstop passed to x402 spendControls
export const DEFAULT_MAX_SESSION_USD = "0.25";
export const MAX_INPUT_CHARS = 3000;
export const PAID_TIMEOUT_MS = 60_000;
export const PROBE_TIMEOUT_MS = 15_000;

export const ROUTES = {
  embed: { path: "/api/embed", price: "$0.01", maxAtomic: 10_000n, field: "embedding" },
  summarize: { path: "/api/summarize", price: "$0.02", maxAtomic: 20_000n, field: "summary" },
  ask: { path: "/api/ask", price: "$0.04", maxAtomic: 40_000n, field: "answer" },
} as const;
export type PaidTool = keyof typeof ROUTES;

/** stdout carries the MCP protocol, so every log line goes to stderr. */
export function log(...args: unknown[]): void {
  console.error("[x402ai-mcp]", ...args);
}

/** "0.25" or "$0.25" -> atomic USDC units (6 decimals). Throws on bad input. */
export function usdToAtomic(text: string): bigint {
  const m = /^\$?(\d{1,6})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!m) throw new Error(`Invalid USD amount: ${JSON.stringify(text)}`);
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

export function atomicToUsd(atomic: bigint): string {
  const whole = atomic / 1_000_000n;
  const frac = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${frac}`;
}

export interface Config {
  privateKey: string | undefined; // normalized 0x + 64 hex; NEVER log
  keyProblem: string | undefined; // set when the env var is present but malformed
  maxSessionAtomic: bigint;
  dryRun: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let privateKey: string | undefined;
  let keyProblem: string | undefined;
  const raw = env.X402AI_BUYER_PRIVATE_KEY?.trim();
  if (raw) {
    const hex = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
    if (/^[0-9a-fA-F]{64}$/.test(hex)) privateKey = `0x${hex}`;
    else keyProblem = "X402AI_BUYER_PRIVATE_KEY is set but is not a 32-byte hex private key.";
  }

  let maxSessionAtomic: bigint;
  try {
    maxSessionAtomic = usdToAtomic(env.X402AI_MAX_SESSION_USD?.trim() || DEFAULT_MAX_SESSION_USD);
  } catch {
    // Fail at startup rather than silently running with a different cap than the user asked for.
    throw new Error("X402AI_MAX_SESSION_USD must be a decimal USD amount such as 0.25 (max 6 decimals).");
  }

  const dry = env.X402AI_DRY_RUN?.trim().toLowerCase();
  return { privateKey, keyProblem, maxSessionAtomic, dryRun: dry === "1" || dry === "true" };
}
