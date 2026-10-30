import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { guardedLookup, probePinned } from "../dist/inspect.js";
import { checkRequirement, noRedirectFetch, mapPaidError, REDIRECT_MESSAGE, MAX_AUTH_LIFETIME_SECONDS } from "../dist/payment.js";
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

const callLookup = (lookup, host, options) =>
  new Promise((resolve, reject) => lookup(host, options, (err, address, family) => (err ? reject(err) : resolve({ address, family }))));
const PRIVATE_MSG = /local and private hosts/;

test("guarded lookup refuses localhost in both callback shapes", async () => {
  const lookup = guardedLookup();
  await assert.rejects(() => callLookup(lookup, "localhost", { all: true }), PRIVATE_MSG);
  await assert.rejects(() => callLookup(lookup, "localhost", { all: false }), PRIVATE_MSG);
});

test("guarded lookup passes a public answer through in both shapes", async () => {
  const lookup = guardedLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
  const all = await callLookup(lookup, "example.test", { all: true });
  assert.deepEqual(all.address, [{ address: "93.184.216.34", family: 4 }]);
  const one = await callLookup(lookup, "example.test", { all: false });
  assert.equal(one.address, "93.184.216.34");
  assert.equal(one.family, 4);
});

test("DNS rebinding: the guard refuses a name that now resolves to 127.0.0.1", async () => {
  let connections = 0;
  const server = net.createServer((socket) => { connections++; socket.destroy(); });
  const port = await listen(server);
  const resolver = async () => [{ address: "127.0.0.1", family: 4 }];
  const unguarded = (host, options, cb) =>
    resolver(host).then((a) => (options && options.all ? cb(null, a) : cb(null, a[0].address, a[0].family)));
  const url = new URL(`https://rebind.test:${port}/`);
  try {
    // control: without the guard the local server is reached
    await assert.rejects(() => probePinned(url, "POST", unguarded)); // TLS fails, the TCP connect happened
    assert.equal(connections, 1);

    connections = 0;
    await assert.rejects(() => probePinned(url, "POST", guardedLookup(resolver)), PRIVATE_MSG);
    assert.equal(connections, 0);
  } finally {
    await close(server);
  }
});

test("a paid call meeting a redirect maps to the redirect message", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(307, { location: "http://127.0.0.1:9/" });
    res.end();
  });
  const port = await listen(server);
  const client = new x402Client();
  client.register("eip155:8453", new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())));
  const pay = wrapFetchWithPayment(noRedirectFetch, client);
  try {
    let caught;
    try { await pay(`http://127.0.0.1:${port}/`, { method: "POST", body: "{}" }); } catch (e) { caught = e; }
    assert.ok(caught, "the redirect must reject");
    const mapped = mapPaidError(caught, (t) => t);
    assert.equal(mapped.message, REDIRECT_MESSAGE);
  } finally {
    await close(server);
  }
});
