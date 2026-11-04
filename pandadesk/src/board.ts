import { randomUUID } from "node:crypto";
import { formatNumber, t } from "./i18n.js";

// shortcut: renew timed commands by resending; add firmware lease renewal if a profile pauses between pulses.
export const MOVE_DURATION_MS = 750;
export const MOVE_REFRESH_MS = 350;

export type DeskState = {
  ready: boolean;
  moving: boolean | null;
  locked?: boolean | null;
  presets?: (number | null)[];
  height: { value: number | null; unit: "cm"; quality: string };
};
export type Capabilities = { move: boolean; stop: boolean; target_height: boolean; child_lock?: boolean; presets?: boolean };
export type HeightBounds = { min_height_cm: number; max_height_cm: number };

export function boardAddress(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(t("Board address is required."));
  const input = value.trim();
  let url: URL;
  try { url = new URL(input.includes("://") ? input : `http://${input}`); }
  catch { throw new Error(t("Enter only the board address, e.g. http://pandadesk.local.")); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error(t("Enter only the board address, e.g. http://pandadesk.local."));
  }
  return url.origin;
}

export function targetHeight(value: unknown): number {
  const height = typeof value === "string" && value.trim()
    ? Number(value.replace(",", ".")) : value;
  if (typeof height !== "number" || !Number.isFinite(height) || height <= 0 || height > 200 ||
      Math.abs(height * 10 - Math.round(height * 10)) > 1e-7) {
    throw new Error(t("Enter a target height in cm with at most one decimal place."));
  }
  return height;
}

export function presetSlot(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 4) {
    throw new Error(t("Select a preset from 1 to 4."));
  }
  return value;
}

async function request(board: string, path: string, body?: object, timeout = 1500): Promise<unknown> {
  let response: Response;
  try { response = await fetch(`${board}/api/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
    redirect: "error",
    cache: "no-store",
  }); } catch (error) {
    throw new Error(t(error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)
      ? "The board did not respond in time." : "Cannot reach the board. Check its address and network connection."));
  }
  let json: Record<string, unknown> | null;
  try { json = await response.json() as Record<string, unknown> | null; }
  catch { throw new Error(t("The board returned an invalid response.")); }
  if (!response.ok) {
    const errors: Record<string, string> = {
      profile_not_ready: "The desk profile is not ready.",
      target_height_unavailable: "This desk profile does not support target heights.",
      height_out_of_range: "The target height is outside the board's limits.",
      command_queue_full: "The board is busy. Press the key again.",
      child_locked: "The child lock is active.",
      child_lock_unavailable: "This desk profile does not support a child lock.",
      child_lock_busy: "The child lock is already being updated. Press the key again.",
      child_lock_not_confirmed: "The controller did not confirm the child lock.",
      presets_unavailable: "This desk profile does not support presets.",
      preset_unavailable: "This preset has no readable saved height.",
    };
    throw new Error(t(errors[String(json?.error)] ?? "The board returned HTTP {status}.", { status: response.status }));
  }
  return json;
}

function accepted(value: unknown): void {
  if ((value as { accepted?: boolean } | null)?.accepted !== true) throw new Error(t("The board did not confirm the command."));
}

export async function readDesk(board: string): Promise<{ state: DeskState; capabilities: Capabilities }> {
  const state = await request(board, "state") as DeskState | null;
  const capabilities = await request(board, "capabilities") as Capabilities | null;
  const height = state?.height?.value;
  if (typeof state?.ready !== "boolean" ||
      (state.moving !== null && typeof state.moving !== "boolean") ||
      (state.locked != null && typeof state.locked !== "boolean") ||
      state.height?.unit !== "cm" ||
      (height !== null && (typeof height !== "number" || !Number.isFinite(height) || height < 0 || height > 200)) ||
      typeof capabilities?.move !== "boolean" || typeof capabilities.stop !== "boolean" ||
      typeof capabilities.target_height !== "boolean" ||
      (capabilities.child_lock !== undefined && typeof capabilities.child_lock !== "boolean") ||
      (capabilities.presets !== undefined && typeof capabilities.presets !== "boolean") ||
      (state.presets !== undefined && (!Array.isArray(state.presets) || state.presets.length !== 4 ||
        state.presets.some((value) => value !== null && (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 200))))) {
    throw new Error(t("The response does not match PandaDesk API v1."));
  }
  return { state, capabilities };
}

export async function moveDesk(board: string, direction: "up" | "down" | "stop"): Promise<void> {
  accepted(await request(board, "commands/move", {
    request_id: randomUUID(), direction,
    ...(direction === "stop" ? {} : { expires_ms: MOVE_DURATION_MS }),
  }));
}

export async function readHeightBounds(board: string): Promise<HeightBounds> {
  const bounds = await request(board, "settings/device") as HeightBounds | null;
  const min = bounds?.min_height_cm, max = bounds?.max_height_cm;
  if (typeof min !== "number" || typeof max !== "number" || !Number.isFinite(min) ||
      !Number.isFinite(max) || min < 0 || min >= max || max > 200) {
    throw new Error(t("The board did not return a valid height range."));
  }
  return { min_height_cm: min, max_height_cm: max };
}

export function checkHeight(height: number, bounds: HeightBounds): void {
  if (height < bounds.min_height_cm || height > bounds.max_height_cm) {
    throw new Error(t("Allowed height range: {min}–{max} cm.", { min: formatNumber(bounds.min_height_cm), max: formatNumber(bounds.max_height_cm) }));
  }
}

export async function setHeight(board: string, height: number, current = () => true): Promise<void> {
  height = targetHeight(height);
  const { state, capabilities } = await readDesk(board);
  if (!state.ready) throw new Error(t("The desk profile is not ready."));
  if (!capabilities.target_height) throw new Error(t("This desk profile does not support target heights."));
  if (state.locked === true) throw new Error(t("The child lock is active."));
  checkHeight(height, await readHeightBounds(board));
  if (current()) accepted(await request(board, "commands/height", { request_id: randomUUID(), height_cm: height }));
}

export async function setChildLock(board: string, locked: boolean): Promise<void> {
  const result = await request(board, "commands/child-lock", { request_id: randomUUID(), locked }, 5000) as { locked?: boolean } | null;
  if (result?.locked !== locked) throw new Error(t("The controller did not confirm the requested lock state."));
}

export async function recallPreset(board: string, slot: number, current = () => true): Promise<void> {
  slot = presetSlot(slot);
  const { state, capabilities } = await readDesk(board);
  if (!state.ready) throw new Error(t("The desk profile is not ready."));
  if (!capabilities.presets) throw new Error(t("This desk profile does not support presets."));
  if (state.locked === true) throw new Error(t("The child lock is active."));
  const height = state.presets?.[slot - 1];
  if (height == null) throw new Error(t("This preset has no readable saved height."));
  checkHeight(height, await readHeightBounds(board));
  if (current()) accepted(await request(board, "commands/preset", { request_id: randomUUID(), preset: slot, operation: "recall" }));
}
