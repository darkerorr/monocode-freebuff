import { Terminal } from "@xterm/xterm";
import { TurnNotReadyError } from "../../core/types";
import type {
  ApprovalDecision,
  HarnessEvent,
  HarnessSessionInput,
  SendTurnInput,
  SteerTurnInput,
} from "../../core/types";
import * as child from "../../core/child";
import type {
  FreebuffChatSnapshot,
  FreebuffPtyModelControlRequest,
} from "../../core/child";
import {
  forgetFreebuffScreen,
  observeFreebuffScreen,
  parseFreebuffModelPicker,
  parseFreebuffUsageScreen,
  recordFreebuffModelControl,
  type FreebuffModel,
} from "../../../../features/providers/model/freebuffAccount";
import { runtimeProviderBinaryPath } from "../../../../features/providers/model/providerBinaryPaths";
import type { UserQuestionReply } from "../../../../features/sessions/model/userQuestion";
import {
  FREEBUFF_BOOT_MARKER,
  FREEBUFF_BOOT_SETTLE_MS,
  FREEBUFF_BOOT_TIMEOUT_MS,
  FREEBUFF_ECHO_TIMEOUT_MS,
  FREEBUFF_PASTE_SETTLE_MS,
  FREEBUFF_POLL_MS,
  FREEBUFF_PROMPT_TIMEOUT_MS,
  FREEBUFF_SESSION_ERROR,
  FREEBUFF_SUBMIT_KEY,
  FREEBUFF_TURN_TIMEOUT_MS,
  countOccurrences,
  createFreebuffTurnState,
  freebuffBootDiagnostics,
  freebuffChatId,
  freebuffContextUsage,
  freebuffPromptEcho,
  freebuffPromptPayload,
  freebuffScreenText,
  freebuffTerminalReply,
  freebuffPtyTail,
  freebuffStartupError,
  freebuffTurnProgress,
  stripFreebuffAnsi,
  type FreebuffTurnState,
} from "./freebuffProtocol";

/**
 * Freebuff's only interface is its terminal UI. This adapter owns a private
 * PTY, submits each turn into it, and follows the structured transcript the UI
 * persists. It deliberately does not scrape the rendered screen for replies:
 * the transcript carries text, reasoning and tool calls, and its `isComplete`
 * flag is what ends a turn.
 */

type Turn = {
  state: FreebuffTurnState;
  settled: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
};

type Live = {
  sessionId: string;
  cwd: string;
  chatId: string;
  onEvent: (event: HarnessEvent) => void;
  /** ANSI-laden TUI output, kept only for actionable diagnostics. */
  output: string;
  cancelled: boolean;
  stopping: boolean;
  exited?: number | null;
  bootResolve?: () => void;
  bootReject?: (error: Error) => void;
  bootWaiter: boolean;
  turn?: Turn;
  /** The verifier keys the adapter used for this session. No user data. */
  resolvedCommand: string;
  resolvedArgs: string[];
  modelControlTail: string;
  modelControlBusy: boolean;
  startedNotified: boolean;
  screen: Terminal;
  /** Pending publish of the rendered screen to the account/context views. */
  screenTimer?: ReturnType<typeof setTimeout>;
  /** Last context Freebuff showed, re-sent when a turn binds a new listener. */
  context?: { used: number; window?: number };
  contextKey: string;
};

/** Publish the rendered screen at most this often; Ink repaints many times a second. */
const SCREEN_PUBLISH_MS = 250;

type Resume = { chatId: string; cwd: string };

export type FreebuffRuntime = {
  resolveBinary: () => Promise<{ path: string }>;
  prepareChat: (
    cwd: string,
    chatId: string,
  ) => Promise<{ path: string; created: boolean }>;
  readChat: (cwd: string, chatId: string) => Promise<FreebuffChatSnapshot>;
  spawn: (input: {
    sessionId: string;
    command: string;
    cwd: string;
    chatId: string;
    binaryPath?: string | null;
  }) => Promise<number>;
  write: (sessionId: string, data: string) => Promise<void>;
  kill: (sessionId: string) => Promise<void>;
  watch: (
    sessionId: string,
    onData: (data: string) => void,
    onExit: (code: number | null) => void,
  ) => void;
  unwatch: (sessionId: string) => void;
  delay: (milliseconds: number) => Promise<void>;
  now: () => number;
};

const defaultRuntime: FreebuffRuntime = {
  resolveBinary: () => child.resolveFreebuffBinary(),
  prepareChat: child.prepareFreebuffChat,
  readChat: child.readFreebuffChat,
  spawn: child.spawnFreebuffPty,
  write: child.writeFreebuffPty,
  kill: child.killFreebuffPty,
  watch: child.watchFreebuffPty,
  unwatch: child.unwatchFreebuffPty,
  delay: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: () => Date.now(),
};

const liveByThread = new Map<string, Live>();
const startupByThread = new Map<string, Promise<Live>>();
const resumeByThread = new Map<string, Resume>();
const cancelledThreads = new Set<string>();
const OUTPUT_TAIL_CHARS = 32_000;

let runtime: FreebuffRuntime = defaultRuntime;
let detachModelControl: (() => void) | null = null;
let modelControlSubscriberCount = 0;

function ensureModelControlSubscription(): void {
  if (detachModelControl) return;
  detachModelControl = child.subscribeFreebuffPtyWrites((request) => {
    const live = liveByThread.get(request.sessionId);
    if (!live || live.cancelled || live.stopping || live.exited !== undefined) {
      return false;
    }
    live.output = "";
    void controlFreebuffModel(live, request).catch(() => undefined);
    return true;
  });
}

