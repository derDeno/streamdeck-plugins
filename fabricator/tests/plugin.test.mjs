import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { panelAddress } from "../de.derdeno.fabricator.sdPlugin/bin/panel.js";

const uuid = "de.derdeno.fabricator";
const password = "test password with spaces ";
const first = "srv_aaaa0001";
const second = "srv_bbbb0002";
const folder = new URL("../de.derdeno.fabricator.sdPlugin/", import.meta.url);

test("panel addresses accept IPs, hostnames and explicit ports", () => {
  assert.equal(panelAddress(" 192.168.1.10 "), "http://192.168.1.10:5000");
  assert.equal(panelAddress("[::1]"), "http://[::1]:5000");
  assert.equal(panelAddress("[::1]:8080"), "http://[::1]:8080");
  assert.equal(panelAddress("https://minecraft.example.com/"), "https://minecraft.example.com");
  for (const address of ["", "file://panel", "https://user:secret@panel", "http://panel/a/..", "http:///panel", "panel?x"]) {
    assert.throws(() => panelAddress(address));
  }
});

test("visible keys share settings and a heap-aware poll, and discovery returns server names and IDs", { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  const metricTitles = {
    players: "3", uptime: "2h 5m", tps: "19.8 TPS", state: "Running", cpu: "123.4%", heap: "1.5 GiB",
  };
  for (const kind of Object.keys(metricTitles)) f.event("willAppear", kind);
  await f.waitFor("setTitle", "players", { title: "Set up" });
  f.configure(first);
  for (const [kind, title] of Object.entries(metricTitles)) await f.waitFor("setTitle", kind, { title });
  const runningIcon = await f.waitFor("setImage", "state", { image: "imgs/state-running.png" });
  assert.deepEqual(f.reads, [`/api/servers/${first}?heap=1`]);
  assert.equal(f.logins, 1);

  f.event("sendToPlugin", "state", { type: "listServers", id: "lookup", address: f.address, password });
  const list = await f.waitFor("sendToPropertyInspector", "state", { id: "lookup" });
  assert.deepEqual(list.payload.servers, [{ id: first, name: "Overworld" }, { id: second, name: "Creative" }]);
  assert.equal(JSON.stringify(f.messages).includes(password), false);

  f.event("willDisappear", "heap");
  f.configure(second);
  await f.waitFor("setTitle", "state", { title: "Stopped" });
  await f.waitFor("setTitle", "players", { title: "0" });
  const stoppedIcon = await f.waitFor("setImage", "state", { image: "imgs/state-stopped.png" });
  assert(f.messages.slice(f.messages.indexOf(runningIcon) + 1, f.messages.indexOf(stoppedIcon))
    .some((message) => message.event === "setImage" && message.context === "state" && !message.payload.image));
  await f.waitFor("setTitle", "tps", { title: "--" });
  assert.equal(f.reads.at(-1), `/api/servers/${second}`);
  f.event("keyDown", "admin");
  await f.waitFor("openUrl", undefined, { url: `${f.address}/server/${second}/overview` });

  f.failReads();
  f.event("keyDown", "state");
  await f.waitFor("setTitle", "state", { title: "Unavailable" });
  assert(f.messages.slice(f.messages.indexOf(stoppedIcon) + 1)
    .some((message) => message.event === "setImage" && message.context === "state" && !message.payload.image));
});

test("lifecycle and console keys dispatch to the shared server and renew expired sessions", { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  f.configure(second);
  for (const action of ["start", "stop", "restart"]) {
    f.event("keyDown", action);
    await f.waitFor("showOk", action);
  }
  f.expireSession();
  for (const [context, command] of [["announcement", " /say Maintenance soon "], ["save", "save-all"]]) {
    f.event("keyDown", "console", { settings: { command } }, context);
    await f.waitFor("showOk", context);
  }
  f.event("keyDown", "console", { settings: { command: "say hi\nstop" } });
  await f.waitFor("showAlert", "console");
  assert.equal(f.logins, 2);
  assert.deepEqual(f.writes, [
    [`/api/servers/${second}/start`, {}], [`/api/servers/${second}/stop`, {}], [`/api/servers/${second}/restart`, {}],
    [`/api/servers/${second}/console`, { command: "say Maintenance soon" }],
    [`/api/servers/${second}/console`, { command: "save-all" }],
  ]);
});

async function fixture(t) {
  const reads = [];
  const writes = [];
  let logins = 0;
  let session = "";
  let readsFail = false;
  const panel = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    const json = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.url === "/api/auth/login") {
      if (body?.password !== password) return json(401, { error: "invalid credentials" });
      session = `session=cookie${++logins}`;
      res.setHeader("Set-Cookie", [`proxy=1; Path=/`, `${session}; HttpOnly; Path=/; SameSite=Lax`]);
      return json(200, { authenticated: true });
    }
    if (!session || req.headers.cookie !== session) return json(401, { error: "authentication required" });
    if (req.url === "/api/servers") return json(200, [
      { id: first, name: "Overworld", secret: "internal detail" }, { id: second, name: "Creative" },
    ]);
    if (req.method === "POST") {
      writes.push([req.url, body]);
      return json(200, { success: true });
    }
    reads.push(req.url);
    if (readsFail) return json(503, { error: "unavailable" });
    if (req.url === `/api/servers/${first}?heap=1`) return json(200, {
      id: first, status: "running", runtime: { players: { online: 3 }, uptime: "2h 5m", tps: 19.78,
        cpu: 123.4, ram: { rssBytes: 4000000000, heapUsedBytes: 1.5 * 1024 ** 3 } },
    });
    if (req.url === `/api/servers/${second}`) return json(200, { id: second, status: "stopped", runtime: {} });
    json(404, { error: "server not found" });
  });
  panel.listen(0, "127.0.0.1");
  const deck = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await Promise.all([once(panel, "listening"), once(deck, "listening")]);
  const address = `http://127.0.0.1:${panel.address().port}`;
  const connected = once(deck, "connection");
  const child = spawn(process.execPath, ["bin/plugin.js", "-port", String(deck.address().port), "-pluginUUID", uuid,
    "-registerEvent", "registerPlugin"], { cwd: folder, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = once(child, "exit");
  t.after(async () => {
    child.kill();
    await exited;
    for (const client of deck.clients) client.terminate();
    await Promise.all([new Promise((done) => deck.close(done)), new Promise((done) => panel.close(done))]);
    assert.equal(stderr, "");
  });
  const [socket] = await Promise.race([connected, exited.then(() => assert.fail(`Plugin exited: ${stderr}`))]);
  const messages = [];
  socket.on("message", (data) => messages.push(JSON.parse(data)));
  const send = (message) => socket.send(JSON.stringify(message));
  const waitFor = async (event, context, payload = {}) => {
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      const match = messages.find((message) => message.event === event && message.context === context &&
        Object.entries(payload).every(([key, value]) => message.payload?.[key] === value));
      if (match) return match;
      await delay(10);
    }
    assert.fail(`Timed out waiting for ${event} on ${context}`);
  };
  await waitFor("getGlobalSettings", uuid);
  return {
    address, messages, reads, writes, get logins() { return logins; }, waitFor,
    expireSession: () => { session = ""; },
    failReads: () => { readsFail = true; },
    configure: (serverId) => send({ event: "didReceiveGlobalSettings", payload: { settings: { address, password, serverId } } }),
    event: (event, kind, payload = {}, context = kind) => send({ event, action: `${uuid}.${kind}`, context, device: "deck", payload }),
  };
}
