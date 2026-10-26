import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { checkRequirement, noRedirectFetch, MAX_AUTH_LIFETIME_SECONDS } from "../dist/payment.js";
import { BASE_URL, EXPECTED, ROUTES, loadConfig, scrubKey } from "../dist/config.js";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });

test("redirects: plain fetch follows and leaks the header; noRedirectFetch refuses", async () => {
  let bHits = 0;
  let bSawHeader = false;
  const b = http.createServer((req, res) => {
    bHits++;
    if (req.headers["payment-signature"] === "dummy") bSawHeader = true;
    res.end("b");
  });
  const bPort = await listen(b);
  const a = http.createServer((_req, res) => {
    res.writeHead(307, { location: `http://127.0.0.1:${bPort}/` });
    res.end();
  });
  const aPort = await listen(a);
  const url = `http://127.0.0.1:${aPort}/`;
  const init = { method: "POST", headers: { "PAYMENT-SIGNATURE": "dummy" }, body: "{}" };
  try {
    // control
    await (await fetch(url, init)).text();
    assert.equal(bHits, 1);
    assert.ok(bSawHeader, "control: plain fetch should deliver the header to B");

    bHits = 0;
    await assert.rejects(() => noRedirectFetch(url, init));
    assert.equal(bHits, 0);
  } finally {
    await close(a);
    await close(b);
  }
});

test("checkRequirement: authorization lifetime", () => {
  const route = ROUTES.embed;
  const base = { payTo: EXPECTED.payTo, asset: EXPECTED.asset, network: EXPECTED.network, amount: "10000" };
  const url = BASE_URL + route.path;
  const check = (extra) => checkRequirement({ ...base, ...extra }, url, route);
  assert.equal(MAX_AUTH_LIFETIME_SECONDS, 300);
  assert.equal(check({ maxTimeoutSeconds: 300 }), undefined);
  assert.equal(check({ maxTimeoutSeconds: 1 }), undefined);
  for (const bad of [301, 3600, 0, -5, 1.5, "300", NaN]) {
    assert.match(check({ maxTimeoutSeconds: bad }) ?? "", /maxTimeoutSeconds/, `should reject ${String(bad)}`);
  }
  assert.match(check({}) ?? "", /maxTimeoutSeconds \(none\)/);
});

test("loadConfig: a malformed key is not usable but is still scrubbable", () => {
  const fake = "0x" + "ab".repeat(31) + "a"; // 63 hex digits, obviously fake
  const cfg = loadConfig({ X402AI_BUYER_PRIVATE_KEY: fake });
  assert.equal(cfg.privateKey, undefined);
  assert.ok(cfg.keyProblem);
  assert.ok(cfg.scrubValue);
  const out = scrubKey(`oops ${cfg.scrubValue}`, cfg.scrubValue);
  assert.ok(!out.includes("ab".repeat(31) + "a"));
});