/**
 * Request an actual model switch through Freebuff's visible picker. We identify
 * choices from its current rendered screen, confirm the highlighted row by
 * parsing the next redraw, and never assume model order or a row number.
 */
async function controlFreebuffModel(
  live: Live,
  request: FreebuffPtyModelControlRequest,
): Promise<void> {
  let pickerOpened = false;
  let claimedControl = false;
  try {
    if (live.turn) {
      throw new Error("Wait for Freebuff to finish its current response before changing models.");
    }
    if (live.modelControlBusy) {
      throw new Error("Freebuff's model picker is already being controlled.");
    }
    live.modelControlBusy = true;
    claimedControl = true;
    const before = parseFreebuffUsageScreen(live.modelControlTail || live.output).model;
    live.modelControlTail = "";
    await writeAndWaitFor(live, "/model", FREEBUFF_MODEL_PICKER_RE, 4_000);
    pickerOpened = true;
    const visible = await waitForModelChoices(live, 4_000);
    if (request.action === "list") {
      // The picker only fits a few cards on screen: walk it to read them all,
      // then Esc, which leaves the active model untouched.
      const catalog = await readModelCatalog(live, visible);
      await closeModelPicker(live);
      pickerOpened = false;
      recordFreebuffModelControl(live.sessionId, catalog.models);
      request.resolve(catalog.models);
      return;
    }
    const choices = visible;
    if (request.action === "activeModel") {
      const selectedModel = choices.find((item) => item.selected);
      await closeModelPicker(live);
      pickerOpened = false;
      if (selectedModel) {
        recordFreebuffModelControl(live.sessionId, choices, {
          name: selectedModel.name,
          effort: selectedModel.effort ?? "",
        });
      }
      request.resolve(
        selectedModel
          ? { name: selectedModel.name, effort: selectedModel.effort ?? "" }
          : null,
      );
      return;
    }

    const target = request.data;
    const selected = choices.find((item) => item.selected);
    if (selected && selected.name === target) {
      await closeModelPicker(live);
      pickerOpened = false;
      recordFreebuffModelControl(live.sessionId, choices, {
        name: selected.name,
        effort: selected.effort ?? "",
      });
      request.resolve();
      return;
    }
    // The target may sit below the fold: read the whole catalog first.
    const catalog = choices.some((item) => item.name === target)
      ? { models: choices, highlighted: selected?.name ?? null }
      : await readModelCatalog(live, choices);
    const match = catalog.models.find((item) => item.name === target);
    if (!match) {
      throw new Error(`Freebuff does not currently offer the model “${target}”.`);
    }
    if (match.locked) {
      throw new Error(`“${target}” needs a Freebuff paid plan. Choose it in Freebuff after upgrading.`);
    }
    const targetIndex = catalog.models.findIndex((item) => item.name === target);
    let currentIndex = catalog.models.findIndex((item) => item.name === catalog.highlighted);
    if (currentIndex < 0) {
      throw new Error("Freebuff's current model-picker selection could not be confirmed.");
    }
    // Move one row at a time towards the target. Each key is followed by a
    // fresh screen parse, never a guessed model-row position.
    for (let step = 0; currentIndex !== targetIndex && step <= catalog.models.length * 2; step += 1) {
      await runtime.write(live.sessionId, targetIndex > currentIndex ? "\u001b[B" : "\u001b[A");
      const next = await waitForHighlightChange(live, catalog.models[currentIndex].name, 1_500);
      const nextIndex = next ? catalog.models.findIndex((item) => item.name === next) : -1;
      if (nextIndex < 0 || nextIndex === currentIndex) {
        throw new Error("Freebuff did not confirm the model-picker navigation.");
      }
      currentIndex = nextIndex;
    }
    const highlighted = await waitForSelectedPickerModel(live, 1_500);
    if (highlighted !== target) {
      throw new Error(`Freebuff highlighted “${highlighted}”, not “${target}”.`);
    }
    const beforeSelect = live.modelControlTail;
    await runtime.write(live.sessionId, "\r");
    await waitForModelPickerClose(live, 3_000, beforeSelect, target);
    pickerOpened = false;
    const after = await waitForActiveModel(live, 3_000, beforeSelect);
    if (!after || after.name !== target || (before?.name === target && selected?.name !== target)) {
      throw new Error("Freebuff did not confirm the requested active model.");
    }
    recordFreebuffModelControl(live.sessionId, catalog.models, after);
    request.resolve();
  } catch (error) {
    if (pickerOpened && !live.cancelled && !live.stopping && live.exited === undefined) {
      await closeModelPicker(live).catch(() => undefined);
    }
    request.reject(error instanceof Error ? error : new Error(String(error)));
  } finally {
    if (claimedControl) live.modelControlBusy = false;
  }
}

/** Most models Freebuff has ever listed is ~15; leave room without looping forever. */
const MAX_PICKER_ROWS = 40;

/**
 * Walk Freebuff's picker with ↓ to read every card, merging each visible frame
 * into one ordered list. Stops when the highlight stops moving or comes back to
 * a row it already visited (the list wrapped). `selected` stays on the model
 * that was active when the picker opened; the highlight is only a cursor.
 */
