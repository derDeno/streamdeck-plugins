/* Stream Deck invokes this entry point after loading the local inspector. */
const { formatNumber, setLanguage, t } = PandaDeskI18n;
let socket, actionInfo, inspectorContext, kind, globalSettings;
let settings = {};
let requestId = 0;
let inspectionRevision = 0;
let inspectTimer;
let saving = false;
const pending = new Map();
const form = document.querySelector("#settings");
const board = document.querySelector("#board");
const height = document.querySelector("#height");
const lockMode = document.querySelector("#lock-mode");
const preset = document.querySelector("#preset");
const functionStatus = document.querySelector("#function-status");
const range = document.querySelector("#height-range");
const feedback = document.querySelector("#feedback");
const save = document.querySelector("#save");
const cm = (value) => formatNumber(value);

function address() {
  const input = board.value.trim();
  let url;
  try { url = new URL(input.includes("://") ? input : `http://${input}`); }
  catch { throw new Error(t("Enter a board address without a path, e.g. http://pandadesk.local.")); }
  if (!input || !["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error(t("Enter a board address without a path, e.g. http://pandadesk.local."));
  }
  return url.origin;
}

function send(event, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error(t("No connection to Stream Deck."));
  socket.send(JSON.stringify({ event, context: inspectorContext, action: actionInfo.action, ...(payload ? { payload } : {}) }));
}

function showSettings(value) {
  settings = value;
  height.value = typeof value.height === "number" ? cm(value.height) : value.height ?? "";
  lockMode.value = value.lockMode ?? "toggle";
  preset.value = String(value.preset ?? 1);
}

function requestInfo(origin) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(t("The board query did not respond in time.")));
    }, 6500);
    pending.set(id, { resolve, reject, timer });
    try { send("sendToPlugin", { type: "inspect", id, board: origin }); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
}

function showInfo(info) {
  height.required = false;
  height.disabled = true;
  lockMode.disabled = true;
  preset.disabled = true;
  range.textContent = "";
  if (!info.state.ready) {
    functionStatus.textContent = t("The selected desk profile is not ready.");
  } else if (kind === "height") {
    if (!info.capabilities.target_height) {
      functionStatus.textContent = t("The selected desk model does not support target heights. This action is unavailable.");
    } else if (!info.bounds) {
      functionStatus.textContent = info.boundsError ?? t("The height range could not be verified.");
    } else {
      const { min_height_cm: min, max_height_cm: max } = info.bounds;
      height.disabled = false;
      height.required = true;
      height.min = String(min);
      height.max = String(max);
      range.textContent = t("Allowed height range: {min}–{max} cm.", { min: cm(min), max: cm(max) });
      functionStatus.textContent = info.state.locked === true ? t("Child lock active. Unlock before moving the desk.") : "";
    }
  } else if (kind === "preset") {
    preset.disabled = info.capabilities.presets !== true;
    if (preset.disabled) functionStatus.textContent = t("This desk profile does not support presets.");
    else {
      const saved = info.state.presets?.[Number(preset.value) - 1];
      functionStatus.textContent = info.state.locked === true ? t("Child lock active. Unlock before moving the desk.") :
        saved == null ? t("This preset has no readable saved height.") : t("Saved position: {height} cm.", { height: cm(saved) });
    }
  } else if (kind === "childlock") {
    lockMode.disabled = info.capabilities.child_lock !== true;
    functionStatus.textContent = t(lockMode.disabled ? "The selected desk model does not support a child lock. This action is unavailable." :
      info.state.locked === true ? "Current state: locked." : info.state.locked === false ? "Current state: unlocked." :
        "Lock state unknown. Toggle requires a known state.");
  }
}

async function inspectBoard() {
  if (!["height", "childlock", "preset"].includes(kind)) return;
  const revision = ++inspectionRevision;
  height.disabled = true;
  lockMode.disabled = true;
  preset.disabled = true;
  range.textContent = "";
  functionStatus.textContent = t("Checking desk capabilities …");
  try {
    const info = await requestInfo(address());
    if (revision === inspectionRevision) showInfo(info);
  } catch (error) {
    if (revision === inspectionRevision) functionStatus.textContent = t("Check failed: {error}", { error: error.message });
  }
}

