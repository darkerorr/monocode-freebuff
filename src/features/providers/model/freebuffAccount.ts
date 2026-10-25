import {
  inspectHarnessBinary,
  subscribeFreebuffPty,
  type FreebuffPtyEvent,
} from "../../../integrations/harness/core/child";
import { stripFreebuffAnsi } from "../../../integrations/harness/providers/freebuff/freebuffProtocol";

/**
 * Freebuff has no documented external status/model command. Observe the PTY
 * already owned by a real MonoCode session; never start another CLI just to
 * populate account UI. Report only values actually painted by Freebuff.
 */

export type CapabilityState = "available" | "unavailable" | "unknown" | "error";

export type Observed<T> = {
  state: CapabilityState;
  value: T | null;
  reason: string | null;
  source: string;
  checkedAt: number | null;
};

export type FreebuffModel = {
  name: string;
  effort: string | null;
  descriptors: string[];
  selected: boolean;
};

export type FreebuffDailyHours = { remaining: number; limit: number };
export type FreebuffContext = { label: string; percent: number };
export type FreebuffAccountSnapshot = {
  version: Observed<string>;
  signedIn: Observed<boolean>;
  plan: Observed<string>;
  dailyHours: Observed<FreebuffDailyHours>;
  sessionLeftMinutes: Observed<number>;
  context: Observed<FreebuffContext>;
  model: Observed<{ name: string; effort: string }>;
  models: Observed<FreebuffModel[]>;
  modelControl: Observed<string>;
  contextCapacity: Observed<string>;
  accountTokens: Observed<never>;
  resetsAt: Observed<number>;
  checkedAt: number | null;
  probing: boolean;
  error: string | null;
};

export const FREEBUFF_SOURCE_TERMINAL = "Freebuff terminal";
export const FREEBUFF_ACCOUNT_URL = "https://freebuff.com/account";
export const FREEBUFF_PLANS_URL = "https://freebuff.com/plans";

function observed<T>(
  state: CapabilityState,
  value: unknown,
  reason: string | null,
  checkedAt: number | null,
  source = FREEBUFF_SOURCE_TERMINAL,
): Observed<T> {
  return {
    state,
    value: (value ?? null) as T | null,
    reason,
    source,
    checkedAt,
  };
}

function unknownOf<T>(reason: string, checkedAt: number | null = null): Observed<T> {
  return observed("unknown", null, reason, checkedAt);
}

function lastAvailable<T>(current: Observed<T>, next: Observed<T>): Observed<T> {
  return next.value == null && current.value != null ? current : next;
}

function initialSnapshot(): FreebuffAccountSnapshot {
  return {
    version: unknownOf("Freebuff CLI version has not been queried yet."),
    signedIn: unknownOf("Start a Freebuff session in MonoCode to confirm its stored sign-in."),
    plan: observed("unavailable", null, "Freebuff's CLI does not print your plan. It is only shown on your account page.", null),
    dailyHours: unknownOf("Start a Freebuff session in MonoCode; its terminal may show the available balance."),
    sessionLeftMinutes: unknownOf("Start a Freebuff session in MonoCode; its terminal may show the session limit."),
    context: unknownOf("Start a Freebuff session in MonoCode; its terminal may show conversation context."),
    contextCapacity: observed("unavailable", null, "Freebuff's visible context indicator reports used context and percentage but no maximum capacity.", null),
    model: unknownOf("Start a Freebuff session in MonoCode; its terminal may show the active model."),
    models: observed("unavailable", null, "No active Freebuff model picker has been read yet. Open the MonoCode model picker to request its live choices.", null),
    modelControl: observed("available", null, "MonoCode can list and select models through Freebuff's interactive /model picker and waits for the active model confirmation.", null),
    accountTokens: observed("unavailable", null, "Freebuff exposes an hourly balance, not account tokens or credits; MonoCode does not estimate them.", null),
    resetsAt: unknownOf("Freebuff does not print when its hourly balance resets."),
    checkedAt: null,
    probing: false,
    error: null,
  };
}

