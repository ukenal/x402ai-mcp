#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { VERSION, loadConfig, log, scrubKey } from "./config.js";
import { PaymentRuntime } from "./payment.js";
import { registerTools } from "./tools.js";

let startupKey: string | undefined; // the key as loadConfig() read it; the env var is not read again

async function main(): Promise<void> {
  console.log = console.error; // stdout is the MCP channel; stray logging must not corrupt it
  const config = loadConfig();
  startupKey = config.scrubValue;
  const rt = new PaymentRuntime(config);

  const server = new McpServer({ name: "x402ai-mcp", version: VERSION });
  registerTools(server, rt);

  const shutdown = () => { void server.close().finally(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("unhandledRejection", (e) => log("unhandled rejection:", rt.scrub(e instanceof Error ? e.message : String(e))));

  await server.connect(new StdioServerTransport());
  log(`ready (key ${config.privateKey ? "configured" : "missing"}, dry-run ${config.dryRun})`);
}

main().catch((e) => {
  const message = e instanceof Error ? e.message : "startup failed";
  log("fatal:", scrubKey(message, startupKey));
  process.exit(1);
});
