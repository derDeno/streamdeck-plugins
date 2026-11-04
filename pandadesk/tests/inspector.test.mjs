import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { setImmediate as settle } from "node:timers/promises";
import { test } from "node:test";

async function inspector(kind = "height", language, initialSettings = {}) {
  if (arguments.length < 2) language = "de";
  const elements = new Map(), messages = [];
  let info = { state: { ready: true, locked: false, presets: [72, 110, null, null] }, capabilities: { target_height: true, child_lock: true, presets: true },
    bounds: { min_height_cm: 60, max_height_cm: 125 } };
  class Socket {
    static OPEN = 1;
    readyState = 1;
    constructor() { Socket.instance = this; }
    send(value) {
      const message = JSON.parse(value);
      messages.push(message);
      if (message.event === "sendToPlugin") queueMicrotask(() => this.onmessage({ data: JSON.stringify({
        event: "sendToPropertyInspector", payload: { type: "boardInfo", id: message.payload.id, ...info },
      }) }));
    }
  }
  const document = { documentElement: { lang: "en" }, querySelector: (selector) => {
    if (!elements.has(selector)) elements.set(selector, {
      value: "", hidden: false, required: false, listeners: {},
      addEventListener(name, handler) { this.listeners[name] = handler; },
    });
    return elements.get(selector);
  } };
  const window = {};
  const script = await readFile("de.pandaboards.pandadesk.sdPlugin/ui/settings.js", "utf8");
  const translations = await readFile("de.pandaboards.pandadesk.sdPlugin/ui/i18n.js", "utf8");
  runInNewContext(translations + "\n" + script, { window, document, WebSocket: Socket, URL, setTimeout, clearTimeout });
  window.connectElgatoStreamDeckSocket("1234", "inspector-id", "registerPropertyInspector", JSON.stringify({ application: { language } }), JSON.stringify({
    action: `de.pandaboards.pandadesk.${kind}`, context: "different-key-id",
    payload: { settings: { custom: "keep", board: "http://old.local", height: 80, ...initialSettings } },
  }));
  Socket.instance.onopen();
  const receive = async (settings) => {
    Socket.instance.onmessage({ data: JSON.stringify({ event: "didReceiveGlobalSettings", payload: { settings } }) });
    await settle();
  };
  return { elements, messages, document, receive, setInfo: (value) => { info = value; },
    submit: () => elements.get("#settings").listeners.submit({ preventDefault() {} }),
    writes: () => messages.filter((m) => m.event === "setSettings" || m.event === "setGlobalSettings"),
  };
}

test("preset slots persist per key and show the reported height without a save mode", async () => {
  const f = await inspector("preset");
  await f.receive({ board: "http://shared.local" });
  assert.equal(f.elements.get("#preset-field").hidden, false);
  assert.equal(f.elements.get("#height-field").hidden, true);
  assert.equal(f.elements.get("#preset").disabled, false);
  assert.match(f.elements.get("#function-status").textContent, /72/);
  for (const slot of [1, 2, 3, 4]) {
    f.elements.get("#preset").value = String(slot);
    await f.submit();
    assert.equal(f.writes().at(-1).payload.preset, slot);
    assert.equal(f.writes().at(-1).payload.presetMode, undefined);
  }
  assert.equal(f.elements.has("#preset-mode"), false);
  const html = await readFile("de.pandaboards.pandadesk.sdPlugin/ui/settings.html", "utf8");
  assert.doesNotMatch(html, /preset-mode|preset-save/);
  f.setInfo({ state: { ready: true }, capabilities: { presets: false } });
  await f.receive({ board: "http://shared.local" });
  assert.equal(f.elements.get("#preset").disabled, true);
  assert.match(f.elements.get("#function-status").textContent, /unterstützt keine Presets/);
  const count = f.writes().length;
  f.elements.get("#preset").value = "5";
  await f.submit();
  assert.equal(f.writes().length, count);
});

test("resaving an old save key explicitly reconfigures it as a recall key", async () => {
  const f = await inspector("preset", "de", { preset: 2, presetMode: "save" });
  await f.receive({ board: "http://shared.local" });
  assert.equal(f.elements.get("#preset").value, "2");
  await f.submit();
  const settings = f.writes().at(-1).payload;
  assert.equal(settings.preset, 2);
  assert.equal(settings.presetMode, undefined);
  assert.equal(settings.custom, "keep");
});

test("inspector shares the board globally, checks live bounds, and keeps target heights per key", async () => {
  const f = await inspector();
  assert.deepEqual(f.messages[0], { event: "registerPropertyInspector", uuid: "inspector-id" });
  assert.equal(f.messages[1].event, "getGlobalSettings");
  assert.equal(f.messages[1].context, "inspector-id");
  await f.receive({ board: "http://shared.local", customGlobal: "keep global" });
  assert.equal(f.elements.get("#board").value, "http://shared.local");
  assert.equal(f.elements.get("#height").value, "80");
  assert.equal(f.elements.get("#height-range").textContent, "Erlaubter Höhenbereich: 60–125 cm.");
  assert.equal(f.elements.get("#height").disabled, false);
  f.elements.get("#board").value = "127.0.0.1:18787";
  f.elements.get("#height").value = "72,5";
  await f.submit();
  assert.deepEqual(f.writes(), [{
    event: "setGlobalSettings", action: "de.pandaboards.pandadesk.height", context: "inspector-id",
    payload: { customGlobal: "keep global", board: "http://127.0.0.1:18787" },
  }, {
    event: "setSettings", action: "de.pandaboards.pandadesk.height", context: "inspector-id",
    payload: { custom: "keep", height: 72.5 },
  }]);
  for (const invalid of ["", "NaN", "72.55", "201", "59.9", "125.1"]) {
    f.elements.get("#height").value = invalid;
    await f.submit();
  }
  assert.equal(f.writes().length, 2, "invalid targets must not overwrite persisted settings");
  assert.equal(f.elements.get("#feedback").className, "error");
  await f.receive({ board: "http://changed-elsewhere.local" });
  assert.equal(f.elements.get("#board").value, "http://changed-elsewhere.local");
  assert.equal(f.elements.get("#height").value, "125.1", "shared updates must not overwrite this key's target");
});

