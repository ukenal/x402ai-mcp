# x402ai-mcp

A local MCP server that lets AI clients (Claude Desktop, Claude Code, Cursor and others) call the paid
[x402ai](https://api.x402ai.dev) endpoints, paying per call in USDC on Base through the
[x402 protocol](https://x402.org), plus a free inspector for any x402 endpoint.

It runs on your machine over stdio. You give it a buyer key; it answers each HTTP 402 payment challenge by signing a
USDC authorization, and returns the result. Nothing is hosted for you and no account is needed.

## Tools

| Tool        | Cost  | What it does |
|-------------|-------|--------------|
| `embed`     | $0.01 | 768-dimension text embedding (nomic-embed-text) |
| `summarize` | $0.02 | Summary of the input text (small local LLM) |
| `ask`       | $0.04 | Short answer, 2-3 sentences; no web access, no memory, can be wrong |
| `health`    | free  | x402ai service status, plus this session's spend and remaining cap |
| `inspect`   | free  | Takes a URL: decodes its 402 challenge, runs Coinbase's x402 validator and a Bazaar merchant lookup |

Paid tools take one `input` string of up to 3,000 characters. `health` and `inspect` need no key.

## Before you start: use a dedicated wallet

This server holds a private key that can spend money. Use a **new wallet that exists only for this**, funded with a few
dollars of USDC on Base at most. Payments are gasless for the payer (EIP-3009), so the wallet needs USDC only, no ETH.
Never use a wallet that holds anything you can't afford to lose. The wallet balance is your real spending limit.

## Can you trust this package?

This server asks for a key that can spend money, and fake "x402 MCP" packages that steal keys have been reported.
Don't take this README's word for it: the claims below are meant to be checked.

- **The package never sends or logs your key.** It is read once from `X402AI_BUYER_PRIVATE_KEY` and used only to sign
  payment authorizations locally, and it is scrubbed from error messages. It stays in this process's environment and
  memory while the server runs, so anything that can read those (other code in this process, other programs running as
  your user, your client's config file) can read the key. Clearing the variable inside the process would not change
  that, because Linux keeps a process's starting environment readable under /proc.
- **Every host it contacts.** No request follows a redirect; a redirect is refused and the call fails.
  - `https://api.x402ai.dev`: the paid tools and `health`. Signed authorizations go only here, only for the calling
    tool's own route and price, and expire within 300 seconds.
  - `https://api.cdp.coinbase.com`: only when you run `inspect` (Coinbase's validator and merchant lookup).
  - The URL you pass to `inspect`: one unpaid request (with a fixed body for POST). Nothing is signed.
- **No telemetry, analytics or update checks.**
- **Small and readable.** Five source files in `src/` (about 600 lines), built with `tsc` into `dist/`. The published
  package contains only `dist/`, this README, `LICENSE` and `package.json`.
- **Pinned dependencies.** Direct dependencies are pinned to exact versions. npm resolves *their* dependencies fresh,
  within the ranges they declare, when you install, so those aren't frozen; the repository's `package-lock.json`
  records the exact set that was tested. No dependency runs an install script. All dependencies have verified npm
  registry signatures (`npm audit signatures`). The x402 client is `@x402/fetch` 2.28.0, with a per-payment cap set in
  code.
- **The spend safeguards stop honest code from overspending; they do nothing against a malicious package.** That is why
  the points above are checkable.

**How to check:** compare the published files with the source (`npm pack x402ai-mcp@<version>` downloads the exact
tarball for inspection), confirm the package name is exactly `x402ai-mcp`, and read `src/`.

**Don't run unvetted MCP servers in the same client as a funded key.** Any other program running as your user,
including another MCP server, can typically read this process's environment and your client's config file, which holds
the key in plain text.

## Install

Requires Node.js 20 or later. Add it to your MCP client's configuration, for example:

```json
{
  "mcpServers": {
    "x402ai": {
      "command": "npx",
      "args": ["-y", "x402ai-mcp"],
      "env": {
        "X402AI_BUYER_PRIVATE_KEY": "0x...",
        "X402AI_MAX_SESSION_USD": "0.25"
      }
    }
  }
}
```

Note that most clients store this file in plain text, so the key sits on disk unencrypted. That is one more reason to use
a dedicated low-balance wallet.

To try it without a key or any spending, set `X402AI_DRY_RUN=1`: paid tools then return the price quote they would
pay, and never sign anything.

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `X402AI_BUYER_PRIVATE_KEY` | none | Buyer key (hex). Needed only for paid tools. Never logged; scrubbed from error messages. |
| `X402AI_MAX_SESSION_USD` | `0.25` | Total the server may spend per process. An invalid value stops it at startup. |
| `X402AI_DRY_RUN` | off | `1` = quote only, never sign. No key needed. |

The server logs to stderr only (stdout carries the MCP protocol). At startup it prints whether a key is configured, the
buyer address and the session cap.

## Spending safeguards

- **Per payment:** before signing, each paid tool checks that the challenge is for Base mainnet, USDC, x402ai's payment
  address, and **that tool's own route**, at or below that route's price. Anything else is refused. A per-payment
  maximum of $0.04 is enforced as a second check.
- **Short-lived authorizations.** A challenge that asks for an authorization valid longer than 300 seconds is refused
  before signing, so a leaked authorization cannot stay usable for long.
- **Per session:** each payment attempt is reserved against `X402AI_MAX_SESSION_USD` before signing. Once the cap is
  reached, paid tools refuse until the server restarts.
- **The session cap is per process.** It is counted in memory, resets when the server restarts, and each running copy
  of the server gets its own cap, even with the same wallet. The wallet balance is the only hard limit: fund it with
  only what you are willing to lose.
- **The cap has no upper limit.** A typo such as `250` means $250. The wallet balance is the backstop that always holds.

## Things to know

- **A failed call can still count.** If the server returns an error after the payment was signed, the reservation is
  kept, because a signed authorization can still settle. You are not charged when x402ai's handler fails, but the
  session cap treats the attempt as spent.
- **`inspect` sends the URL you give it to Coinbase's CDP** (validator and merchant lookup). Don't inspect URLs you
  want to keep private.
- **`inspect` refuses local and private addresses** (loopback, private ranges, link-local, CGNAT, IPv6 ULA, and IPv4
  addresses wrapped in IPv6 forms), checked after DNS resolution. It allows https only.
  A DNS change between the check and the request (DNS rebinding) is still possible.
- **Treat tool output as untrusted data.** Answers and summaries come from a small model and may be wrong; responses
  from inspected endpoints are third-party content. Don't let them act as instructions to your agent.
- **Latency:** `embed` is usually under a second; `summarize` and `ask` take about 5-15 seconds (CPU inference).
- **Claude Code may load tool schemas late.** Claude Code defers MCP tool schemas by default, so the first call to a tool can go out with wrong or empty arguments. Starting Claude Code with `ENABLE_TOOL_SEARCH=false` loads them up front.

## License

MIT. Not affiliated with Coinbase or the x402 Foundation.