async function readModelCatalog(
  live: Live,
  visible: FreebuffModel[],
): Promise<{ models: FreebuffModel[]; highlighted: string | null }> {
  const active = visible.find((item) => item.selected)?.name ?? null;
  const models: FreebuffModel[] = [];
  const merge = (frame: FreebuffModel[]) => {
    let insertAt = 0;
    for (const item of frame) {
      const known = models.findIndex((entry) => entry.name === item.name);
      if (known >= 0) {
        // A later frame may show the card's second line that an earlier one cut.
        models[known] = {
          ...models[known],
          multiplier: models[known].multiplier ?? item.multiplier,
          locked: models[known].locked || item.locked,
        };
        insertAt = known + 1;
      } else {
        models.splice(insertAt, 0, { ...item });
        insertAt += 1;
      }
    }
  };
  merge(visible);
  let highlighted = active;
  const visited = new Set(highlighted ? [highlighted] : []);
  for (let step = 0; step < MAX_PICKER_ROWS; step += 1) {
    await runtime.write(live.sessionId, "\u001b[B");
    const next = await waitForHighlightChange(live, highlighted, 1_500);
    if (!next) break; // The highlight did not move: it is on the last row.
    merge(parseFreebuffModelPicker(live.modelControlTail));
    highlighted = next;
    if (visited.has(next)) break; // Wrapped back to the top.
    visited.add(next);
  }
  return {
    models: models.map((item) => ({ ...item, selected: item.name === active })),
    highlighted,
  };
}

/**
 * Wait for the picker's highlight to land on a different model. An unrelated
 * repaint (timer, rotating ad) does not count. Null when it never moves.
 */
async function waitForHighlightChange(
  live: Live,
  from: string | null,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = runtime.now() + timeoutMs;
  while (runtime.now() <= deadline) {
    if (live.cancelled || live.stopping || live.exited !== undefined) {
      throw new Error("Freebuff closed while the model picker was open.");
    }
    const current = parseFreebuffModelPicker(live.modelControlTail).find((item) => item.selected);
    if (current && current.name !== from) return current.name;
    await runtime.delay(40);
  }
  return null;
}

async function closeModelPicker(live: Live): Promise<void> {
  await runtime.write(live.sessionId, "\u001b");
  // Ink can repaint the normal footer without the selection footer's model
  // when Escape merely dismissed the picker. Confirm dismissal from the real
  // picker prompt disappearing; model changes still use the stricter expected
  // model check in the Enter path above.
  const deadline = runtime.now() + 2_000;
  while (runtime.now() <= deadline) {
    const visible = stripFreebuffAnsi(live.modelControlTail);
    if (!FREEBUFF_PICKER_TEXT_RE.test(visible)) return;
    await runtime.delay(40);
  }
  throw new Error("Freebuff did not close its model picker.");
}

const FREEBUFF_MODEL_PICKER_RE = /choose model|select a model|esc cancel/i;
const FREEBUFF_PICKER_TEXT_RE = /choose model|select a model|esc cancel/i;

async function writeAndWaitFor(
  live: Live,
  data: string,
  marker: RegExp,
  timeoutMs: number,
): Promise<void> {
  live.output = "";
  // Freebuff's command menu swallows an Enter that arrives in the same burst
  // as the command text (measured on 0.2.35 under ConPTY): type the command,
  // let the composer show it, then press Enter on its own.
  // The footer always reads "/model to change": count, don't just look.
  const shown = () => countOccurrences(freebuffScreenText(live.modelControlTail), data);
  const before = shown();
  await runtime.write(live.sessionId, data);
  const typedBy = runtime.now() + 1_500;
  while (runtime.now() <= typedBy && shown() <= before) {
    await runtime.delay(40);
  }
  await runtime.delay(FREEBUFF_COMMAND_SETTLE_MS);
  await runtime.write(live.sessionId, "\r");
  await waitForText(live, marker, timeoutMs);
}

/** Pause between a typed command and its Enter, so the menu has settled. */
const FREEBUFF_COMMAND_SETTLE_MS = 200;

async function waitForText(
  live: Live,
  marker: RegExp,
  timeoutMs: number,
): Promise<string> {
  const deadline = runtime.now() + timeoutMs;
  while (runtime.now() <= deadline) {
    if (live.cancelled || live.stopping || live.exited !== undefined) {
      throw new Error("Freebuff closed while the model picker was open.");
    }
    const text = stripFreebuffAnsi(live.modelControlTail);
    if (marker.test(text)) return text;
    await runtime.delay(40);
  }
  throw new Error("Freebuff did not show the expected model-picker screen.");
}

async function waitForModelChoices(
  live: Live,
  timeoutMs: number,
): Promise<FreebuffModel[]> {
  const deadline = runtime.now() + timeoutMs;
  while (runtime.now() <= deadline) {
    const choices = parseFreebuffModelPicker(live.modelControlTail);
    if (choices.length > 0 && choices.some((item) => item.selected)) return choices;
    await runtime.delay(40);
  }
  throw new Error("Freebuff did not report selectable model options.");
}

async function waitForSelectedPickerModel(
  live: Live,
  timeoutMs: number,
  afterTail = "",
): Promise<string> {
  const deadline = runtime.now() + timeoutMs;
  while (runtime.now() <= deadline) {
    if (afterTail && live.modelControlTail === afterTail) {
      await runtime.delay(40);
      continue;
    }
    const selected = parseFreebuffModelPicker(live.modelControlTail).find((item) => item.selected);
    if (selected) return selected.name;
    await runtime.delay(40);
  }
  throw new Error("Freebuff did not redraw the selected model-picker row.");
}

