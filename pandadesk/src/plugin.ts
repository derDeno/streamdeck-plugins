import { appendFileSync, mkdirSync } from "node:fs";
import { boardAddress, presetSlot, readDesk, readHeightBounds, setChildLock, targetHeight } from "./board.js";
import { Motion } from "./motion.js";
import { formatNumber, setLanguage, t } from "./i18n.js";

type Kind = "up" | "down" | "stop" | "height" | "status" | "childlock" | "preset";
type Settings = { board?: string; height?: string | number; lockMode?: "lock" | "unlock" | "toggle"; preset?: number; presetMode?: "recall" | "save" };
type GlobalSettings = { board?: string; [key: string]: unknown };
type Visible = { context: string; device: string; settings: Settings; kind: Kind; title?: string; image?: string };
type DeckEvent = {
  event: string; context?: string; action?: string; device?: string;
  payload?: { settings?: Settings & GlobalSettings; isInMultiAction?: boolean; type?: string; id?: number; board?: string };
};
const uuid = "de.pandaboards.pandadesk";
const labels: Record<Kind, string> = { up: "Up", down: "Down", stop: "Stop", height: "Target height", status: "Height", childlock: "Child lock", preset: "Preset" };
const visible = new Map<string, Visible>();
const motion = new Motion();
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
setLanguage((JSON.parse(args.get("-info") ?? "{}") as { application?: { language?: string } }).application?.language);
const port = Number(args.get("-port"));
if (!Number.isInteger(port) || port < 1 || port > 65535 || !args.get("-pluginUUID") || !args.get("-registerEvent")) {
  throw new Error(t("Launch this plugin through Stream Deck, not directly with node."));
}

// Use Node's WebSocket directly so loss of the Stream Deck connection can stop holds.
const socket = new WebSocket(`ws://127.0.0.1:${port}`);
let closing = false;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let refreshing: Promise<void> | undefined;
let globalSettings: GlobalSettings | undefined;
let boardRevision = 0;
let boardChange: Promise<void> | undefined;
let lockBusy = false;