const HOURS = /(\d{1,2})\s*\/\s*(\d{1,2})\s*hours?\s+remaining/i;
// No leading word boundary: Ink writes the status pieces separately, so the
// stripped stream often glues this to the balance line (`…remaining12m left`).
const SESSION_LEFT = /(?:(?:(\d{1,2})h\s*)?(\d{1,3})m|(\d{1,2}):(\d{2}))\s+left\b/i;
const CONTEXT = /\b(\d+(?:\.\d+)?[KM])\s*\((\d{1,3})%\)/i;
/**
 * Freebuff's composer footer paints `<model> • <effort> · <cwd> · /model`.
 * Ink writes the border and that text in one line and glues spans together, so
 * the name is matched anywhere on the line rather than at a line start.
 * Requiring a path after the effort separator keeps the `/model` picker rows
 * (`<model> • <effort> · 3x`) from being mistaken for the model in use.
 */
const MODEL_LINE =
  /([A-Za-z0-9][A-Za-z0-9 ._+\-/()]{1,59}?)\s*•\s*(low|medium|high|max)\s*·\s*(?:~|\/|[A-Za-z]:[\\/])/gim;

/** Box drawing and block glyphs Freebuff paints around the same text. */
const BOX_GLYPHS = /[│┃┌┐└┘─┼┬┴├┤▍▏▎▕▌█▀▄▐]/g;

function cleanFreebuffScreen(text: string): string {
  return stripFreebuffAnsi(text).replace(BOX_GLYPHS, " ");
}

export type FreebuffScreenRead = {
  dailyHours: FreebuffDailyHours | null;
  sessionLeftMinutes: number | null;
  context: FreebuffContext | null;
  model: { name: string; effort: string } | null;
  balanceUnavailable: boolean;
  signedOut: boolean;
};

function lastRegexMatch(text: string, pattern: RegExp): RegExpExecArray | null {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  let last: RegExpExecArray | null = null;
  for (const match of text.matchAll(new RegExp(pattern.source, flags))) last = match as RegExpExecArray;
  return last;
}

export function parseFreebuffUsageScreen(text: string): FreebuffScreenRead {
  const screen = cleanFreebuffScreen(text);
  const hours = lastRegexMatch(screen, HOURS);
  let dailyHours: FreebuffDailyHours | null = null;
  if (hours) {
    const remaining = Number(hours[1]);
    const limit = Number(hours[2]);
    if (limit > 0 && remaining >= 0 && remaining <= limit) dailyHours = { remaining, limit };
  }
  let sessionLeftMinutes: number | null = null;
  const left = lastRegexMatch(screen, SESSION_LEFT);
  if (left) {
    const total = left[3]
      ? Number(left[3]) * 60 + Number(left[4])
      : (left[1] ? Number(left[1]) : 0) * 60 + Number(left[2]);
    if (total > 0) sessionLeftMinutes = total;
  }
  let context: FreebuffContext | null = null;
  const ctx = lastRegexMatch(screen, CONTEXT);
  if (ctx) {
    const percent = Number(ctx[2]);
    if (percent >= 0 && percent <= 100) context = { label: ctx[1], percent };
  }
  const model = lastRegexMatch(screen, MODEL_LINE);
  return {
    dailyHours,
    sessionLeftMinutes,
    context,
    model: model
      ? {
          // Ink paints display names in pieces, so `V4.1` + `Flash` can arrive
          // glued once the cursor moves are stripped.
          name: model[1].trim().replace(/([0-9.])([A-Z][a-z])/g, "$1 $2"),
          effort: model[2],
        }
      : null,
    balanceUnavailable: /balance unavailable/i.test(screen),
    signedOut: /freebuff login|log in to freebuff|not logged in|please log in/i.test(screen),
  };
}

const PICKER_START = /choose model|select a model|Esc cancel/i;
const BOX = /[│┃|]/g;
const PRICE_BADGE = /^\d+(?:\.\d+)?x$|^\d+\s*\/\s*\d+$/;
const HEADER = /^(OPTIMIZED|POWERFUL|PREMIUM|FREE|FAST|CHEAP)/i;
const EFFORTS = new Set(["low", "medium", "high", "max"]);
const NAME_NOISE = /^(recommended|images|smart & fast|may use data for ai training|falls back when busy|cheapest)$/i;

