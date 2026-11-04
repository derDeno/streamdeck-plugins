import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { createMockBoard } from "../scripts/mock-board.mjs";

const uuid = "de.pandaboards.pandadesk";
test("each preset key recalls its native slot without changing saved positions", async (t) => {
  const f = await setup(t);
  f.board.options.presets = [72, 110, 90, 100];
  f.appear("preset", "memory", { preset: 2 });
  await until(() => f.messages.some((m) => m.context === "memory" && m.payload?.title === "Preset 2\n110,0 cm"), "saved memory height");
  for (const slot of [1, 2, 3, 4]) {
    const settings = { preset: slot };
    f.appear("preset", `memory-${slot}`, settings);
    f.event("keyDown", "preset", `memory-${slot}`, settings);
    await until(() => f.board.requests.length === slot, `native recall ${slot}`);
    f.event("keyUp", "preset", `memory-${slot}`, settings);
  }
  f.event("keyDown", "stop", "stop");
  await until(() => f.commands().at(-1) === "stop", "preset stop");
  assert.deepEqual(f.board.options.presets, [72, 110, 90, 100]);
  const presets = f.board.requests.filter((r) => r.path.endsWith("/preset"));
  assert.deepEqual(presets.map((r) => [r.body.preset, r.body.operation]), [1, 2, 3, 4].map((slot) => [slot, "recall"]));
  assert(presets.every((r) => r.body.request_id && r.body.height_cm === undefined));
  assert.equal(f.board.requests.some((r) => r.path.endsWith("/height")), false);
});

test("new keys default to preset 1 and existing recall settings keep working", async (t) => {
  const f = await setup(t);
  f.appear("preset");
  f.event("keyDown", "preset", "preset");
  await until(() => f.board.requests.length === 1, "default preset");
  f.event("keyDown", "preset", "preset", { preset: 2, presetMode: "recall" });
  await until(() => f.board.requests.length === 2, "existing recall key");
  assert.deepEqual(f.board.requests.map((r) => [r.body.preset, r.body.operation]), [[1, "recall"], [2, "recall"]]);
});

test("invalid, empty, locked, unsupported and out-of-range presets never post commands", async (t) => {
  const f = await setup(t);
  f.appear("preset");
  let alerts = 0;
  const reject = async (settings) => {
    const count = ++alerts;
    f.event("keyDown", "preset", "preset", settings);
    await until(() => f.messages.filter((m) => m.event === "showAlert").length === count, "preset rejection");
  };
  for (const preset of [0, 5, 1.5, "2", null]) await reject({ preset });
  await reject({ preset: 3 });
  await reject({ preset: 1, presetMode: "invalid" });
  await reject({ preset: 2, presetMode: "save" });
  f.board.options.minHeight = 80;
  await reject({ preset: 1 });
  f.board.options.locked = true;
  await reject({ preset: 2 });
  await reject({ preset: 2, presetMode: "save" });
  f.board.options.locked = false;
  f.board.options.presetsSupported = false;
  await reject({ preset: 2 });
  await reject({ preset: 2, presetMode: "save" });
  assert.deepEqual(f.board.requests, []);
  await until(() => f.messages.some((m) => m.context === "preset" && m.payload?.image === "imgs/unavailable.svg"), "unsupported icon");
});

test("Stop cancels a preset recall during preflight and presets stop a held move first", async (t) => {
  const f = await setup(t);
  f.board.options.delayBoundsMs = 300;
  f.appear("preset"); f.appear("stop"); f.appear("up");
  f.event("keyDown", "preset", "preset", { preset: 2 });
  await until(() => f.board.reads.includes("/api/v1/settings/device"), "preset bounds preflight");
  f.event("keyDown", "stop", "stop");
  await until(() => f.commands().at(-1) === "stop", "stop cancels recall");
  assert.equal(f.board.requests.some((r) => r.body.operation === "recall"), false);
  f.event("keyDown", "up", "up");
  await until(() => f.commands().at(-1) === "up", "held move");
  f.event("keyDown", "preset", "preset", { preset: 2 });
  await until(() => f.board.requests.some((r) => r.body.operation === "recall"), "recall after hold");
  const commands = f.board.requests;
  assert.equal(commands.at(-2).body.direction, "stop");
  assert.equal(commands.at(-1).body.operation, "recall");
  await delay(800);
  assert.equal(f.board.requests.at(-1).body.operation, "recall", "hold must not restart");
});