async function waitForModelPickerClose(
  live: Live,
  timeoutMs: number,
  afterTail = "",
  expectedModel?: string,
): Promise<void> {
  const deadline = runtime.now() + timeoutMs;
  while (runtime.now() <= deadline) {
    const visible = stripFreebuffAnsi(live.modelControlTail);
    const pickerStillVisible = FREEBUFF_PICKER_TEXT_RE.test(visible);
    const activeFooter = parseFreebuffUsageScreen(visible).model;
    if (
      (!afterTail || live.modelControlTail !== afterTail) &&
      activeFooter &&
      (expectedModel ? activeFooter.name === expectedModel : !pickerStillVisible)
    ) return;
    await runtime.delay(40);
  }
  throw new Error("Freebuff did not close its model picker.");
}

async function waitForActiveModel(
  live: Live,
  timeoutMs: number,
  afterTail = "",
): Promise<{ name: string; effort: string } | null> {
  const deadline = runtime.now() + timeoutMs;
  while (runtime.now() <= deadline) {
    if (afterTail && live.modelControlTail === afterTail) {
      await runtime.delay(40);
      continue;
    }
    const model = parseFreebuffUsageScreen(live.modelControlTail).model;
    if (model) return model;
    await runtime.delay(40);
  }
  return null;
}

class FreebuffCancelledError extends Error {}

/** Test seam: swap the PTY/transcript transport without a Tauri host. */
export function setFreebuffRuntimeForTests(next: FreebuffRuntime): void {
  runtime = next;
}

/**
 * Return a running Freebuff PTY the caller may control. A named session is the
 * only answer when it is running. Without one, only a session in the same
 * project qualifies: borrowing another project's terminal would restart that
 * conversation in this folder and change its model.
 */
export function getActiveFreebuffSessionId(
  preferredSessionId?: string,
  cwd?: string,
): string | null {
  const running = (live: Live | undefined): live is Live =>
    !!live && !live.cancelled && !live.stopping && live.exited === undefined;
  const preferred = preferredSessionId ? liveByThread.get(preferredSessionId) : undefined;
  if (running(preferred)) return preferred.sessionId;
  if (preferredSessionId) return null;
  const sessions = [...liveByThread.values()].filter(
    (live) => running(live) && (cwd == null || live.cwd === cwd),
  );
  return sessions[sessions.length - 1]?.sessionId ?? null;
}

/** Start the provider PTY through the same single-flight lifecycle used by sends. */
export function startFreebuffSession(input: HarnessSessionInput): Promise<void> {
  return ensureLive(input).then(() => undefined);
}

/** Read the selected model from the live Freebuff TUI, not a cached account value. */
export function getActiveFreebuffModel(
  sessionId?: string,
): Promise<{ name: string; effort: string } | null> {
  const target = sessionId ?? getActiveFreebuffSessionId();
  if (!target || !liveByThread.has(target)) return Promise.resolve(null);
  return withModelControlSubscription(() => child.requestFreebuffActiveModel(target));
}

/** Read model choices from the real /model screen of a running Freebuff PTY. */
export function listFreebuffModels(sessionId: string): Promise<FreebuffModel[]> {
  if (!sessionId || !liveByThread.has(sessionId)) {
    return Promise.reject(new Error("Start a Freebuff session in MonoCode to load its model choices."));
  }
  return withModelControlSubscription(() => child.requestFreebuffModelChoices(sessionId));
}

/** Ask the running Freebuff TUI to switch models and await its confirmation. */
export function selectFreebuffModel(
  sessionId: string,
  modelName: string,
): Promise<void> {
  if (!sessionId || !liveByThread.has(sessionId)) {
    return Promise.reject(new Error("Start this Freebuff session before changing its model."));
  }
  return withModelControlSubscription(
    () => child.requestFreebuffModelChange(sessionId, modelName),
  );
}

/** Test seam: drop every live/resume entry. */
export function resetFreebuffForTests(): void {
  for (const live of liveByThread.values()) {
    live.cancelled = true;
    live.turn?.resolve();
  }
  liveByThread.clear();
  startupByThread.clear();
  resumeByThread.clear();
  cancelledThreads.clear();
  modelControlSubscriberCount = 0;
  detachModelControl?.();
  detachModelControl = null;
  runtime = defaultRuntime;
}

function releaseModelControlSubscription(): void {
  modelControlSubscriberCount = Math.max(0, modelControlSubscriberCount - 1);
  if (modelControlSubscriberCount === 0) {
    detachModelControl?.();
    detachModelControl = null;
  }
}

function withModelControlSubscription<T>(request: () => Promise<T>): Promise<T> {
  ensureModelControlSubscription();
  modelControlSubscriberCount += 1;
  let pending: Promise<T>;
  try {
    pending = request();
  } catch (error) {
    releaseModelControlSubscription();
    return Promise.reject(error);
  }
  return pending.then(
    (result) => {
      releaseModelControlSubscription();
      return result;
    },
    (error: unknown) => {
      releaseModelControlSubscription();
      throw error;
    },
  );
}

/**
 * Diagnostic log for the boot path. It is deliberately bare: no tokens, no
 * credentials, no chat ids, no prompt text. Callers may swap this for a real
 * logger; tests can ignore it.
 */
export type FreebuffBootLog = (tag: string, detail: string) => void;
let freebuffBootLog: FreebuffBootLog = () => undefined;