export function parseFreebuffModelPicker(text: string): FreebuffModel[] {
  const screen = stripFreebuffAnsi(text);
  const starts = [...screen.matchAll(new RegExp(PICKER_START.source, "gi"))];
  const start = starts.length > 0 ? starts[starts.length - 1] : undefined;
  if (!start || start.index == null) return [];
  // PTY output is a stream of repaint frames. Parse the latest picker frame,
  // not an earlier selection repeated in the same accumulated output buffer.
  const region = screen.slice(start.index).replace(/\r/g, "\n").replace(/↑↓|Tab reasoning|Enter select|Esc cancel/gi, "\n").replace(/[│┃]/g, "\n").replace(/[▍▏▎▕▌█]+/g, " ").replace(/[┌┐└┘─┼┬┴├┤]+/g, "\n").replace(/▀/g, "\n");
  const models: FreebuffModel[] = [];
  const seen = new Set<string>();
  for (const raw of region.split("\n")) {
    const line = raw.replace(BOX, " ").trim();
    if (!line || HEADER.test(line)) continue;
    const selected = line.startsWith("›");
    const body = selected ? line.slice(1).trim() : line;
    if (!body || /choose model|enter select|esc cancel/i.test(body)) continue;
    const bullet = body.search(/[•·]/);
    if (bullet < 0) continue;
    const name = body.slice(0, bullet).trim();
    if (!name || !/^[A-Za-z]/.test(name) || name.length > 60 || NAME_NOISE.test(name)) continue;
    if (/^\d+(?:\.\d+)?x$/.test(name) || (!/\s/.test(name) && !/\d/.test(name))) continue;
    const rest = body.slice(bullet + 1).split(/[·•]/).map((part) => part.trim()).filter(Boolean);
    if (rest.length === 0) continue;
    let effort: string | null = null;
    const descriptors: string[] = [];
    for (const part of rest) {
      const lower = part.toLowerCase();
      if (!effort && EFFORTS.has(lower)) effort = lower;
      else if (!PRICE_BADGE.test(part)) descriptors.push(part);
    }
    if (!effort && descriptors.length === 0) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({ name, effort, descriptors, selected });
  }
  return models;
}

let snapshot: FreebuffAccountSnapshot = initialSnapshot();
let lastProbeAt = 0;
let inflight: Promise<FreebuffAccountSnapshot> | null = null;
const listeners = new Set<() => void>();
let detachPtyUpdates: (() => void) | null = null;
const terminalBySession = new Map<string, string>();
const MAX_TERMINAL_CHARS = 64_000;

export function getFreebuffAccountSnapshot(): FreebuffAccountSnapshot {
  return snapshot;
}

export function subscribeFreebuffAccount(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    detachPtyUpdates = subscribeFreebuffPty(updateFreebuffAccountFromPty);
    void refreshFreebuffAccount();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      detachPtyUpdates?.();
      detachPtyUpdates = null;
    }
  };
}