function log(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    mkdirSync("logs", { recursive: true });
    appendFileSync("logs/plugin.log", `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch { console.error(message); }
}

function send(event: string, context: string, payload?: object): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event, context, ...(payload ? { payload } : {}) }));
}

function title(entry: Visible, value: string): void {
  if (visible.get(entry.context) !== entry || entry.title === value) return;
  send("setTitle", entry.context, { title: value, target: 0 });
  entry.title = value;
}

function keyImage(entry: Visible, path: string): void {
  if (visible.get(entry.context) !== entry || entry.image === path) return;
  send("setImage", entry.context, { image: path, target: 0 });
  entry.image = path;
}

function report(context: string, error: unknown): void {
  log(error);
  send("showAlert", context);
}

function applyGlobalSettings(settings: GlobalSettings): void {
  if (settings.board !== globalSettings?.board) {
    // Invalidate held commands immediately; never replay a key press after an address change.
    if (motion.isHolding) {
      const change = motion.stopAll().catch(log).finally(() => {
        if (boardChange === change) boardChange = undefined;
      });
      boardChange = change;
    }
    boardRevision++;
  }
  globalSettings = settings;
}

function migrateBoardAddress(): void {
  if (!globalSettings || globalSettings.board) return;
  for (const entry of visible.values()) {
    try {
      const board = boardAddress(entry.settings.board);
      applyGlobalSettings({ ...globalSettings, board });
      send("setGlobalSettings", args.get("-pluginUUID")!, globalSettings);
      return;
    } catch { /* Skip unconfigured legacy keys. */ }
  }
}

async function refreshBoards(): Promise<void> {
  const revision = boardRevision;
  const boards = new Map<string, Visible[]>();
  for (const entry of visible.values()) {
    try {
      const board = boardAddress(globalSettings?.board);
      const entries = boards.get(board) ?? [];
      entries.push(entry);
      boards.set(board, entries);
    } catch { title(entry, t("Set up")); }
  }
  await Promise.all([...boards].map(async ([board, entries]) => {
    try {
      const { state, capabilities } = await readDesk(board);
      if (revision !== boardRevision) return;
      for (const entry of entries) {
        let value = t(labels[entry.kind]);
        if (!state.ready) {
          value = t("Not\nready");
          if (["height", "childlock", "preset"].includes(entry.kind)) keyImage(entry, "imgs/unavailable.svg");
        }
        else if (entry.kind === "height") {
          keyImage(entry, capabilities.target_height ? "imgs/height.svg" : "imgs/unavailable.svg");
          if (!capabilities.target_height) value = t("Not\nsupported");
          else {
            try { value = `${formatNumber(targetHeight(entry.settings.height), 1)} cm`; }
            catch { value = t("Enter\ntarget"); }
          }
        } else if (entry.kind === "preset") {
          const supported = capabilities.presets === true;
          keyImage(entry, supported ? "imgs/preset.svg" : "imgs/unavailable.svg");
          if (!supported) value = t("Not\nsupported");
          else {
            try {
              if (entry.settings.presetMode !== undefined && entry.settings.presetMode !== "recall") throw new Error(t("Invalid preset action."));
              const slot = presetSlot(entry.settings.preset === undefined ? 1 : entry.settings.preset);
              const saved = state.presets?.[slot - 1];
              value = `${t("Preset")} ${slot}\n${saved == null ? "— cm" : `${formatNumber(saved, 1)} cm`}`;
            } catch { value = t("Select\npreset"); }
          }
        } else if (entry.kind === "childlock") {
          const supported = capabilities.child_lock === true;
          keyImage(entry, !supported ? "imgs/unavailable.svg" : state.locked === true ? "imgs/locked.svg" :
            state.locked === false ? "imgs/unlocked.svg" : "imgs/lock-unknown.svg");
          value = t(!supported ? "Not\nsupported" : lockBusy ? "Please\nwait" : state.locked === true ? "Locked" :
            state.locked === false ? "Unlocked" : "State\nunknown");
        } else if (entry.kind === "status") {
          value = state.height.value === null ? "— cm" : `${formatNumber(state.height.value, 1)} cm`;
          if (state.moving === true) value += `\n${t("moving")}`;
        } else if (!(entry.kind === "stop" ? capabilities.stop : capabilities.move)) value = t("Not\navailable");
        title(entry, value);
      }
    } catch {
      if (revision === boardRevision) for (const entry of entries) {
        title(entry, t("Offline"));
        if (["height", "childlock", "preset"].includes(entry.kind)) keyImage(entry, "imgs/unavailable.svg");
      }
    }
  }));
}

function refresh(): Promise<void> {
  return refreshing ??= refreshBoards().finally(() => { refreshing = undefined; });
}

async function handle(ev: DeckEvent): Promise<void> {
  if (closing) return;
  if (ev.event === "sendToPlugin" && ev.context && ev.action?.startsWith(`${uuid}.`) && ev.payload?.type === "inspect") {
    const { id } = ev.payload;
    if (!Number.isInteger(id)) return;
    try {
      const board = boardAddress(ev.payload.board);
      const info = await readDesk(board);
      let bounds, boundsError;
      if (info.capabilities.target_height || info.capabilities.presets) {
        try { bounds = await readHeightBounds(board); }
        catch (error) { boundsError = error instanceof Error ? error.message : String(error); }
      }
      send("sendToPropertyInspector", ev.context, { type: "boardInfo", id, board, ...info, bounds, boundsError });
    } catch (error) {
      send("sendToPropertyInspector", ev.context, { type: "boardInfo", id, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (ev.event === "didReceiveGlobalSettings") {
    applyGlobalSettings(ev.payload?.settings ?? {});
    migrateBoardAddress();
    return;
  }
  if (ev.event === "deviceDidDisconnect") {
    for (const [context, entry] of visible) {
      if (entry.device === ev.device) {
        visible.delete(context);
        void motion.release(context).catch(log);
      }
    }
    return;
  }
  const { context, device, payload } = ev;
  const kind = ev.action?.startsWith(`${uuid}.`) ? ev.action.slice(uuid.length + 1) as Kind : undefined;
  if (!context || !device || !kind || !Object.hasOwn(labels, kind)) return;
  const settings = payload?.settings ?? {};
  if (ev.event === "willAppear") {
    visible.set(context, { context, device, settings, kind });
    title(visible.get(context)!, t(labels[kind]));
    migrateBoardAddress();
  }
  else if (ev.event === "didReceiveSettings") {
    const stopped = motion.release(context);
    if (visible.has(context)) visible.set(context, { context, device, settings, kind });
    await stopped;
  } else if (ev.event === "willDisappear") {
    visible.delete(context);
    await motion.release(context);
  } else if (ev.event === "keyUp" && (kind === "up" || kind === "down")) {
    await motion.release(context);
  } else if (ev.event === "keyDown") {
    if (boardChange) throw new Error(t("The board address is being updated. Press the key again."));
    const board = boardAddress(globalSettings?.board);
    if (lockBusy && kind !== "stop" && kind !== "status") throw new Error(t("The child lock is being updated. Press the key again."));
    if (kind === "up" || kind === "down") {
      if (payload?.isInMultiAction) throw new Error(t("Up/Down requires a separate key to hold down."));
      motion.start(board, context, kind, (error) => report(context, error));
    } else if (kind === "stop") await motion.stop(board);
    else if (kind === "height") await motion.height(board, targetHeight(settings.height));
    else if (kind === "preset") {
      // Old save keys must be reconfigured before they can start a movement.
      if (settings.presetMode !== undefined && settings.presetMode !== "recall") throw new Error(t("Invalid preset action."));
      const revision = boardRevision;
      await motion.preset(board, presetSlot(settings.preset === undefined ? 1 : settings.preset),
        () => !closing && revision === boardRevision);
    }
    else if (kind === "childlock") {
      lockBusy = true;
      const revision = boardRevision;
      try {
        const { state, capabilities } = await readDesk(board);
        if (!capabilities.child_lock) throw new Error(t("This desk profile does not support a child lock."));
        const mode = settings.lockMode ?? "toggle";
        if (!["lock", "unlock", "toggle"].includes(mode)) throw new Error(t("Invalid child-lock action."));
        if (mode === "toggle" && typeof state.locked !== "boolean") throw new Error(t("The lock state is unknown. Toggle is unavailable."));
        await motion.stopAll();
        if (closing || revision !== boardRevision) return;
        await setChildLock(board, mode === "toggle" ? !state.locked : mode === "lock");
      } finally {
        lockBusy = false;
        if (refreshing) await refreshing;
        await refresh(); // Fetch after any poll that started before the confirmation.
      }
    }
    else await refresh();
  }
}

async function poll(): Promise<void> {
  try { await refresh(); }
  catch (error) { log(error); }
  if (!closing) pollTimer = setTimeout(() => void poll(), 1000);
}

async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  clearTimeout(pollTimer);
  visible.clear();
  await motion.stopAll().catch(log);
  socket.close();
}

socket.addEventListener("open", () => {
  socket.send(JSON.stringify({ event: args.get("-registerEvent"), uuid: args.get("-pluginUUID") }));
  send("getGlobalSettings", args.get("-pluginUUID")!);
  void poll();
});
socket.addEventListener("message", (ev) => {
  try {
    const message = JSON.parse(String(ev.data)) as DeckEvent;
    void handle(message).catch((error: unknown) => report(message.context ?? "", error));
  } catch (error) { log(error); }
});
socket.addEventListener("close", () => void shutdown());
socket.addEventListener("error", () => { log(t("Connection to Stream Deck was lost.")); void shutdown(); });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void shutdown());