export function setFreebuffBootLog(next: FreebuffBootLog): void {
  freebuffBootLog = next;
}

function logFreebuffBootDiagnostic(tag: string, detail: string): void {
  freebuffBootLog(tag, detail);
}

export async function sendFreebuffTurn(input: SendTurnInput): Promise<void> {
  // A cancel flag only suppresses the send that was in flight when the user
  // clicked stop; a later, new turn must still run.
  cancelledThreads.delete(input.sessionId);
  let live: Live;
  try {
    live = await ensureLive(input);
  } catch (error) {
    cancelledThreads.delete(input.sessionId);
    if (error instanceof FreebuffCancelledError) return;
    throw error;
  }
  if (cancelledThreads.delete(input.sessionId)) {
    await stopFreebuffSession(input.sessionId);
    return;
  }
  live.onEvent = input.onEvent;
  if (!live.startedNotified) {
    live.startedNotified = true;
    input.onEvent({ type: "session.providerBound", providerSessionId: live.chatId });
    input.onEvent({ type: "session.started" });
  }
  // The footer may have shown context before this listener was attached.
  if (live.context) input.onEvent({ type: "context", ...live.context });
  await runTurn(live, input);
}

export async function steerFreebuffTurn(
  _input: SteerTurnInput,
): Promise<void> {
  throw new TurnNotReadyError(
    "Freebuff does not accept a follow-up while it is working",
  );
}

export async function cancelFreebuffTurn(sessionId: string): Promise<void> {
  const live = liveByThread.get(sessionId);
  if (!live) {
    cancelledThreads.add(sessionId);
    await runtime.kill(sessionId).catch(() => undefined);
    return;
  }
  liveByThread.delete(sessionId);
  startupByThread.delete(sessionId);
  clearScreenPublish(live);
  live.screen.dispose();
  live.cancelled = true;
  live.bootReject?.(new FreebuffCancelledError());
  live.turn?.resolve();
  live.turn = undefined;
  runtime.unwatch(sessionId);
  await runtime.kill(sessionId).catch(() => undefined);
}

export async function stopFreebuffSession(sessionId: string): Promise<void> {
  const live = liveByThread.get(sessionId);
  liveByThread.delete(sessionId);
  startupByThread.delete(sessionId);
  cancelledThreads.delete(sessionId);
  if (!live) {
    await runtime.kill(sessionId).catch(() => undefined);
    return;
  }
  live.stopping = true;
  clearScreenPublish(live);
  live.screen.dispose();
  live.bootReject?.(new FreebuffCancelledError());
  live.turn?.resolve();
  live.turn = undefined;
  runtime.unwatch(sessionId);
  await runtime.kill(sessionId).catch(() => undefined);
}

export async function forgetFreebuffSession(sessionId: string): Promise<void> {
  resumeByThread.delete(sessionId);
  await stopFreebuffSession(sessionId);
}

/** Seed the conversation id a restored MonoCode session resumes. */
export function bindFreebuffSession(
  threadId: string,
  chatId: string,
  cwd: string,
): void {
  const id = chatId.trim();
  if (!threadId || !id || !cwd.trim()) return;
  resumeByThread.set(threadId, { chatId: id, cwd });
}

export function respondFreebuffApproval(
  _sessionId: string,
  _requestId: number,
  _decision: ApprovalDecision,
): void {
  // Freebuff confirms its own actions inside its terminal UI. MonoCode never
  // receives a permission request it could answer on the user's behalf.
}

export function respondFreebuffQuestion(
  _sessionId: string,
  _requestId: number,
  _reply: UserQuestionReply,
): void {
  // Same as approvals: questions are rendered by Freebuff itself.
}

function ensureLive(input: HarnessSessionInput): Promise<Live> {
  const existing = liveByThread.get(input.sessionId);
  if (
    existing &&
    existing.cwd === input.cwd &&
    existing.exited === undefined &&
    !existing.cancelled &&
    !existing.stopping
  ) {
    existing.onEvent = input.onEvent;
    return Promise.resolve(existing);
  }
  const pending = startupByThread.get(input.sessionId);
  if (pending) {
    return pending.then((live) => {
      live.onEvent = input.onEvent;
      return live;
    });
  }
  const startup = Promise.resolve().then(() => ensureLiveOnce(input));
  startupByThread.set(input.sessionId, startup);
  const clearStartup = () => {
    if (startupByThread.get(input.sessionId) === startup) {
      startupByThread.delete(input.sessionId);
    }
  };
  void startup.then(clearStartup, clearStartup);
  return startup;
}