test("saving rechecks changed limits; unavailable limits block saving a target", async () => {
  const f = await inspector();
  await f.receive({ board: "http://shared.local" });
  f.elements.get("#height").value = "72.5";
  f.setInfo({ state: { ready: true }, capabilities: { target_height: true }, bounds: { min_height_cm: 80, max_height_cm: 120 } });
  await f.submit();
  assert.equal(f.writes().length, 0);
  assert.match(f.elements.get("#feedback").textContent, /80.*120/);
  assert.equal(f.elements.get("#height-range").textContent, "Erlaubter Höhenbereich: 80–120 cm.");
  f.setInfo({ state: { ready: true }, capabilities: { target_height: true }, boundsError: "Keine Grenzen" });
  await f.submit();
  assert.equal(f.writes().length, 0);
  assert.equal(f.elements.get("#height").disabled, true);
});

test("editing a target during an API check prevents saving stale input", async () => {
  const f = await inspector();
  await f.receive({ board: "http://shared.local" });
  f.elements.get("#height").value = "72.5";
  const saving = f.submit();
  f.elements.get("#height").value = "110";
  await saving;
  assert.equal(f.writes().length, 0);
  assert.match(f.elements.get("#feedback").textContent, /erneut speichern/);
});

test("unsupported target height is visibly disabled while the shared address remains configurable", async () => {
  const f = await inspector();
  f.setInfo({ state: { ready: true }, capabilities: { target_height: false } });
  await f.receive({ board: "http://shared.local" });
  assert.equal(f.elements.get("#height").disabled, true);
  assert.equal(f.elements.get("#height").required, false);
  assert.match(f.elements.get("#function-status").textContent, /unterstützt keine Zielhöhe/);
  await f.submit();
  assert.equal(f.writes().find((m) => m.event === "setSettings").payload.height, 80);
});

test("child-lock modes are stored per key and show controller support and current state", async () => {
  const f = await inspector("childlock");
  await f.receive({ board: "http://shared.local" });
  assert.equal(f.elements.get("#lock-field").hidden, false);
  assert.equal(f.elements.get("#height-field").hidden, true);
  assert.match(f.elements.get("#function-status").textContent, /entsperrt/);
  for (const mode of ["lock", "unlock", "toggle"]) {
    f.elements.get("#lock-mode").value = mode;
    await f.submit();
    assert.equal(f.writes().at(-1).payload.lockMode, mode);
  }
  f.setInfo({ state: { ready: true }, capabilities: { child_lock: false } });
  await f.receive({ board: "http://shared.local" });
  assert.equal(f.elements.get("#lock-mode").disabled, true);
  assert.match(f.elements.get("#function-status").textContent, /unterstützt keine Kindersicherung/);
});

for (const language of ["en", "fr", "ja", undefined]) {
  test(`inspector uses English labels, ranges and validation for ${language ?? "missing language"}`, async () => {
    const f = await inspector("height", language);
    f.setInfo({ state: { ready: true }, capabilities: { target_height: true },
      bounds: { min_height_cm: 60.5, max_height_cm: 125.5 } });
    await f.receive({ board: "http://shared.local" });
    assert.equal(f.document.documentElement.lang, "en");
    assert.equal(f.elements.get("#board-label").textContent, "Board address");
    assert.equal(f.elements.get("#height-label").textContent, "Target height in cm");
    assert.equal(f.elements.get("#save").textContent, "Save");
    assert.equal(f.elements.get("#height").placeholder, "72.0");
    assert.equal(f.elements.get("#height-range").textContent, "Allowed height range: 60.5–125.5 cm.");
    f.elements.get("#height").value = "130";
    await f.submit();
    assert.equal(f.elements.get("#feedback").textContent, "The target height must be between 60.5 and 125.5 cm.");
    assert.equal(f.writes().length, 0);
    f.elements.get("#height").value = "72,5";
    await f.submit();
    assert.equal(f.elements.get("#feedback").textContent, "Saved.");
    assert.equal(f.writes().at(-1).payload.height, 72.5);
    const lock = await inspector("childlock", language);
    await lock.receive({ board: "http://shared.local" });
    assert.equal(lock.elements.get("#lock-label").textContent, "Child lock");
    assert.equal(lock.elements.get("#mode-lock").textContent, "Lock");
    assert.equal(lock.elements.get("#function-status").textContent, "Current state: unlocked.");
  });
}

test("German inspector labels and decimal ranges follow the Stream Deck language", async () => {
  const f = await inspector("height", "de-DE");
  f.setInfo({ state: { ready: true }, capabilities: { target_height: true },
    bounds: { min_height_cm: 60.5, max_height_cm: 125.5 } });
  await f.receive({ board: "http://shared.local" });
  assert.equal(f.document.documentElement.lang, "de");
  assert.equal(f.elements.get("#board-label").textContent, "Board-Adresse");
  assert.equal(f.elements.get("#save").textContent, "Speichern");
  assert.equal(f.elements.get("#height").placeholder, "72,0");
  assert.equal(f.elements.get("#height-range").textContent, "Erlaubter Höhenbereich: 60,5–125,5 cm.");
});
