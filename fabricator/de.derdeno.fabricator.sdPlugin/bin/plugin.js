import { Panel, PanelError, panelAddress, serverPath } from "./panel.js";

const pluginId = "de.derdeno.fabricator";
const finite = (value) => Number.isFinite(value) && value >= 0;
const metrics = {
  players: ({ status, runtime }) => {
    if (status === "stopped") return "0";
    const online = runtime?.players?.online;
    return finite(online) ? String(online) : "--";
  },
  uptime: ({ runtime }) => runtime?.uptime ?? "--",
  tps: ({ runtime }) => finite(runtime?.tps) ? `${Number(runtime.tps.toFixed(1))} TPS` : "--",
  state: ({ status }) => typeof status === "string" && status ? status[0].toUpperCase() + status.slice(1) : "--",
  cpu: ({ runtime }) => finite(runtime?.cpu) ? `${Number(runtime.cpu.toFixed(1))}%` : "--",
  heap: ({ runtime }) => {
    const bytes = runtime?.ram?.heapUsedBytes;
    if (!finite(bytes)) return "--";
    const mib = bytes / 1024 ** 2;
    return mib < 1024 ? `${Math.round(mib)} MiB` : `${(mib / 1024).toFixed(1)} GiB`;
  },
};

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const port = Number(args.get("-port"));
const uuid = args.get("-pluginUUID");
const registerEvent = args.get("-registerEvent");
if (!Number.isInteger(port) || port < 1 || port > 65535 || !uuid || !registerEvent) {
  throw new Error("Launch Fabricator through the Stream Deck app.");
}

const socket = new WebSocket(`ws://127.0.0.1:${port}`);
const visible = new Map();
const pendingActions = new Set();
let configuration;
let pollTimer;
let polling = false;
let pollAgain = false;

function send(event, context, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event, context, payload }));
}

function setTitle(key, value) {
  if (visible.get(key.context) !== key || key.title === value) return;
  send("setTitle", key.context, { title: value, target: 0 });
  key.title = value;
}

function setStateIcon(key, status) {
  if (key.kind !== "state" || visible.get(key.context) !== key) return;
  const image = status === "running" || status === "stopped" ? `imgs/state-${status}.png` : undefined;
  if (key.image === image) return;
  send("setImage", key.context, { image, target: 0 });
  key.image = image;
}

function schedulePoll(delay = 50) {
  clearTimeout(pollTimer);
  if (socket.readyState !== WebSocket.OPEN || visible.size === 0) return;
  if (polling) pollAgain = true;
  else pollTimer = setTimeout(poll, delay);
}

async function poll() {
  const current = configuration;
  const keys = [...visible.values()];
  polling = true;
  try {
    if (!current?.panel) throw new PanelError("Select a Fabricator server.", "Set up");
    const server = await current.panel.read(current.serverId, keys.some((key) => key.kind === "heap"));
    if (current === configuration) {
      for (const key of keys) {
        setTitle(key, metrics[key.kind](server));
        setStateIcon(key, server.status);
      }
    }
  } catch (error) {
    if (current === configuration) {
      const title = error instanceof PanelError ? error.title : "Unavailable";
      for (const key of keys) {
        setTitle(key, title);
        setStateIcon(key);
      }
    }
  } finally {
    polling = false;
    const delay = pollAgain ? 50 : 5000;
    pollAgain = false;
    schedulePoll(delay);
  }
}

function updateConfiguration({ address, password, serverId } = {}) {
  if (configuration && address === configuration.address && password === configuration.password &&
    serverId === configuration.serverId) return;
  configuration?.controller.abort();
  const controller = new AbortController();
  let panel;
  try {
    serverPath(serverId);
    panel = new Panel(address, password, controller.signal);
  } catch { /* The keys prompt for setup until both fields are valid. */ }
  configuration = { address, password, serverId, panel, controller };
  for (const key of visible.values()) {
    setTitle(key, panel ? "Connecting" : "Set up");
    setStateIcon(key);
  }
  schedulePoll();
}

async function handle({ event, context, action, device, payload }) {
  if (event === "didReceiveGlobalSettings") {
    updateConfiguration(payload?.settings);
    return;
  }
  if (event === "deviceDidDisconnect") {
    for (const [id, key] of visible) if (key.device === device) visible.delete(id);
    if (visible.size === 0) clearTimeout(pollTimer);
    return;
  }
  if (!context || !action?.startsWith(`${pluginId}.`)) return;
  const kind = action.slice(pluginId.length + 1);

  if (event === "sendToPlugin" && payload?.type === "listServers" && typeof payload.id === "string") {
    const { id, address, password } = payload;
    try {
      const servers = await new Panel(address, password).servers();
      send("sendToPropertyInspector", context, { type: "serverList", id, servers });
    } catch (error) {
      const message = error instanceof PanelError ? error.message : "Could not load Fabricator servers.";
      send("sendToPropertyInspector", context, { type: "serverList", id, error: message });
    }
    return;
  }

  if (Object.hasOwn(metrics, kind)) {
    if (event === "willAppear") {
      const key = { context, kind, device };
      visible.set(context, key);
      setTitle(key, configuration?.panel ? "Connecting" : "Set up");
      if (kind === "state") send("setImage", context, { target: 0 });
      schedulePoll();
    } else if (event === "willDisappear") {
      visible.delete(context);
      if (visible.size === 0) clearTimeout(pollTimer);
    } else if (event === "keyDown") schedulePoll();
    return;
  }

  if (event !== "keyDown") return;
  if (kind === "admin") {
    const origin = panelAddress(configuration?.address);
    const id = configuration?.serverId;
    const path = configuration?.panel ? `/server/${id}/overview` : "/";
    send("openUrl", undefined, { url: origin + path });
    return;
  }
  if (!["start", "stop", "restart", "console"].includes(kind)) return;

  const current = configuration;
  if (!current?.panel) throw new PanelError("Select a Fabricator server.", "Set up");
  const target = `${current.panel.address}${serverPath(current.serverId)}`;
  if (pendingActions.has(target)) throw new PanelError("A Fabricator action is already in progress.");
  pendingActions.add(target);
  if (kind !== "console") send("setTitle", context, { title: "Working", target: 0 });
  try {
    await current.panel.run(current.serverId, kind, payload?.settings?.command);
    if (current === configuration) send("showOk", context);
  } finally {
    pendingActions.delete(target);
    if (kind !== "console") send("setTitle", context, { target: 0 });
    schedulePoll();
  }
}

socket.onopen = () => {
  socket.send(JSON.stringify({ event: registerEvent, uuid }));
  send("getGlobalSettings", uuid);
};
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  void handle(message).catch((error) => {
    if (error?.name === "AbortError") return;
    send("showAlert", message.context);
    const detail = error instanceof PanelError ? error.message : "Unexpected Fabricator plugin error.";
    send("logMessage", undefined, { message: detail });
  });
};
socket.onclose = () => {
  configuration?.controller.abort();
  clearTimeout(pollTimer);
  process.exit();
};