async function ensureLiveOnce(input: HarnessSessionInput): Promise<Live> {
  const existing = liveByThread.get(input.sessionId);
  if (
    existing &&
    existing.cwd === input.cwd &&
    existing.exited === undefined &&
    !existing.cancelled &&
    !existing.stopping
  ) {
    existing.onEvent = input.onEvent;
    return existing;
  }
  if (existing) await stopFreebuffSession(input.sessionId);

  const resume = resumeByThread.get(input.sessionId);
  const canResume = resume != null && resume.cwd === input.cwd;
  if (resume && !canResume) resumeByThread.delete(input.sessionId);

  // Resolve before creating a chat folder, so a missing CLI leaves no trace.
  const { path } = await runtime.resolveBinary();
  logFreebuffBootDiagnostic("resolve", path);
  const chatId = canResume
    ? resume.chatId
    : await reserveChat(input.cwd);
  if (canResume) {
    // Recreate only what is missing; an existing transcript is never touched.
    try {
      await runtime.prepareChat(input.cwd, chatId);
    } catch (error) {
      logFreebuffBootDiagnostic(
        "prepareChat",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  ensureModelControlSubscription();
  const live: Live = {
    sessionId: input.sessionId,
    cwd: input.cwd,
    chatId,
    onEvent: input.onEvent,
    output: "",
    modelControlTail: "",
    modelControlBusy: false,
    startedNotified: false,
    contextKey: "",
    screen: new Terminal({ cols: 120, rows: 40, scrollback: 0 }),
    cancelled: false,
    stopping: false,
    bootWaiter: false,
    resolvedCommand: path,
    resolvedArgs: ["--cwd", input.cwd, "--continue", chatId],
  };
  liveByThread.set(input.sessionId, live);
  // Answer the terminal's own queries the way a real terminal does. Windows
  // ConPTY is created here with "inherit cursor": it asks for the cursor
  // position (ESC[6n) and paints nothing until it gets an answer, so without
  // this reply Freebuff's screen never appears. The emulator also answers
  // device-attribute probes the TUI sends at startup.
  live.screen.onData((reply) => {
    if (live.stopping || live.cancelled || live.exited !== undefined) return;
    void runtime.write(live.sessionId, freebuffTerminalReply(reply)).catch(() => undefined);
  });
  runtime.watch(
    input.sessionId,
    (data) => onPtyData(live, data),
    (code) => onPtyExit(live, code),
  );

  try {
    const spawnInput = {
      sessionId: input.sessionId,
      command: path,
      cwd: input.cwd,
      chatId,
      binaryPath: runtimeProviderBinaryPath("freebuff"),
    };
    logFreebuffBootDiagnostic("spawn", JSON.stringify({
      sessionId: spawnInput.sessionId,
      binaryPath: spawnInput.binaryPath,
    }));
    await runtime.spawn(spawnInput);
    await waitForBoot(live);
    if (
      live.cancelled ||
      live.stopping ||
      cancelledThreads.has(input.sessionId)
    ) {
      throw new FreebuffCancelledError();
    }
    // The prompt marker paints before the composer accepts keys, and its
    // welcome/ad/survey overlays do not take the keyboard. Measured against
    // 0.2.34: a paste in the marker's frame is dropped.
    await runtime.delay(FREEBUFF_BOOT_SETTLE_MS);
    if (live.stopping || live.cancelled) throw new FreebuffCancelledError();
  } catch (error) {
    logFreebuffBootDiagnostic(
      "bootFailed",
      error instanceof Error ? error.message : String(error),
    );
    if (
      live.cancelled ||
      live.stopping ||
      cancelledThreads.has(input.sessionId)
    ) {
      await stopFreebuffSession(input.sessionId);
      throw new FreebuffCancelledError();
    }
    await stopFreebuffSession(input.sessionId);
    throw error instanceof Error ? error : new Error(String(error));
  }

  resumeByThread.set(input.sessionId, { chatId, cwd: input.cwd });
  ensureModelControlSubscription();
  return live;
}

async function reserveChat(cwd: string): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const id = freebuffChatId(new Date(runtime.now()), attempt);
      const prepared = await runtime.prepareChat(cwd, id);
      if (prepared.created) return id;
    } catch (error) {
      logFreebuffBootDiagnostic(
        `reserveChat attempt ${attempt + 1} failed`,
        error instanceof Error ? error.message : String(error),
      );
      await runtime.delay(150);
    }
  }
  throw new Error("Could not reserve a Freebuff conversation id.");
}


function onPtyData(live: Live, data: string): void {
  live.output = (live.output + data).slice(-OUTPUT_TAIL_CHARS);
  live.screen.write(data, () => {
    if (live.stopping || live.cancelled) return;
    const buffer = live.screen.buffer.active;
    const rows: string[] = [];
    for (let row = 0; row < buffer.length; row += 1) {
      const line = buffer.getLine(row)?.translateToString(true) ?? "";
      rows.push(line);
    }
    live.modelControlTail = rows.join("\n");
    // ConPTY sends only changed cells, so the raw stream can lose letters of
    // the marker; the emulated screen always holds the whole prompt line.
    if (live.bootResolve && FREEBUFF_BOOT_MARKER.test(live.modelControlTail)) {
      live.bootResolve();
    }
    scheduleScreenPublish(live);
  });
  // A turn that never started can fail on a banner (quota, sign-in) instead of
  // opening a chat; report it now rather than waiting out the prompt timeout.
  const fresh = stripFreebuffAnsi(data);
  if (
    live.turn &&
    !live.turn.state.sawUser &&
    FREEBUFF_SESSION_ERROR.test(fresh)
  ) {
    const tail = freebuffPtyTail(live.output);
    live.turn.reject(
      new Error(
        `Freebuff could not start the session.${tail ? `\n\nLast Freebuff output: ${tail}` : ""}`,
      ),
    );
  }
  if (!live.bootResolve) return;
  if (FREEBUFF_BOOT_MARKER.test(stripFreebuffAnsi(live.output))) {
    live.bootResolve();
  }
}

function scheduleScreenPublish(live: Live): void {
  if (live.screenTimer) return;
  live.screenTimer = setTimeout(() => {
    live.screenTimer = undefined;
    if (live.stopping || live.cancelled || live.exited !== undefined) return;
    publishScreen(live);
  }, SCREEN_PUBLISH_MS);
}