function publish(next: FreebuffAccountSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function recordFreebuffModelControl(
  _sessionId: string,
  models: FreebuffModel[],
  activeModel?: { name: string; effort: string },
): void {
  const checkedAt = Date.now();
  const selected = models.find((item) => item.selected);
  const confirmed = activeModel ?? (selected
    ? { name: selected.name, effort: selected.effort ?? "" }
    : undefined);
  const choices = confirmed
    ? models.map((item) => ({ ...item, selected: item.name === confirmed.name }))
    : models;
  publish({
    ...snapshot,
    models: choices.length > 0
      ? observed("available", choices, "Visible entries in Freebuff's interactive /model picker; additional entries may be below the fold.", checkedAt)
      : observed("unavailable", null, "Freebuff opened its model picker but no model rows could be parsed from the visible screen.", checkedAt),
    model: confirmed
      ? observed("available", confirmed, "Model confirmed by Freebuff's selected /model row.", checkedAt)
      : snapshot.model,
    checkedAt,
  });
}

export function freebuffSnapshotFromProbe(input: {
  boot: string;
  picker?: string;
  version?: string | null;
  booted: boolean;
  checkedAt: number;
}): FreebuffAccountSnapshot {
  const read = parseFreebuffUsageScreen(input.boot);
  const models = parseFreebuffModelPicker(input.picker ?? "");
  const { checkedAt } = input;
  const screenReason = "Freebuff did not show this in the active terminal.";
  return {
    version: input.version ? observed("available", input.version, null, checkedAt, "Freebuff CLI --version") : unknownOf("Freebuff CLI version has not been queried yet.", checkedAt),
    signedIn: read.signedOut ? observed("available", false, "Freebuff asked to sign in. Run `freebuff login`.", checkedAt) : input.booted ? observed("available", true, "Freebuff reached its composer, so its stored session works.", checkedAt) : unknownOf("Freebuff never reached its composer, so sign-in could not be confirmed.", checkedAt),
    plan: observed("unavailable", null, "Freebuff's CLI does not print your plan; only your account page shows it.", checkedAt),
    dailyHours: read.dailyHours ? observed("available", read.dailyHours, "Hourly balance printed by Freebuff's usage panel.", checkedAt) : observed(read.balanceUnavailable ? "unavailable" : "unknown", null, read.balanceUnavailable ? "Freebuff reported that its balance was unavailable." : screenReason, checkedAt),
    sessionLeftMinutes: read.sessionLeftMinutes != null ? observed("available", read.sessionLeftMinutes, "Time left in the session Freebuff reported.", checkedAt) : observed("unknown", null, screenReason, checkedAt),
    context: read.context ? observed("available", read.context, "Conversation context, not account tokens.", checkedAt) : observed("unknown", null, screenReason, checkedAt),
    contextCapacity: observed("unavailable", null, "Freebuff's visible context indicator reports used context and percentage but no maximum capacity.", checkedAt),
    model: read.model ? observed("available", read.model, "Model Freebuff is using; it is chosen inside Freebuff.", checkedAt) : observed("unknown", null, screenReason, checkedAt),
    models: models.length > 0 ? observed("available", models, "Entries from Freebuff's own interactive model picker; it may list more below the fold.", checkedAt) : observed("unavailable", null, "No active Freebuff model picker was available to read.", checkedAt),
    accountTokens: observed("unavailable", null, "Freebuff exposes an hourly balance, not account tokens or credits; MonoCode does not estimate them.", checkedAt),
    resetsAt: observed("unknown", null, "Freebuff does not print when its hourly balance resets.", checkedAt),
    checkedAt,
    modelControl: observed("available", null, "MonoCode can request a model change through Freebuff's interactive /model picker and confirm the terminal redraw.", checkedAt),
    probing: false,
    error: null,
  };
}

/**
 * Keep only the visible screen facts; never write PTY contents to logs. Box
 * glyphs stay here because the model picker uses its column borders to split
 * rows; each parser removes them when it reads a single line of facts.
 */
function visibleTerminalText(text: string): string {
  const clean = stripFreebuffAnsi(text).replace(/[▍▏▎▕▌█]+/g, " ");
  const lines: string[] = [];
  for (const raw of clean.split(/[\r\n]+/)) {
    const line = raw.trim();
    if (!line) continue;
    const existing = lines.findIndex((entry) => entry.startsWith(line) || line.startsWith(entry));
    if (existing >= 0) {
      if (line.length > lines[existing].length) lines[existing] = line;
    } else lines.push(line);
  }
  return lines.join("\n");
}

export function updateFreebuffAccountFromPty(event: FreebuffPtyEvent): void {
  if (event.kind === "exit") {
    if (!terminalBySession.delete(event.sessionId)) return;
    const entries = [...terminalBySession.entries()];
    const remaining = entries[entries.length - 1];
    if (remaining) {
      updateFreebuffAccountFromPty({ kind: "data", sessionId: remaining[0], data: remaining[1] });
      return;
    }
    const checkedAt = Date.now();
    publish({
      ...snapshot,
      signedIn: unknownOf("The Freebuff session ended; start it again to refresh account status.", checkedAt),
      dailyHours: unknownOf("The Freebuff session ended before the balance could be refreshed.", checkedAt),
      sessionLeftMinutes: unknownOf("The Freebuff session ended; session time is unavailable.", checkedAt),
      context: unknownOf("The Freebuff session ended; context is unavailable.", checkedAt),
      model: unknownOf("The Freebuff session ended; active model is unavailable.", checkedAt),
      models: observed("unavailable", null, "The Freebuff session ended; start it again before reading its model choices.", checkedAt),
      probing: false,
      checkedAt,
    });
    return;
  }

  const buffered = `${terminalBySession.get(event.sessionId) ?? ""}${event.data}`;
  const terminal = visibleTerminalText(buffered.slice(-MAX_TERMINAL_CHARS));
  terminalBySession.set(event.sessionId, terminal);
  const pickerModels = parseFreebuffModelPicker(terminal);
  const booted = /enter a coding task|for commands/i.test(terminal);
  const openedPicker = /choose model|esc cancel/i.test(terminal);
  const read = parseFreebuffUsageScreen(terminal);
  const hasObservedFacts = Boolean(read.dailyHours || read.sessionLeftMinutes != null || read.context || read.model || read.signedOut || read.balanceUnavailable);
  if (!booted && !openedPicker && !hasObservedFacts) return;
  if (import.meta.env.DEV) {
    console.debug("[Freebuff PTY screen]", {
      frameChars: event.data.length,
      bufferedChars: terminal.length,
      bootMarker: booted,
      modelPicker: openedPicker,
      model: read.model != null,
      context: read.context != null,
      hourlyBalance: read.dailyHours != null,
      sessionTime: read.sessionLeftMinutes != null,
    });
  }
  const checkedAt = Date.now();
  const fresh = freebuffSnapshotFromProbe({ boot: terminal, picker: openedPicker ? terminal : undefined, version: snapshot.version.value, booted, checkedAt });
  const unavailable = <T>(reason: string) => observed<T>("unknown", null, reason, checkedAt);
  publish({
    ...snapshot,
    signedIn: fresh.signedIn,
    dailyHours: lastAvailable(snapshot.dailyHours, read.dailyHours ? observed("available", read.dailyHours, "Hourly balance printed by the active Freebuff terminal.", checkedAt) : unavailable(read.balanceUnavailable ? "Freebuff reported that its balance was unavailable." : "Freebuff did not show the hourly balance in this terminal update.")),
    sessionLeftMinutes: lastAvailable(snapshot.sessionLeftMinutes, read.sessionLeftMinutes != null ? observed("available", read.sessionLeftMinutes, "Session time printed by Freebuff.", checkedAt) : unavailable("Freebuff did not show session time in this terminal update.")),
    context: lastAvailable(snapshot.context, read.context ? observed("available", read.context, "Conversation context, not account tokens.", checkedAt) : unavailable("Freebuff did not show context in this terminal update.")),
    model: lastAvailable(snapshot.model, read.model ? observed("available", read.model, "Active model printed by Freebuff's terminal.", checkedAt) : unavailable("Freebuff did not show the active model in this terminal update.")),
    models: openedPicker
      ? pickerModels.length > 0
        ? observed("available", pickerModels, "Visible entries in Freebuff's interactive /model picker.", checkedAt)
        : observed("unavailable", null, "Freebuff opened its model picker but no model rows could be parsed from the visible terminal output.", checkedAt)
      : snapshot.models,
    modelControl: observed("available", null, "MonoCode requests model changes through Freebuff's interactive /model picker and waits for its active model to redraw.", checkedAt),
    checkedAt,
    error: read.signedOut ? "Freebuff is not signed in. Run `freebuff login`." : read.balanceUnavailable ? "Freebuff could not load account balance." : null,
  });
}

export async function refreshFreebuffAccount(_options?: { force?: boolean }): Promise<FreebuffAccountSnapshot> {
  if (inflight) return inflight;
  const force = _options?.force === true;
  if (force || !snapshot.version.value || snapshot.error) {
    publish({ ...snapshot, probing: true, error: null });
    inflight = inspectHarnessBinary("freebuff").then((inspection) => {
      const checkedAt = Date.now();
      if (inspection.error) throw new Error(inspection.error);
      const version = inspection.version ?? null;
      const next = { ...snapshot, version: version ? observed<string>("available", version, null, checkedAt, "Freebuff CLI --version") : unknownOf<string>("Freebuff CLI did not report a version.", checkedAt), checkedAt, probing: false, error: null };
      lastProbeAt = checkedAt;
      publish(next);
      return next;
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const failed = { ...snapshot, checkedAt: Date.now(), probing: false, error: message };
      lastProbeAt = failed.checkedAt ?? 0;
      publish(failed);
      return failed;
    }).finally(() => { inflight = null; });
    return inflight ?? Promise.resolve(snapshot);
  }
  return Promise.resolve(snapshot);
}

export function freebuffAccountLastProbeAt(): number { return lastProbeAt; }

export function resetFreebuffAccountForTests(): void {
  detachPtyUpdates?.();
  detachPtyUpdates = null;
  listeners.clear();
  snapshot = initialSnapshot();
  terminalBySession.clear();
  lastProbeAt = 0;
  inflight = null;
}