window.connectElgatoStreamDeckSocket = (port, uuid, registerEvent, _info, info) => {
  document.documentElement.lang = setLanguage(JSON.parse(_info).application?.language);
  for (const [selector, text] of Object.entries({
    "#board-label": "Board address", "#height-label": "Target height in cm", "#lock-label": "Child lock",
    "#mode-toggle": "Toggle", "#mode-lock": "Lock", "#mode-unlock": "Unlock", "#save": "Save",
    "#preset-label": "Preset",
    "#footer": "The height display updates automatically. Leave Stream Deck's title field empty for dynamic values.",
  })) document.querySelector(selector).textContent = t(text);
  height.placeholder = formatNumber(72, 1);
  inspectorContext = uuid;
  actionInfo = JSON.parse(info);
  kind = actionInfo.action.split(".").at(-1);
  document.querySelector("#height-field").hidden = kind !== "height";
  document.querySelector("#lock-field").hidden = kind !== "childlock";
  document.querySelector("#preset-field").hidden = kind !== "preset";
  document.querySelector("#hint").textContent = {
    up: "Hold the key to move up. Release to stop.",
    down: "Hold the key to move down. Release to stop.",
    stop: "Stops the desk and cancels this plugin's repeated movement commands.",
    height: "Press to move to the target height. Add a separate Stop key.",
    status: "Shows height, movement, and availability. Press to refresh.",
    childlock: "The icon shows the confirmed lock state. Toggle reads the state on every press.",
    preset: "Press to recall the desk's saved position. Add a separate Stop key.",
  }[kind];
  document.querySelector("#hint").textContent = t(document.querySelector("#hint").textContent);
  showSettings(actionInfo.payload.settings);
  socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.onopen = () => {
    socket.send(JSON.stringify({ event: registerEvent, uuid }));
    send("getGlobalSettings");
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.event === "didReceiveSettings") showSettings(message.payload.settings);
    if (message.event === "didReceiveGlobalSettings") {
      globalSettings = message.payload.settings;
      board.value = globalSettings.board ?? settings.board ?? "";
      void inspectBoard();
    }
    if (message.event === "sendToPropertyInspector" && message.payload?.type === "boardInfo") {
      const response = message.payload;
      const waiter = pending.get(response.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        pending.delete(response.id);
        if (response.error) waiter.reject(new Error(response.error));
        else waiter.resolve(response);
      }
    }
  };
};

board.addEventListener("input", () => {
  inspectionRevision++;
  height.disabled = true;
  lockMode.disabled = true;
  preset.disabled = true;
  range.textContent = "";
  clearTimeout(inspectTimer);
  inspectTimer = setTimeout(() => void inspectBoard(), 350);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saving) return;
  saving = true;
  save.disabled = true;
  try {
    if (!globalSettings) throw new Error(t("Shared settings are still loading. Please wait."));
    const origin = address();
    const input = board.value, target = height.value, mode = lockMode.value;
    const slot = preset.value;
    const next = { ...settings };
    delete next.board;
    if (["height", "childlock", "preset"].includes(kind)) {
      const revision = ++inspectionRevision;
      const info = await requestInfo(origin);
      if (revision !== inspectionRevision || board.value !== input || height.value !== target || lockMode.value !== mode ||
          preset.value !== slot) {
        throw new Error(t("The inputs changed during verification. Please save again."));
      }
      showInfo(info);
      if (kind === "height" && info.capabilities.target_height) {
        if (!info.state.ready || !info.bounds) throw new Error(t("The height range could not be verified. Please try again."));
        const value = Number(String(target).trim().replace(",", "."));
        if (!String(target).trim() || !Number.isFinite(value) || value <= 0 || value > 200 ||
            Math.abs(value * 10 - Math.round(value * 10)) > 1e-7) {
          throw new Error(t("Enter a target height in cm with at most one decimal place."));
        }
        if (value < info.bounds.min_height_cm || value > info.bounds.max_height_cm) {
          throw new Error(t("The target height must be between {min} and {max} cm.", { min: cm(info.bounds.min_height_cm), max: cm(info.bounds.max_height_cm) }));
        }
        next.height = value;
      }
      if (kind === "childlock") {
        if (!["lock", "unlock", "toggle"].includes(mode)) throw new Error(t("Invalid child-lock action."));
        next.lockMode = mode;
      }
      if (kind === "preset") {
        if (!["1", "2", "3", "4"].includes(slot)) throw new Error(t("Select a preset from 1 to 4."));
        next.preset = Number(slot);
        delete next.presetMode;
      }
    }
    // The UI connection uses its registration UUID, which differs from the key's context.
    const shared = { ...globalSettings, board: origin };
    send("setGlobalSettings", shared);
    send("setSettings", next);
    globalSettings = shared;
    settings = next;
    feedback.className = "";
    feedback.textContent = t("Saved.");
  } catch (error) {
    feedback.className = "error";
    feedback.textContent = error.message;
  } finally {
    saving = false;
    save.disabled = false;
  }
});

preset.addEventListener("change", () => void inspectBoard());