/**
 * Show what Freebuff's own footer shows: the active model in the account and
 * picker views, and the conversation context in the session's context meter.
 * Only values Freebuff actually painted are reported.
 */
function publishScreen(live: Live): void {
  const screen = live.modelControlTail;
  if (!screen) return;
  observeFreebuffScreen(live.sessionId, screen);
  const read = parseFreebuffUsageScreen(screen);
  if (!read.context) return;
  const usage = freebuffContextUsage(read.context.label, read.context.percent);
  if (!usage) return;
  const key = `${usage.used}/${usage.window ?? ""}`;
  if (key === live.contextKey) return;
  live.contextKey = key;
  live.context = usage;
  if (live.startedNotified) live.onEvent({ type: "context", ...usage });
}

function clearScreenPublish(live: Live): void {
  if (live.screenTimer) clearTimeout(live.screenTimer);
  live.screenTimer = undefined;
  forgetFreebuffScreen(live.sessionId);
}

function onPtyExit(live: Live, code: number | null): void {
  clearScreenPublish(live);
  live.exited = code;
  if (live.bootWaiter && live.bootReject) {
    const diagnostic = freebuffBootDiagnostics(
      live.output,
      code,
      live.resolvedCommand,
      live.cwd,
      live.resolvedArgs,
    );
    const message = freebuffStartupError(live.output, code, FREEBUFF_BOOT_TIMEOUT_MS);
    live.bootReject(
      new Error(
        message + "\n\nFreebuff boot diagnostics: " + JSON.stringify(diagnostic),
      ),
    );
  }
  live.screen.dispose();
  if (!live.cancelled && !live.stopping) {
    live.onEvent({ type: "session.ended", code });
    live.turn?.reject(
      new Error(
        `Freebuff exited while the turn was running${code == null ? "" : ` (exit code ${code})`}.`,
      ),
    );
  }
  live.turn = undefined;
  if (liveByThread.get(live.sessionId) === live) {
    liveByThread.delete(live.sessionId);
  }
}

function waitForBoot(live: Live): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      live.bootWaiter = false;
      live.bootResolve = undefined;
      live.bootReject = undefined;
      // Free a stalled boot before the next turn on this thread, so a later
      // prompt does not inherit the abandoned boot’s waiters.
      live.output = "";
      if (error) reject(error);
      else resolve();
    };
    live.bootWaiter = true;
    live.bootResolve = () => finish();
    live.bootReject = (error) => finish(error);
    timer = setTimeout(
      () => {
        const diagnostic = freebuffBootDiagnostics(
          live.output,
          live.exited ?? null,
          live.resolvedCommand,
          live.cwd,
          live.resolvedArgs,
        );
        const message = freebuffStartupError(live.output, live.exited, FREEBUFF_BOOT_TIMEOUT_MS);
        finish(
          new Error(
            message +
              "\n\nFreebuff boot diagnostics: " +
              JSON.stringify(diagnostic),
          ),
        );
      },
      FREEBUFF_BOOT_TIMEOUT_MS,
    );
    // An exit that lands before the marker can never become ready; report it
    // now instead of waiting out the boot timeout.
    if (live.exited !== undefined) {
      const diagnostic = freebuffBootDiagnostics(
        live.output,
        live.exited,
        live.resolvedCommand,
        live.cwd,
        live.resolvedArgs,
      );
      const message = freebuffStartupError(live.output, live.exited, FREEBUFF_BOOT_TIMEOUT_MS);
      finish(
        new Error(
          message +
            "\n\nFreebuff boot diagnostics: " +
            JSON.stringify(diagnostic),
        ),
      );
      return;
    }
    if (
      FREEBUFF_BOOT_MARKER.test(stripFreebuffAnsi(live.output)) ||
      FREEBUFF_BOOT_MARKER.test(live.modelControlTail)
    ) {
      finish();
    }
  });
}

async function runTurn(live: Live, input: SendTurnInput): Promise<void> {
  const baseline = await readBaseline(live);
  const turnState = createFreebuffTurnState(baseline);
  const payload = freebuffPromptPayload(
    promptWithAttachments(input.text, input.attachments),
  );
  let resolveTurn!: () => void;
  let rejectTurn!: (error: Error) => void;
  const finished = new Promise<void>((resolve, reject) => {
    resolveTurn = resolve;
    rejectTurn = reject;
  });
  const turn: Turn = {
    state: turnState,
    settled: false,
    resolve: () => {
      if (turn.settled) return;
      turn.settled = true;
      resolveTurn();
    },
    reject: (error) => {
      if (turn.settled) return;
      turn.settled = true;
      rejectTurn(error);
    },
  };
  live.turn = turn;

  try {
    if (!payload) {
      input.onAccepted?.();
      return;
    }
    const prompt = promptWithAttachments(input.text, input.attachments);
    // Measure the echo against this turn only: the same words may already be
    // on screen (an earlier identical prompt in the chat history).
    const echoBaseline = countOccurrences(
      freebuffScreenText(live.modelControlTail),
      freebuffPromptEcho(prompt),
    );
    live.output = "";
    await runtime.write(live.sessionId, payload);
    // The composer echoing the paste is the only proof it accepted the text.
    const echoed = await waitForPromptEcho(live, prompt, echoBaseline);
    if (live.cancelled || live.stopping) throw new FreebuffCancelledError();
    if (!echoed) {
      throw new Error("Freebuff did not accept the pasted prompt. Please retry.");
    }
    await runtime.delay(FREEBUFF_PASTE_SETTLE_MS);
    if (live.cancelled || live.stopping) throw new FreebuffCancelledError();
    await runtime.write(live.sessionId, FREEBUFF_SUBMIT_KEY);
    input.onAccepted?.();
    void pollTurn(live, turn).catch((error: unknown) => {
      turn.reject(error instanceof Error ? error : new Error(String(error)));
    });
    await finished;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!live.cancelled && !live.stopping) {
      live.onEvent({ type: "session.error", message });
      // The TUI is left showing whatever failed (quota banner, dropped paste,
      // unknown turn). Reopen a clean one rather than typing into that state.
      await stopFreebuffSession(live.sessionId);
    }
    throw error;
  } finally {
    if (live.turn === turn) live.turn = undefined;
  }
}

