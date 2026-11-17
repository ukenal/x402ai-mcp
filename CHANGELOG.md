# Changelog

## 0.1.3 - 2026-11-17

### Added
- `policy_check` tool ($0.01 per call, up to 20 actions): sends a profile (`baseline` or `strict`), the agent's context and 1-20 proposed actions to `POST /api/policy-check` and returns the engine's JSON unchanged as `result`. It checks actions; it does not enforce them. The input schema refuses locally only what the server would reject with 400 (unknown profile, 0 or more than 20 actions, any string over 2048 characters); per-action fields stay optional because the engine marks a missing or wrong field `needs_review`.
- The payment path is the same as for the other paid tools: its own x402 client bound to `/api/policy-check` at most 10000 atomic USDC, the session cap, no redirects, the 300-second authorization limit, the same error mapping and key scrubbing. `X402AI_DRY_RUN=1` quotes the route without signing.
- Offline tests: the route guard for `/api/policy-check` (10000 passes, 10001 and an `/api/embed` resource are refused) and the input schema limits.

### Changed
- The shared paid-request code now sends any JSON body; `embed`, `summarize` and `ask` behave as before.
- `policy_check`: unknown keys on an action item are kept and forwarded to the server unchanged (the top level and `context` still drop them). Offline test: `{"type":"exec","cmd":"x"}` keeps `cmd`.

### Fixed
- Error scrubbing now also redacts the raw `X402AI_BUYER_PRIVATE_KEY` value when it is malformed, not only a valid key. Offline test with a malformed 63-digit key generated at run time.

## 0.1.2 - 2026-10-30

### Security
- `inspect`: DNS rebinding is closed for the request to the inspected URL. The addresses are checked at connect time, in the same lookup the socket uses (`node:https` with a guarded `lookup` that refuses if any resolved address is local or private), so a DNS answer that changes after the early check cannot reach a private address. The early check stays, and covers IP-literal URLs. TLS hostname verification, no redirects and the read-only probe are unchanged.

### Added
- Offline tests: the guarded lookup (both callback shapes), a DNS-rebinding test with a local TCP server and a control, and the error message for a paid call that meets a redirect.

### Fixed
- `npm test` now runs on Node 20 and 22 (`node --test test/*.test.mjs`).
- The error mapping for paid calls moved into an exported function so it can be tested; behavior unchanged. The payment-required header decoding is shared between `probe` and `inspect`.
- Dependencies: `@x402/core`, `@x402/evm` and `@x402/fetch` pinned to 2.29.0.

## 0.1.1 - 2026-10-26

Security fixes from an external review. Thanks to an external reviewer.

### Security
- No request follows a redirect. A redirect is refused and the call fails, so a signed payment authorization and the request body are never replayed to another URL. This covers the paid tools, `health` and `inspect`'s Coinbase calls; `inspect`'s request to the target URL already refused redirects.
- A payment challenge that asks for an authorization valid longer than 300 seconds is refused before signing.
- The key is read from the environment once, and a malformed key is still redacted from fatal startup messages.

### Changed
- README: the key claim now states what is tested (the package never sends or logs the key) and what is not (anything else that can read this process's environment or memory can read the key).
- README: the host list says no request follows a redirect, and the session cap is documented as per process.
- README: a note for Claude Code users about tool schemas loading late.

### Added
- Offline tests (`npm test`): redirect refusal with two local servers, the authorization-lifetime guard, and malformed-key scrubbing.
- `mcpName` in package.json and a `server.json` for the official MCP Registry.

### Known gaps
- The error message returned when a paid call meets a redirect is not covered by a test; the redirect refusal itself is.
- `inspect`: a DNS change between the address check and the request (DNS rebinding) is still possible.

Before release, three paid calls (summarize, ask, embed) settled on Base mainnet through this code.

## 0.1.0 - 2026-10-23

- First release: a local stdio MCP server with paid tools `embed`, `summarize` and `ask` (x402, USDC on Base) and free tools `health` and `inspect`; a per-payment route guard, a per-session cap and a dry-run mode.
