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
  createFreebuffTurnState,
  freebuffBootDiagnostics,
  freebuffChatId,
  freebuffPromptEcho,
  freebuffPromptPayload,
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
  screen: Terminal;
};

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

let runtime: FreebuffRuntime = defaultRuntime;

const liveByThread = new Map<string, Live>();
const resumeByThread = new Map<string, Resume>();
const cancelledThreads = new Set<string>();
const OUTPUT_TAIL_CHARS = 32_000;

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
    const choices = await waitForModelChoices(live, 4_000);
    if (request.action === "list") {
      await closeModelPicker(live);
      pickerOpened = false;
      recordFreebuffModelControl(live.sessionId, choices);
      request.resolve(choices);
      return;
    }

    const target = request.data;
    const selected = choices.find((item) => item.selected);
    const match = choices.find((item) => item.name === target);
    if (!match) {
      throw new Error(`Freebuff does not currently offer the model “${target}”.`);
    }
    if (selected?.name === target) {
      await closeModelPicker(live);
      pickerOpened = false;
      recordFreebuffModelControl(live.sessionId, choices, {
        name: selected.name,
        effort: selected.effort ?? "",
      });
      request.resolve();
      return;
    }
    const selectedIndex = choices.findIndex((item) => item.name === target);
    const activeIndex = choices.findIndex((item) => item.selected);
    if (selectedIndex < 0 || activeIndex < 0) {
      throw new Error("Freebuff's current model-picker selection could not be confirmed.");
    }
    // Move relative to the observed selected option. Each key is followed by
    // a fresh screen parse, never a guessed model-row position.
    let currentIndex = activeIndex;
    const direction = selectedIndex >= currentIndex ? 1 : -1;
    const steps = Math.abs(selectedIndex - currentIndex);
    for (let index = 0; index < steps; index += 1) {
      const previousTail = live.modelControlTail;
      await runtime.write(live.sessionId, direction > 0 ? "\u001b[B" : "\u001b[A");
      const next = await waitForSelectedPickerModel(live, 1_500, previousTail);
      const nextIndex = choices.findIndex((item) => item.name === next);
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
    if (after?.name !== target || (before?.name === target && selected?.name !== target)) {
      throw new Error("Freebuff did not confirm the requested active model.");
    }
    recordFreebuffModelControl(live.sessionId, choices, after);
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
  await runtime.write(live.sessionId, `${data}\r`);
  await waitForText(live, marker, timeoutMs);
}

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

/** Return a running Freebuff PTY, preferring the session whose picker is open. */
export function getActiveFreebuffSessionId(preferredSessionId?: string): string | null {
  const preferred = preferredSessionId ? liveByThread.get(preferredSessionId) : null;
  if (preferred && !preferred.cancelled && !preferred.stopping && preferred.exited === undefined) {
    return preferred.sessionId;
  }
  const sessions = [...liveByThread.values()].filter(
    (live) => !live.cancelled && !live.stopping && live.exited === undefined,
  );
  return sessions[sessions.length - 1]?.sessionId ?? null;
}

/** Read model choices from the real /model screen of a running Freebuff PTY. */
export function listFreebuffModels(sessionId: string): Promise<FreebuffModel[]> {
  if (!sessionId || !liveByThread.has(sessionId)) {
    return Promise.reject(new Error("Start a Freebuff session in MonoCode to load its model choices."));
  }
  ensureModelControlSubscription();
  modelControlSubscriberCount += 1;
  return child.requestFreebuffModelChoices(sessionId).then((models) => {
    modelControlSubscriberCount = Math.max(0, modelControlSubscriberCount - 1);
    if (modelControlSubscriberCount === 0) {
      detachModelControl?.();
      detachModelControl = null;
    }
    return models;
  }, (error: unknown) => {
    modelControlSubscriberCount = Math.max(0, modelControlSubscriberCount - 1);
    if (modelControlSubscriberCount === 0) {
      detachModelControl?.();
      detachModelControl = null;
    }
    throw error;
  });
}

/** Ask the running Freebuff TUI to switch models and await its confirmation. */
export function selectFreebuffModel(
  sessionId: string,
  modelName: string,
): Promise<void> {
  if (!sessionId || !liveByThread.has(sessionId)) {
    return Promise.reject(new Error("Start this Freebuff session before changing its model."));
  }
  ensureModelControlSubscription();
  modelControlSubscriberCount += 1;
  return child.requestFreebuffModelChange(sessionId, modelName).then(() => {
    modelControlSubscriberCount = Math.max(0, modelControlSubscriberCount - 1);
    if (modelControlSubscriberCount === 0) {
      detachModelControl?.();
      detachModelControl = null;
    }
  }, (error: unknown) => {
    modelControlSubscriberCount = Math.max(0, modelControlSubscriberCount - 1);
    if (modelControlSubscriberCount === 0) {
      detachModelControl?.();
      detachModelControl = null;
    }
    throw error;
  });
}

/** Test seam: drop every live/resume entry. */
export function resetFreebuffForTests(): void {
  for (const live of liveByThread.values()) {
    live.cancelled = true;
    live.turn?.resolve();
  }
  liveByThread.clear();
  resumeByThread.clear();
  cancelledThreads.clear();
  modelControlSubscriberCount = 0;
  detachModelControl?.();
  detachModelControl = null;
  runtime = defaultRuntime;
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
  cancelledThreads.delete(sessionId);
  if (!live) {
    await runtime.kill(sessionId).catch(() => undefined);
    return;
  }
  live.stopping = true;
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

async function ensureLive(input: HarnessSessionInput): Promise<Live> {
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
    screen: new Terminal({ cols: 120, rows: 40, scrollback: 0 }),
    cancelled: false,
    stopping: false,
    bootWaiter: false,
    resolvedCommand: path,
    resolvedArgs: ["--cwd", input.cwd, "--continue", chatId],
  };
  liveByThread.set(input.sessionId, live);
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
  live.onEvent({ type: "session.providerBound", providerSessionId: chatId });
  live.onEvent({ type: "session.started" });
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
    const buffer = live.screen.buffer.active;
    const rows: string[] = [];
    for (let row = 0; row < buffer.length; row += 1) {
      const line = buffer.getLine(row)?.translateToString(true) ?? "";
      rows.push(line);
    }
    live.modelControlTail = rows.join("\n");
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

function onPtyExit(live: Live, code: number | null): void {
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
    if (FREEBUFF_BOOT_MARKER.test(stripFreebuffAnsi(live.output))) finish();
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
    await runtime.write(live.sessionId, payload);
    // The composer echoing the paste is the only proof it accepted the text.
    const echoed = await waitForPromptEcho(live, prompt);
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

async function waitForPromptEcho(live: Live, text: string): Promise<boolean> {
  const echo = freebuffPromptEcho(text);
  if (!echo) return true;
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
    if (stripFreebuffAnsi(live.output).includes(echo)) return true;
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