async function readBaseline(live: Live): Promise<number> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const snapshot = await runtime.readChat(live.cwd, live.chatId);
      return snapshot.messages.length;
    } catch (error) {
      lastError = error;
      await runtime.delay(150);
    }
  }
  throw new Error(
    `Could not read the Freebuff conversation before sending: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function pollTurn(live: Live, turn: Turn): Promise<void> {
  const startedAt = runtime.now();
  while (!turn.settled) {
    if (live.cancelled || live.stopping) {
      turn.resolve();
      return;
    }
    if (live.exited !== undefined) {
      turn.reject(
        new Error(
          `Freebuff exited while the turn was running${
            live.exited == null ? "" : ` (exit code ${live.exited})`
          }.`,
        ),
      );
      return;
    }

    let snapshot: FreebuffChatSnapshot | null = null;
    try {
      snapshot = await runtime.readChat(live.cwd, live.chatId);
    } catch (error) {
      if (!isTransientTranscriptError(error)) {
        turn.reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
    if (snapshot) {
      const progress = freebuffTurnProgress(turn.state, snapshot);
      for (const event of progress.events) {
        if (live.cancelled || live.stopping) break;
        live.onEvent(event);
      }
      if (progress.complete) {
        turn.resolve();
        return;
      }
    }

    const elapsed = runtime.now() - startedAt;
    if (!turn.state.sawUser && elapsed > FREEBUFF_PROMPT_TIMEOUT_MS) {
      const tail = freebuffPtyTail(live.output);
      turn.reject(
        new Error(
          `Freebuff did not start the turn within ${Math.round(
            FREEBUFF_PROMPT_TIMEOUT_MS / 1000,
          )}s.${tail ? `\n\nLast Freebuff output: ${tail}` : ""}`,
        ),
      );
      return;
    }
    if (elapsed > FREEBUFF_TURN_TIMEOUT_MS) {
      turn.reject(
        new Error(
          `Freebuff did not finish the turn within ${Math.round(
            FREEBUFF_TURN_TIMEOUT_MS / 60_000,
          )} minutes.`,
        ),
      );
      return;
    }
    await runtime.delay(FREEBUFF_POLL_MS);
  }
}

async function waitForPromptEcho(
  live: Live,
  text: string,
  screenBaseline = 0,
): Promise<boolean> {
  const echo = freebuffPromptEcho(text);
  if (!echo) return true;
  // Terminal composers commonly fold a long paste into a placeholder such as
  // "[Pasted text #1 +20 lines]" instead of echoing it.
  const pasteBaseline = countOccurrences(
    freebuffScreenText(live.modelControlTail).toLowerCase(),
    "pasted",
  );
  const echoed = () => {
    const screen = freebuffScreenText(live.modelControlTail);
    return (
      stripFreebuffAnsi(live.output).includes(echo) ||
      countOccurrences(screen, echo) > screenBaseline ||
      countOccurrences(screen.toLowerCase(), "pasted") > pasteBaseline
    );
  };
  const attempts = Math.ceil(FREEBUFF_ECHO_TIMEOUT_MS / 50);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (live.cancelled || live.stopping || live.exited !== undefined) {
      // The boot already resolved, so a later exit is no longer silent.
      if (live.exited !== undefined) {
        const diagnostic = freebuffBootDiagnostics(
          live.output,
          live.exited ?? null,
          live.resolvedCommand,
          live.cwd,
          live.resolvedArgs,
        );
        const message = freebuffStartupError(
          live.output,
          live.exited,
          FREEBUFF_ECHO_TIMEOUT_MS,
        );
        const bootFailure = new Error(
          message + "\n\nFreebuff boot diagnostics: " + JSON.stringify(diagnostic),
        );
        live.onEvent({ type: "session.error", message: bootFailure.message });
        await stopFreebuffSession(live.sessionId).catch(() => undefined);
        throw bootFailure;
      }
      return false;
    }
    if (echoed()) return true;
    await runtime.delay(50);
  }
  return false;
}



function isTransientTranscriptError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /still writing|not valid JSON|unexpected end|EOF/i.test(message);
}

function promptWithAttachments(
  text: string,
  attachments: SendTurnInput["attachments"],
): string {
  const paths = (attachments ?? []).flatMap((attachment) =>
    attachment.path ? [attachment.path] : [],
  );
  if (paths.length === 0) return text;
  return [
    text,
    "",
    "Files attached in MonoCode (read them when the task needs them):",
    ...paths.map((path) => `- ${path}`),
  ].join("\n");
}