test("changing the board address cancels a preset that is still checking limits", async (t) => {
  const f = await setup(t);
  f.board.options.delayBoundsMs = 300;
  f.appear("preset");
  f.event("keyDown", "preset", "preset", { preset: 2 });
  await until(() => f.board.reads.includes("/api/v1/settings/device"), "preset preflight");
  f.global({ board: "http://127.0.0.1:1" });
  await delay(500);
  assert.deepEqual(f.board.requests, [], "must not recall a preset on the previous board");
});
async function until(check, description) {
  const end = Date.now() + 6000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out: ${description}`);
    await delay(15);
  }
}

async function setup(t, options = {}) {
  const { globalSettings = {} } = options;
  const language = Object.hasOwn(options, "language") ? options.language : "de";
  const board = await createMockBoard();
  const ws = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(ws, "listening");
  const connected = once(ws, "connection");
  const messages = [];
  let stderr = "";
  const child = spawn(process.execPath, ["bin/plugin.js", "-port", String(ws.address().port), "-pluginUUID", uuid,
    "-registerEvent", "registerPlugin", "-info", JSON.stringify({
      application: { version: "7.6.0", language, platform: "windows", platformVersion: "10" },
      plugin: { uuid, version: "1.1.1.0" },
      devices: [{ id: "deck", name: "Test Deck", type: 0, size: { columns: 5, rows: 3 } }],
      colors: {}, devicePixelRatio: 1,
    })], { cwd: resolve("de.pandaboards.pandadesk.sdPlugin"), stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "exit");
    child.kill();
    await exited;
    for (const client of ws.clients) client.terminate();
    await new Promise((done) => ws.close(done));
    await board.close();
    assert.equal(stderr, "", "plugin must run without runtime errors");
  });
  const [socket] = await Promise.race([
    connected,
    once(child, "exit").then(([code]) => { throw new Error(`Plugin exited ${code}: ${stderr}`); }),
  ]);
  const savedSettings = typeof globalSettings === "function" ? globalSettings(board) : globalSettings;
  const global = (settings) => socket.send(JSON.stringify({ event: "didReceiveGlobalSettings", payload: { settings } }));
  socket.on("message", (value) => {
    const message = JSON.parse(value.toString());
    messages.push(message);
    if (message.event === "getGlobalSettings") global(savedSettings);
  });
  await until(() => messages.some((m) => m.event === "registerPlugin"), "Stream Deck registration");
  const event = (name, kind, context, settings = {}) => socket.send(JSON.stringify({
    event: name, action: `${uuid}.${kind}`, context, device: "deck",
    payload: { controller: "Keypad", settings: { board: board.url, ...settings },
      isInMultiAction: false, coordinates: { column: 0, row: 0 }, resources: {}, state: 0 },
  }));
  return { board, messages, socket, child, event, global,
    appear: (kind, context = kind, settings = {}) => event("willAppear", kind, context, settings),
    commands: () => board.requests.map((r) => r.body.direction ?? r.body.height_cm),
  };
}

test("built plugin: hold repeats finite moves; release stops and cancels repetition", async (t) => {
  const f = await setup(t);
  f.appear("up");
  f.event("keyDown", "up", "up");
  await until(() => f.commands().length >= 2, "held-key repetition");
  f.event("keyUp", "up", "up");
  await until(() => f.commands().at(-1) === "stop", "release stop");
  const count = f.commands().length;
  await delay(900);
  assert.equal(f.commands().length, count);
  for (const { body } of f.board.requests) {
    assert.ok(body.request_id.length > 0 && body.request_id.length <= 64);
    if (body.direction === "stop") assert.equal(body.expires_ms, undefined);
    else assert.equal(body.expires_ms, 750);
  }
});

test("dedicated stop cancels another key's active hold", async (t) => {
  const f = await setup(t);
  f.appear("down"); f.appear("stop");
  f.event("keyDown", "down", "down");
  await until(() => f.commands().includes("down"), "down command");
  f.event("keyDown", "stop", "stop");
  await until(() => f.commands().at(-1) === "stop", "dedicated stop");
  const count = f.commands().length;
  await delay(900);
  assert.equal(f.commands().length, count);
});

test("release waits for an in-flight request; rapid release cannot restart movement", async (t) => {
  const f = await setup(t);
  f.board.options.delayMoveMs = 300;
  f.appear("up");
  f.event("keyDown", "up", "up");
  await until(() => f.commands().includes("up"), "delayed move");
  f.event("keyUp", "up", "up");
  await until(() => f.commands().at(-1) === "stop", "ordered stop");
  assert.deepEqual(f.commands(), ["up", "stop"]);
  await delay(800);
  assert.deepEqual(f.commands(), ["up", "stop"]);
  f.event("keyDown", "up", "up"); f.event("keyUp", "up", "up");
  await until(() => f.commands().length >= 3, "quick tap");
  await delay(800);
  assert.equal(f.commands().at(-1), "stop");
});

test("page disappearance and address edits stop the hold at the original board", async (t) => {
  const f = await setup(t);
  f.appear("up");
  f.event("keyDown", "up", "up");
  await until(() => f.commands().includes("up"), "move");
  f.global({ board: "http://127.0.0.1:1" });
  await until(() => f.commands().at(-1) === "stop", "stop old address");
  f.global({ board: f.board.url });
  f.event("keyDown", "up", "up");
  await until(() => f.commands().at(-1) === "up", "new hold");
  f.event("willDisappear", "up", "up");
  await until(() => f.commands().at(-1) === "stop", "page stop");
  const count = f.commands().length;
  await delay(800);
  assert.equal(f.commands().length, count);
});

test("device disconnect cancels a held movement", async (t) => {
  const f = await setup(t);
  f.appear("up");
  f.event("keyDown", "up", "up");
  await until(() => f.commands().includes("up"), "move");
  f.socket.send(JSON.stringify({ event: "deviceDidDisconnect", device: "deck" }));
  await until(() => f.commands().at(-1) === "stop", "device disconnect stop");
});

test("Stream Deck WebSocket disconnect stops holds and prevents further commands", async (t) => {
  const f = await setup(t);
  f.appear("up");
  f.event("keyDown", "up", "up");
  await until(() => f.commands().includes("up"), "move");
  f.socket.close();
  await until(() => f.commands().at(-1) === "stop", "connection-loss stop");
  const count = f.commands().length;
  await delay(900);
  assert.equal(f.commands().length, count);
});

test("target height accepts German decimals; invalid targets never reach the board", async (t) => {
  const f = await setup(t);
  f.appear("height", "sit", { height: "72,5" });
  f.event("keyDown", "height", "sit", { height: "72,5" });
  await until(() => f.commands().includes(72.5), "target command");
  for (const height of ["", "NaN", "72.55", -1, 201, null]) {
    f.event("keyDown", "height", "sit", { height });
  }
  await until(() => f.messages.filter((m) => m.event === "showAlert").length >= 6, "invalid target feedback");
  assert.deepEqual(f.commands(), [72.5]);
  f.board.options.targetSupported = false;
  f.event("keyDown", "height", "sit", { height: 110 });
  await until(() => f.messages.filter((m) => m.event === "showAlert").length >= 7, "unsupported profile feedback");
});

test("height readout, unconfigured board, unsupported target and offline feedback", async (t) => {
  const f = await setup(t);
  f.appear("status"); f.appear("height", "target", { height: 110 });
  await until(() => f.messages.some((m) => m.context === "status" && m.payload?.title === "72,0 cm"), "live height");
  f.board.options.targetSupported = false;
  await until(() => f.messages.some((m) => m.context === "target" && m.payload?.title === "Nicht\nunterstützt"), "capability feedback");
  f.board.options.invalidState = true;
  await until(() => f.messages.some((m) => m.context === "status" && m.payload?.title === "Offline"), "invalid response feedback");
  f.board.options.invalidState = false;
  await until(() => f.messages.filter((m) => m.context === "status" && m.payload?.title === "72,0 cm").length === 2, "reconnection");
  f.board.options.offline = true;
  await until(() => f.messages.filter((m) => m.context === "status" && m.payload?.title === "Offline").length === 2, "offline feedback");
});

test("one legacy address is migrated once and inherited by existing and new keys", async (t) => {
  const f = await setup(t);
  f.appear("stop", "stop", { board: "" });
  f.appear("up");
  await until(() => f.messages.some((m) => m.event === "setGlobalSettings"), "legacy migration");
  assert.deepEqual(f.messages.find((m) => m.event === "setGlobalSettings"), {
    event: "setGlobalSettings", context: uuid, payload: { board: f.board.url },
  });
  f.appear("height", "sit", { board: "http://127.0.0.1:1", height: 72.5 });
  f.event("keyDown", "height", "sit", { board: "", height: 72.5 });
  await until(() => f.commands().includes(72.5), "target uses shared address");
  f.event("keyDown", "up", "up", { board: "" });
  await until(() => f.commands().includes("up"), "hold uses shared address");
  f.event("keyDown", "stop", "stop", { board: "" });
  await until(() => f.commands().at(-1) === "stop", "unconfigured stop key uses shared address");
  assert.equal(f.messages.filter((m) => m.event === "setGlobalSettings").length, 1);
});

test("saved global address wins over stale key settings after a plugin restart", async (t) => {
  const first = await setup(t);
  first.appear("status");
  await until(() => first.messages.some((m) => m.event === "setGlobalSettings"), "persisted address");
  const saved = first.messages.find((m) => m.event === "setGlobalSettings").payload;
  const restarted = await setup(t, { globalSettings: saved });
  restarted.appear("height", "standing", { height: 110 });
  restarted.event("keyDown", "height", "standing", { height: 110 });
  await until(() => first.commands().includes(110), "restarted plugin uses persisted global address");
  assert.deepEqual(restarted.commands(), [], "stale per-key board must be ignored");
  assert.equal(restarted.messages.filter((m) => m.event === "setGlobalSettings").length, 0);
});

test("global address changes reach all keys and stale page settings cannot undo them", async (t) => {
  const f = await setup(t);
  const other = await createMockBoard();
  t.after(() => other.close());
  f.appear("height", "sit", { height: 72.5 });
  await until(() => f.messages.some((m) => m.event === "setGlobalSettings"), "migration");
  f.global({ board: other.url });
  f.appear("height", "stand", { height: 110 });
  f.event("keyDown", "height", "sit", { height: 72.5 });
  f.event("keyDown", "height", "stand", { height: 110 });
  await until(() => other.requests.length === 2, "both keys use the changed address");
  assert.deepEqual(other.requests.map((r) => r.body.height_cm), [72.5, 110]);
  assert.deepEqual(f.commands(), []);
});

test("without a global or legacy address every key requests setup", async (t) => {
  const f = await setup(t);
  f.appear("up", "up", { board: "" });
  f.appear("status", "status", { board: "" });
  await until(() => ["up", "status"].every((context) =>
    f.messages.some((m) => m.context === context && m.payload?.title === "Einrichten")), "setup titles");
  f.event("keyDown", "up", "up", { board: "" });
  await until(() => f.messages.some((m) => m.event === "showAlert"), "missing address alert");
  assert.deepEqual(f.commands(), []);
});

test("failed movement is stopped once and is never retried automatically", async (t) => {
  const f = await setup(t);
  f.board.options.failMove = true;
  f.appear("up");
  f.event("keyDown", "up", "up");
  await until(() => f.messages.some((m) => m.event === "showAlert"), "movement error feedback");
  await delay(800);
  assert.deepEqual(f.commands(), ["up", "stop"]);
});

test("unsupported height action is disabled and never posts a height command", async (t) => {
  const f = await setup(t);
  f.board.options.targetSupported = false;
  f.appear("height", "target", { height: 110 });
  await until(() => f.messages.some((m) => m.context === "target" && m.payload?.image === "imgs/unavailable.svg"), "disabled icon");
  f.event("keyDown", "height", "target", { height: 110 });
  await until(() => f.messages.some((m) => m.event === "showAlert"), "unsupported target alert");
  assert.deepEqual(f.commands(), []);
});

test("target presses validate current board limits before posting; STOP cancels a pending preflight", async (t) => {
  const f = await setup(t);
  f.board.options.minHeight = 80;
  f.board.options.maxHeight = 120;
  f.appear("height", "target", { height: 72 });
  f.event("keyDown", "height", "target", { height: 72 });
  await until(() => f.messages.some((m) => m.event === "showAlert"), "out-of-range target alert");
  assert.deepEqual(f.commands(), []);
  f.board.options.delayBoundsMs = 300;
  f.appear("stop");
  f.event("keyDown", "height", "target", { height: 110 });
  await until(() => f.board.reads.filter((p) => p === "/api/v1/settings/device").length === 2, "pending limits check");
  f.event("keyDown", "stop", "stop");
  await until(() => f.commands().at(-1) === "stop", "stop during preflight");
  assert.deepEqual(f.commands(), ["stop"]);
});

test("property inspector receives live capabilities and min/max through the plugin", async (t) => {
  const f = await setup(t);
  f.board.options.minHeight = 64.5;
  f.board.options.maxHeight = 118;
  f.socket.send(JSON.stringify({ event: "sendToPlugin", action: `${uuid}.height`, context: "inspector-key",
    payload: { type: "inspect", id: 17, board: f.board.url } }));
  await until(() => f.messages.some((m) => m.event === "sendToPropertyInspector" && m.payload.id === 17), "inspector reply");
  const reply = f.messages.find((m) => m.payload?.id === 17).payload;
  assert.deepEqual(reply.bounds, { min_height_cm: 64.5, max_height_cm: 118 });
  assert.equal(reply.capabilities.target_height, true);
  assert.equal(reply.capabilities.child_lock, true);
  f.board.options.invalidBounds = true;
  f.socket.send(JSON.stringify({ event: "sendToPlugin", action: `${uuid}.height`, context: "inspector-key",
    payload: { type: "inspect", id: 18, board: f.board.url } }));
  await until(() => f.messages.some((m) => m.payload?.id === 18), "invalid bounds reply");
  assert.match(f.messages.find((m) => m.payload?.id === 18).payload.boundsError, /Höhenbereich/);
});

test("lock/unlock and toggle use fresh state and render the confirmed controller state", async (t) => {
  const f = await setup(t);
  f.appear("childlock", "lock-key");
  await until(() => f.messages.some((m) => m.payload?.image === "imgs/unlocked.svg"), "initial unlocked icon");
  f.board.options.locked = true; // Handset changes state after the last plugin poll.
  f.event("keyDown", "childlock", "lock-key", { lockMode: "toggle" });
  await until(() => f.board.requests.some((r) => r.path.endsWith("child-lock")), "toggle command");
  assert.equal(f.board.requests.at(-1).body.locked, false);
  await delay(100);
  f.event("keyDown", "childlock", "lock-key", { lockMode: "lock" });
  await until(() => f.messages.some((m) => m.payload?.image === "imgs/locked.svg"), "confirmed locked icon");
  assert.equal(f.board.options.locked, true);
  f.event("keyDown", "childlock", "lock-key", { lockMode: "unlock" });
  await until(() => f.board.options.locked === false, "explicit unlock");
  assert.deepEqual(f.board.requests.filter((r) => r.path.endsWith("child-lock")).map((r) => r.body.locked), [false, true, false]);
});

test("unsupported or unknown lock state never guesses a toggle", async (t) => {
  const f = await setup(t);
  f.board.options.locked = null;
  f.appear("childlock");
  await until(() => f.messages.some((m) => m.payload?.image === "imgs/lock-unknown.svg"), "unknown state icon");
  f.event("keyDown", "childlock", "childlock");
  await until(() => f.messages.filter((m) => m.event === "showAlert").length === 1, "unknown state alert");
  f.board.options.childLockSupported = false;
  f.event("keyDown", "childlock", "childlock", { lockMode: "lock" });
  await until(() => f.messages.filter((m) => m.event === "showAlert").length === 2, "unsupported lock alert");
  assert.deepEqual(f.board.requests, []);
});

test("slow lock confirmation leaves STOP responsive, rejects duplicate toggles, and never flips the icon early", async (t) => {
  const f = await setup(t);
  f.board.options.delayLockMs = 1800;
  f.appear("childlock"); f.appear("stop");
  await until(() => f.messages.some((m) => m.payload?.image === "imgs/unlocked.svg"), "unlocked icon");
  f.event("keyDown", "childlock", "childlock", { lockMode: "toggle" });
  await until(() => f.board.requests.some((r) => r.path.endsWith("child-lock")), "pending lock");
  f.event("keyDown", "childlock", "childlock", { lockMode: "toggle" });
  f.event("keyDown", "stop", "stop");
  await until(() => f.commands().at(-1) === "stop", "responsive stop");
  assert.equal(f.board.options.locked, false);
  assert.equal(f.messages.some((m) => m.payload?.image === "imgs/locked.svg"), false);
  await until(() => f.messages.some((m) => m.payload?.image === "imgs/locked.svg"), "late confirmed lock");
  assert.equal(f.board.requests.filter((r) => r.path.endsWith("child-lock")).length, 1);
});

test("failed or mismatched lock confirmations never claim the requested state", async (t) => {
  const f = await setup(t);
  f.appear("childlock");
  f.board.options.failLock = true;
  f.event("keyDown", "childlock", "childlock", { lockMode: "lock" });
  await until(() => f.messages.filter((m) => m.event === "showAlert").length === 1, "unconfirmed lock alert");
  f.board.options.failLock = false;
  f.board.options.wrongLockConfirmation = true;
  f.event("keyDown", "childlock", "childlock", { lockMode: "lock" });
  await until(() => f.messages.filter((m) => m.event === "showAlert").length === 2, "mismatched confirmation alert");
  assert.equal(f.board.options.locked, false);
  assert.equal(f.messages.some((m) => m.payload?.image === "imgs/locked.svg"), false);
});

for (const language of ["en", "fr", "ja", undefined]) {
  test(`built plugin uses English titles and API errors for ${language ?? "missing language"}`, async (t) => {
    const f = await setup(t, { language });
    f.appear("status"); f.appear("childlock"); f.appear("height", "target", { height: 110 });
    await until(() => f.messages.some((m) => m.context === "status" && m.payload?.title === "72.0 cm"), "English decimal height");
    await until(() => f.messages.some((m) => m.payload?.title === "Unlocked"), "English child-lock state");
    f.board.options.targetSupported = false;
    await until(() => f.messages.some((m) => m.context === "target" && m.payload?.title === "Not\nsupported"), "English unsupported title");
    f.socket.send(JSON.stringify({ event: "sendToPlugin", action: `${uuid}.height`, context: "target",
      payload: { type: "inspect", id: 42, board: "http:///" } }));
    await until(() => f.messages.some((m) => m.payload?.id === 42), "English validation error");
    assert.equal(f.messages.find((m) => m.payload?.id === 42).payload.error,
      "Enter only the board address, e.g. http://pandadesk.local.");
  });
}
