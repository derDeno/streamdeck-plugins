import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

// Implements the firmware's API contract; never connects to real hardware.
export async function createMockBoard({ port = 0, targetSupported = true } = {}) {
  const requests = [];
  const reads = [];
  const options = { delayMoveMs: 0, failMove: false, offline: false, invalidState: false, targetSupported,
    childLockSupported: true, locked: false, delayLockMs: 0, failLock: false, wrongLockConfirmation: false,
    presetsSupported: true, presets: [72, 110, null, null],
    minHeight: 60, maxHeight: 125, invalidBounds: false, delayBoundsMs: 0 };
  let height = 72;
  let direction = "stop";
  let target = null;
  let deadline = 0;
  const clock = setInterval(() => {
    if (direction !== "stop" && Date.now() >= deadline) direction = "stop";
    if (direction !== "stop") height += direction === "up" ? 0.2 : -0.2;
    if (target !== null) {
      height += Math.sign(target - height) * Math.min(0.2, Math.abs(target - height));
      if (Math.abs(target - height) < 0.01) target = null;
    }
    height = Math.min(options.maxHeight, Math.max(options.minHeight, height));
  }, 50);
  const server = createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (options.offline) return reply(503, { error: "offline" });
    if (req.method === "GET") reads.push(req.url);
    if (req.method === "GET" && req.url === "/api/v1/state") {
      return reply(200, options.invalidState ? {} : {
        state: "READY", ready: true, profile: "mock_jiecang",
        height: { value: Math.round(height * 10) / 10, unit: "cm", quality: "measured" },
        moving: direction !== "stop" || target !== null,
        locked: options.locked,
        presets: options.presets,
      });
    }
    if (req.method === "GET" && req.url === "/api/v1/capabilities") {
      return reply(200, { move: true, stop: true, target_height: options.targetSupported, presets: options.presetsSupported, child_lock: options.childLockSupported });
    }
    if (req.method === "GET" && req.url === "/api/v1/settings/device") {
      if (options.delayBoundsMs) await new Promise((resolve) => setTimeout(resolve, options.delayBoundsMs));
      return reply(200, options.invalidBounds ? {} : { min_height_cm: options.minHeight, max_height_cm: options.maxHeight });
    }
    if (req.method !== "POST") return reply(404, { error: "not_found" });
    try {
      let text = "";
      for await (const chunk of req) {
        text += chunk;
        if (text.length > 512) return reply(400, { error: "invalid_request" });
      }
      const body = JSON.parse(text);
      requests.push({ path: req.url, body });
      if (typeof body.request_id !== "string" || !body.request_id || body.request_id.length > 64) {
        return reply(400, { error: "invalid_request" });
      }
      if (req.url === "/api/v1/commands/move") {
        if (!["up", "down", "stop"].includes(body.direction) ||
            (body.direction === "stop" ? body.expires_ms !== undefined :
              !Number.isInteger(body.expires_ms) || body.expires_ms < 1 || body.expires_ms > 5000)) {
          return reply(400, { error: "invalid_request" });
        }
        if (body.direction !== "stop" && options.delayMoveMs) {
          await new Promise((resolve) => setTimeout(resolve, options.delayMoveMs));
        }
        if (options.failMove && body.direction !== "stop") return reply(503, { error: "command_queue_full" });
        if (options.locked === true && body.direction !== "stop") return reply(409, { error: "child_locked" });
        direction = body.direction;
        target = null;
        deadline = Date.now() + (body.expires_ms ?? 0);
      } else if (req.url === "/api/v1/commands/height") {
        if (!options.targetSupported) return reply(409, { error: "target_height_unavailable" });
        if (!Number.isFinite(body.height_cm) || body.height_cm < options.minHeight || body.height_cm > options.maxHeight) {
          return reply(400, { error: "height_out_of_range" });
        }
        if (options.locked === true) return reply(409, { error: "child_locked" });
        direction = "stop";
        target = body.height_cm;
      } else if (req.url === "/api/v1/commands/preset") {
        if (!Number.isInteger(body.preset) || body.preset < 1 || body.preset > 4 || !["recall", "save"].includes(body.operation)) {
          return reply(400, { error: "invalid_request" });
        }
        if (!options.presetsSupported) return reply(409, { error: "presets_unavailable" });
        if (options.locked === true) return reply(409, { error: "child_locked" });
        if (body.operation === "save") options.presets[body.preset - 1] = Math.round(height * 10) / 10;
        else {
          const saved = options.presets[body.preset - 1];
          if (saved == null) return reply(409, { error: "preset_unavailable" });
          if (saved < options.minHeight || saved > options.maxHeight) return reply(400, { error: "height_out_of_range" });
          direction = "stop";
          target = saved;
        }
      } else if (req.url === "/api/v1/commands/child-lock") {
        if (typeof body.locked !== "boolean") return reply(400, { error: "invalid_request" });
        if (!options.childLockSupported) return reply(409, { error: "child_lock_unavailable" });
        if (options.delayLockMs) await new Promise((resolve) => setTimeout(resolve, options.delayLockMs));
        if (options.failLock) return reply(504, { error: "child_lock_not_confirmed" });
        if (options.wrongLockConfirmation) return reply(200, { locked: !body.locked });
        options.locked = body.locked;
        return reply(200, { locked: options.locked });
      } else return reply(404, { error: "not_found" });
      reply(202, { accepted: true });
    } catch {
      reply(400, { error: "invalid_request" });
    }
  });
  try {
    await new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
  } catch (error) {
    clearInterval(clock);
    throw error;
  }
  return {
    url: `http://127.0.0.1:${server.address().port}`, requests, reads, options,
    close: () => new Promise((resolve) => {
      clearInterval(clock);
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 18787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid mock-board port.");
  const board = await createMockBoard({ port });
  console.log(`PandaDesk simulation: ${board.url} (60–125 cm, start 72 cm)`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void board.close());
}
