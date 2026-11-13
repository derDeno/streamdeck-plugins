export class PanelError extends Error {
  constructor(message, title = "Unavailable") {
    super(message);
    this.title = title;
  }
}

export function panelAddress(value) {
  const input = typeof value === "string" ? value.trim() : "";
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(input);
  const url = URL.parse(hasScheme ? input : `http://${input}`);
  if (!/^(?:https?:\/\/)?(?:\[[\da-f:.]+\]|[^:/\\@?#\s]+)(?::\d+)?\/?$/i.test(input) || !url) {
    throw new PanelError("Enter the Fabricator panel address, such as http://192.168.1.10:5000.", "Set up");
  }
  if (!hasScheme && !/:\d+\/?$/.test(input)) url.port = "5000";
  return url.origin;
}

function validServerId(value) {
  return typeof value === "string" && /^[a-z\d_-]+$/i.test(value);
}

export function serverPath(id) {
  if (!validServerId(id)) throw new PanelError("Select a server or enter its Fabricator server ID.", "Set up");
  return `/api/servers/${id}`;
}

function consoleCommand(value) {
  if (typeof value !== "string" || /[\x00-\x1f\x7f\u2028\u2029]/.test(value)) {
    throw new PanelError("Enter one Minecraft console command.");
  }
  const command = value.trim().replace(/^\//, "").trim();
  if (!command) throw new PanelError("Set a Minecraft console command for this key.");
  return command;
}

export class Panel {
  #session;
  #login;
  #retryLoginAt = 0;

  constructor(address, password, signal) {
    this.address = panelAddress(address);
    this.password = typeof password === "string" ? password : "";
    this.signal = signal;
  }

  async #fetch(path, options, timeout, isWrite = false) {
    this.signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(timeout);
    const signal = this.signal && !isWrite ? AbortSignal.any([this.signal, deadline]) : deadline;
    let response;
    try {
      response = await fetch(this.address + path, { ...options, redirect: "error", signal });
    } catch {
      throw new PanelError(deadline.aborted ? "Fabricator did not respond in time." : "Could not reach Fabricator.", "Offline");
    }
    const data = await response.json().catch(() => null);
    return { response, data };
  }

  async #signIn() {
    if (!this.password) throw new PanelError("Enter the Fabricator operator password.", "Sign in");
    const invalidPassword = "Fabricator rejected the operator password.";
    if (Date.now() < this.#retryLoginAt) throw new PanelError(invalidPassword, "Sign in");
    const { response, data } = await this.#fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: this.password }),
    }, 8000);
    if (response.status === 401) {
      this.#retryLoginAt = Date.now() + 60000;
      throw new PanelError(invalidPassword, "Sign in");
    }
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith("session="));
    if (!response.ok || data?.authenticated !== true || !cookie) {
      throw new PanelError(`Fabricator sign-in failed (HTTP ${response.status}).`, "Sign in");
    }
    if (this.address.startsWith("http:") && /;\s*secure\s*(?:;|$)/i.test(cookie)) {
      throw new PanelError("Fabricator requires HTTPS for its login session.", "Use HTTPS");
    }
    this.#session = cookie.split(";", 1)[0];
  }

  async #request(path, { body, write = false, timeout = 8000 } = {}) {
    const perform = (session) => this.#fetch(path, {
      method: write ? "POST" : "GET",
      headers: {
        Accept: "application/json",
        ...(session ? { Cookie: session } : {}),
        ...(write ? { "Content-Type": "application/json" } : {}),
      },
      body: write ? JSON.stringify(body ?? {}) : undefined,
    }, timeout, write);

    const session = this.#session;
    let { response, data } = await perform(session);
    // This 401 comes from Fabricator's auth gate before the endpoint runs.
    if (response.status === 401 && data?.error === "authentication required") {
      if (!this.#session || this.#session === session) {
        this.#login ??= this.#signIn().finally(() => { this.#login = undefined; });
        await this.#login;
      }
      ({ response, data } = await perform(this.#session));
    }
    if (response.status === 401 && data?.error === "setup required") {
      throw new PanelError("Complete Fabricator's initial password setup in the browser.", "Set up");
    }
    if (response.status === 401 || response.status === 403) {
      throw new PanelError("Fabricator denied access. Check the operator password.", "Sign in");
    }
    if (response.status === 404) throw new PanelError("Fabricator could not find this endpoint or server.", "Not found");
    if (!response.ok || data === null || data.success === false) {
      throw new PanelError(`Fabricator rejected the request (HTTP ${response.status}).`);
    }
    return data;
  }

  async servers() {
    const servers = await this.#request("/api/servers");
    if (!Array.isArray(servers)) throw new PanelError("Fabricator returned an invalid server list.");
    return servers.filter((server) => validServerId(server?.id)).map(({ id, name }) => ({
      id, name: typeof name === "string" && name.trim() ? name : id,
    }));
  }

  async read(id, includeHeap) {
    const server = await this.#request(serverPath(id) + (includeHeap ? "?heap=1" : ""));
    if (server?.id !== id) throw new PanelError("Fabricator returned an invalid server record.");
    return server;
  }

  async run(id, action, command) {
    const lifecycle = ["start", "stop", "restart"].includes(action);
    const body = lifecycle ? undefined : { command: consoleCommand(command) };
    const result = await this.#request(`${serverPath(id)}/${lifecycle ? action : "console"}`, {
      body, write: true, timeout: lifecycle ? 720000 : 8000,
    });
    if (result?.success !== true) throw new PanelError("Fabricator did not confirm the request.");
  }
}
