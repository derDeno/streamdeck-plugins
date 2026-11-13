const form = document.querySelector("#settings");
const fields = document.querySelector("#fields");
const serverSettings = document.querySelector("#server-settings");
const address = document.querySelector("#address");
const password = document.querySelector("#password");
const load = document.querySelector("#load");
const picker = document.querySelector("#server-picker");
const servers = document.querySelector("#servers");
const serverId = document.querySelector("#server-id");
const commandField = document.querySelector("#command-field");
const command = document.querySelector("#command");
const feedback = document.querySelector("#feedback");
let send;
let shared = {};
let pending;

function status(message, error = false) {
  feedback.textContent = message;
  feedback.classList.toggle("error", error);
}

function finishLookup() {
  clearTimeout(pending?.timer);
  pending = undefined;
  load.disabled = false;
}

function hasValidAddress() {
  const value = address.value.trim();
  const hasScheme = /^https?:\/\//i.test(value);
  return /^(?:https?:\/\/)?(?:\[[\da-f:.]+\]|[^:/\\@?#\s]+)(?::\d+)?\/?$/i.test(value) &&
    URL.canParse(hasScheme ? value : `http://${value}`);
}

function validAddress() {
  address.setCustomValidity(hasValidAddress() ? "" : "Enter the Fabricator panel address, including its port if needed.");
  return address.reportValidity();
}

window.connectElgatoStreamDeckSocket = (port, uuid, registerEvent, _info, actionInfo) => {
  const info = JSON.parse(actionInfo);
  commandField.hidden = !info.action.endsWith(".console");
  command.value = info.payload?.settings?.command ?? "";
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  send = (event, payload) => socket.send(JSON.stringify({ event, context: uuid, action: info.action, payload }));
  socket.onopen = () => {
    socket.send(JSON.stringify({ event: registerEvent, uuid }));
    send("getGlobalSettings");
  };
  socket.onclose = () => {
    finishLookup();
    fields.disabled = true;
    status("Disconnected from Stream Deck.", true);
  };
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.event === "didReceiveGlobalSettings") {
      const firstLoad = fields.disabled;
      shared = message.payload.settings;
      address.value = shared.address ?? "";
      password.value = shared.password ?? "";
      serverId.value = shared.serverId ?? "";
      address.setCustomValidity("");
      fields.disabled = false;
      if (firstLoad) serverSettings.open = !hasValidAddress() || !serverId.validity.valid;
    }
    const result = message.payload;
    if (message.event !== "sendToPropertyInspector" || result?.type !== "serverList" || result.id !== pending?.id) return;
    finishLookup();
    if (result.error) {
      status(result.error, true);
      return;
    }
    servers.replaceChildren(new Option("Select a server", ""));
    for (const { name, id } of result.servers) {
      servers.add(new Option(name === id ? id : `${name} (${id})`, id));
    }
    servers.value = result.servers.some(({ id }) => id === serverId.value.trim()) ? serverId.value.trim() : "";
    picker.hidden = result.servers.length === 0;
    status(picker.hidden ? "Fabricator returned no servers." : "Select a server and save.");
  };
};

address.addEventListener("input", () => {
  address.setCustomValidity("");
  if (serverId.value === shared.serverId && address.value.trim() !== shared.address) serverId.value = "";
});
for (const field of [address, password]) {
  field.addEventListener("input", () => {
    finishLookup();
    picker.hidden = true;
    status("");
  });
}
servers.addEventListener("change", () => { serverId.value = servers.value; });
serverId.addEventListener("input", () => {
  servers.value = [...servers.options].some(({ value }) => value === serverId.value.trim()) ? serverId.value.trim() : "";
});

load.addEventListener("click", () => {
  if (!validAddress()) return;
  const id = `${Date.now()}-${Math.random()}`;
  pending = { id, timer: setTimeout(() => {
    finishLookup();
    status("The server lookup timed out.", true);
  }, 26000) };
  load.disabled = true;
  picker.hidden = true;
  status("Loading servers…");
  send("sendToPlugin", { type: "listServers", id, address: address.value.trim(), password: password.value });
});

form.addEventListener("invalid", () => { serverSettings.open = true; }, true);
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!validAddress()) return;
  const next = { address: address.value.trim(), password: password.value, serverId: serverId.value.trim() };
  if (Object.keys(next).some((key) => next[key] !== shared[key])) {
    send("setGlobalSettings", next);
    shared = next;
    serverSettings.open = false;
  }
  if (!commandField.hidden) send("setSettings", { command: command.value.trim() });
  finishLookup();
  status("Saved.");
});
