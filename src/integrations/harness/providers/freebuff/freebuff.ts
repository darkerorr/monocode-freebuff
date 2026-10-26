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
  requestFreebuffActiveModel,
  type ChatId,
  type FreebuffChatSnapshot,
  type FreebuffModelChoice,
  type FreebuffSessionId,
} from "../../core/child";
import {
  wireFreebuffSessionForTurn,
  clearFreebuffTurnContext,
} from "../../../integrations/harness/core/availability";

type FreebuffTurn = { sessionId: string; cwd: string; chatId: ChatId };
let activeTurn: FreebuffTurn | null = null;

export function setActiveFreebuffTurn(turn: FreebuffTurn | null): void {
  activeTurn = turn;
}

export function getActiveFreebuffTurn(): FreebuffTurn | null {
  return activeTurn;
}

let liveByThread = new Map();
let startupByThread = new Map();
let activeFreebuffSessionId = (undefined as string | undefined);
let activeFreebuffModel = (undefined as { name: string; effort: string } | undefined);

function readSessionIdFromOutput(code: string): string | undefined {
  const match = /session[\s:=]+([a-z0-9\-]{20,80})/ui.exec(code);
  return match?.[1];
}

function currentActiveSessionId(): string | null {
  const ids = [...liveByThread.keys()];
  if (ids.length === 1) return ids[0];
  return readSessionIdFromOutput(activeFreebuffModel?.name ?? activeFreebuffSessionId ?? "") ?? null;
}

const resumeByThread = new Map();
const cancelledThreads = new Set();

let runtime: FreebuffRuntime = defaultRuntime;

let detachModelControl: (() => void) | null = null;
let modelControlSubscriberCount = 0;

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
  output: string;
  cancelled: boolean;
  stopping: boolean;
  exited?: number | null;
  bootResolve?: () => void;
  bootReject?: (error: Error) => void;
  bootWaiter: boolean;
  turn?: Turn;
  resolvedCommand: string;
  resolvedArgs: string[];
  modelControlTail: string;
  modelControlBusy: boolean;
  startedNotified: boolean;
  screen: Terminal;
};

type Resume = { chatId: string; cwd: string };

// ---------- freebuff.ts body ----------

export function getActiveFreebuffSessionId(sessionId?: string): string | null {
  const scope = sessionId ?? activeFreebuffSessionId;
  if (!scope) return null;
  if (liveByThread.has(scope)) return scope;
  return currentActiveSessionId();
}

function freebuffPtyTail(output: string): string {
  const cleaned = stripFreebuffAnsi(output);
  const lines = cleaned.split("\n").slice(-6);
  return lines.join("\n").trim();
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
    return pending.then((
      live: Live,
    ) => {
      live.onEvent = input.onEvent;
      return live;
    });
  }
  const startup = (async () => {
    return ensureLiveOnce(input);
  })();
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

  const { path } = await runtime.resolveBinary();
  logFreebuffBootDiagnostic("resolve", path);
  const chatId = canResume
    ? resume.chatId
    : await reserveChat(input.cwd);
  if (canResume) {
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
  try {
    const live: Live = {
      sessionId: input.sessionId,
      cwd: input.cwd,
      chatId,
      onEvent: input.onEvent,
      output: "",
      modelControlTail: "",
      modelControlBusy: false,
      startedNotified: false,
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

    const spawnInput = {
      sessionId: input.sessionId,
      command: path,
      cwd: input.cwd,
      chatId,
      binaryPath: runtimeProviderBinaryPath("freebuff"),
    };
    logFreebuffBootDiagnostic(
      "spawn",
      JSON.stringify({
        sessionId: spawnInput.sessionId,
        binaryPath: spawnInput.binaryPath,
      }),
    );
    await runtime.spawn(spawnInput);
    await waitForBoot(live);
    if (
      live.cancelled ||
      live.stopping ||
      cancelledThreads.has(input.sessionId)
    )
      throw new FreebuffCancelledError();
    await runtime.delay(FREEBUFF_BOOT_SETTLE_MS);
    if (live.stopping || live.cancelled)
      throw new FreebuffCancelledError();
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
  if (activeStartupGuard) {
    activeStartupGuard(live);
    activeStartupGuard = null;
  }

  resumeByThread.set(input.sessionId, { chatId, cwd: input.cwd });
  return live;
}

async function reserveChat(cwd: string): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const id = freebuffChatId(new Date(runtime.now()), attempt);
      const prepared = await runtime.prepareChat(cwd, id);
      if (prepared.created)
        return id;
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
  live.screen.write(
    data,
    () => {
      const buffer = live.screen.buffer.active;
      const rows: string[] = [];
      for (let row = 0; row < buffer.length; row += 1) {
        const line = buffer.getLine(row)?.translateToString(true) ?? "";
        rows.push(line);
      }
      live.modelControlTail = rows.join("\n");
    },
  );
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
  if (!live.bootResolve)
    return;
  if (FREEBUFF_BOOT_MARKER.test(stripFreebuffAnsi(live.output)))
    live.bootResolve();
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
    const message = freebuffStartupError(
      live.output,
      code,
      FREEBUFF_BOOT_TIMEOUT_MS,
    );
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
}

function waitForBoot(live: Live): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (done)
        return;
      done = true;
      if (timer)
        clearTimeout(timer);
      live.bootWaiter = false;
      live.bootResolve = undefined;
      live.bootReject = undefined;
      live.output = "";
      if (error)
        reject(error);
      else
        resolve();
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
        const message = freebuffStartupError(
          live.output,
          live.exited,
          FREEBUFF_BOOT_TIMEOUT_MS,
        );
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
    if (live.exited !== undefined) {
      const diagnostic = freebuffBootDiagnostics(
        live.output,
        live.exited,
        live.resolvedCommand,
        live.cwd,
        live.resolvedArgs,
      );
      const message = freebuffStartupError(
        live.output,
        live.exited,
        FREEBUFF_BOOT_TIMEOUT_MS,
      );
      finish(
        new Error(
          message +
          "\n\nFreebuff boot diagnostics: " +
          JSON.stringify(diagnostic),
        ),
      );
      return;
    }
    if (FREEBUFF_BOOT_MARKER.test(stripFreebuffAnsi(live.output)))
      finish();
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
      if (turn.settled)
        return;
      turn.settled = true;
      resolveTurn();
    },
    reject: (error) => {
      if (turn.settled)
        return;
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
    const prompt = promptWithAttachments(
      input.text,
      input.attachments,
    );
    await runtime.write(live.sessionId, payload);
    const echoed = await waitForPromptEcho(live, prompt);
    if (live.cancelled || live.stopping)
      throw new FreebuffCancelledError();
    if (!echoed)
      throw new Error("Freebuff did not accept the pasted prompt. Please retry.");
    await runtime.delay(FREEBUFF_PASTE_SETTLE_MS);
    if (live.cancelled || live.stopping)
      throw new FreebuffCancelledError();
    await runtime.write(live.sessionId, FREEBUFF_SUBMIT_KEY);
    input.onAccepted?.();
    void pollTurn(live, turn).catch((error: unknown) => {
      turn.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
    await finished;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!live.cancelled && !live.stopping) {
      live.onEvent({ type: "session.error", message });
      await stopFreebuffSession(live.sessionId);
    }
    throw error;
  } finally {
    if (live.turn === turn)
      live.turn = undefined;
  }
}

async function readBaseline(live: Live): Promise<number> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const snapshot = await runtime.readChat(
        live.cwd,
        live.chatId,
      );
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
      snapshot = await runtime.readChat(
        live.cwd,
        live.chatId,
      );
    } catch (error) {
      if (!isTransientTranscriptError(error)) {
        turn.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
        return;
      }
    }
    if (snapshot) {
      const progress = freebuffTurnProgress(
        turn.state,
        snapshot,
      );
      for (const event of progress.events) {
        if (live.cancelled || live.stopping)
          break;
        live.onEvent(event);
      }
      if (progress.complete) {
        turn.resolve();
        return;
      }
    }

    const elapsed = runtime.now() - startedAt;
    if (
      !turn.state.sawUser && elapsed > FREEBUFF_PROMPT_TIMEOUT_MS
    ) {
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
  if (!echo)
    return true;
  const attempts = Math.ceil(FREEBUFF_ECHO_TIMEOUT_MS / 50);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (live.cancelled || live.stopping || live.exited !== undefined) {
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
        live.onEvent({
          type: "session.error",
          message: bootFailure.message,
        });
        await stopFreebuffSession(live.sessionId).catch(() => undefined);
        throw bootFailure;
      }
      return false;
    }
    if (stripFreebuffAnsi(live.output).includes(echo))
      return true;
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
  const paths = (attachments ?? [])
    .flatMap((attachment) =>
      attachment.path ? [attachment.path] : [],
    );
  if (paths.length === 0)
    return text;
  return [
    text,
    "",
    "Files attached in MonoCode (read them when the task needs them):",
    ...paths.map((path) => `- ${path}`),
  ].join("\n");
}

// ---------- end body ----------

void waitForBoot(live).finally(() => {
  if (
    live.cancelled ||
    live.stopping ||
    cancelledThreads.has(input.sessionId)
  )
    return;
  activeFreebuffSessionId = input.sessionId;
  if (liveByThread.get(input.sessionId)) {
    activeFreebuffModel = parseFreebuffUsageScreen(live.modelControlTail || live.output).model;
    activeFreebuffBootMarkerSeenAt = Date.now();
  }
});

resumeByThread.set(input.sessionId, { chatId, cwd: input.cwd });
return live;
}

async function reserveChat(cwd: string): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const id = freebuffChatId(new Date(runtime.now()), attempt);
      const prepared = await runtime.prepareChat(cwd, id);
      if (prepared.created)
        return id;
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
  live.screen.write(
    data,
    () => {
      const buffer = live.screen.buffer.active;
      const rows: string[] = [];
      for (let row = 0; row < buffer.length; row += 1) {
        const line = buffer.getLine(row)?.translateToString(true) ?? "";
        rows.push(line);
      }
      live.modelControlTail = rows.join("\n");
    },
  );
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
  if (!live.bootResolve)
    return;
  if (FREEBUFF_BOOT_MARKER.test(stripFreebuffAnsi(live.output)))
    live.bootResolve();
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
    const message = freebuffStartupError(
      live.output,
      code,
      FREEBUFF_BOOT_TIMEOUT_MS,
    );
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
}

function waitForBoot(live: Live): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (done)
        return;
      done = true;
      if (timer)
        clearTimeout(timer);
      live.bootWaiter = false;
      live.bootResolve = undefined;
      live.bootReject = undefined;
      live.output = "";
      if (error)
        reject(error);
      else
        resolve();
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
        const message = freebuffStartupError(
          live.output,
          live.exited,
          FREEBUFF_BOOT_TIMEOUT_MS,
        );
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
    if (live.exited !== undefined) {
      const diagnostic = freebuffBootDiagnostics(
        live.output,
        live.exited,
        live.resolvedCommand,
        live.cwd,
        live.resolvedArgs,
      );
      const message = freebuffStartupError(
        live.output,
        live.exited,
        FREEBUFF_BOOT_TIMEOUT_MS,
      );
      finish(
        new Error(
          message +
          "\n\nFreebuff boot diagnostics: " +
          JSON.stringify(diagnostic),
        ),
      );
      return;
    }
    if (FREEBUFF_BOOT_MARKER.test(stripFreebuffAnsi(live.output)))
      finish();
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
      if (turn.settled)
        return;
      turn.settled = true;
      resolveTurn();
    },
    reject: (error) => {
      if (turn.settled)
        return;
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
    const prompt = promptWithAttachments(
      input.text,
      input.attachments,
    );
    await runtime.write(live.sessionId, payload);
    const echoed = await waitForPromptEcho(live, prompt);
    if (live.cancelled || live.stopping)
      throw new FreebuffCancelledError();
    if (!echoed)
      throw new Error("Freebuff did not accept the pasted prompt. Please retry.");
    await runtime.delay(FREEBUFF_PASTE_SETTLE_MS);
    if (live.cancelled || live.stopping)
      throw new FreebuffCancelledError();
    await runtime.write(live.sessionId, FREEBUFF_SUBMIT_KEY);
    input.onAccepted?.();
    void pollTurn(live, turn).catch((error: unknown) => {
      turn.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
    await finished;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!live.cancelled && !live.stopping) {
      live.onEvent({ type: "session.error", message });
      await stopFreebuffSession(live.sessionId);
    }
    throw error;
  } finally {
    if (live.turn === turn)
      live.turn = undefined;
  }
}

async function readBaseline(live: Live): Promise<number> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const snapshot = await runtime.readChat(
        live.cwd,
        live.chatId,
      );
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
      snapshot = await runtime.readChat(
        live.cwd,
        live.chatId,
      );
    } catch (error) {
      if (!isTransientTranscriptError(error)) {
        turn.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
        return;
      }
    }
    if (snapshot) {
      const progress = freebuffTurnProgress(
        turn.state,
        snapshot,
      );
      for (const event of progress.events) {
        if (live.cancelled || live.stopping)
          break;
        live.onEvent(event);
      }
      if (progress.complete) {
        turn.resolve();
        return;
      }
    }

    const elapsed = runtime.now() - startedAt;
    if (
      !turn.state.sawUser && elapsed > FREEBUFF_PROMPT_TIMEOUT_MS
    ) {
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
  if (!echo)
    return true;
  const attempts = Math.ceil(FREEBUFF_ECHO_TIMEOUT_MS / 50);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (live.cancelled || live.stopping || live.exited !== undefined) {
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
        live.onEvent({
          type: "session.error",
          message: bootFailure.message,
        });
        await stopFreebuffSession(live.sessionId).catch(() => undefined);
        throw bootFailure;
      }
      return false;
    }
    if (stripFreebuffAnsi(live.output).includes(echo))
      return true;
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
  const paths = (attachments ?? [])
    .flatMap((attachment) =>
      attachment.path ? [attachment.path] : [],
    );
  if (paths.length === 0)
    return text;
  return [
    text,
    "",
    "Files attached in MonoCode (read them when the task needs them):",
    ...paths.map((path) => `- ${path}`),
  ].join("\n");
}// ---------- end body ----------
export async function getActiveFreebuffModel(sessionId?: string): Promise<{ name: string; effort: string } | null> {
  const target = sessionId ?? getActiveFreebuffSessionId();
  if (!target) return Promise.resolve(null);
  return child.requestFreebuffActiveModel(target);
}
export async function sendFreebuffTurn(input: SendTurnInput): Promise<void> {
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
    wireFreebuffSessionForTurn(input.sessionId, live.cwd, live.chatId, {
      messages: [],
      mtimeMs: 0,
      size: 0,
    } as FreebuffChatSnapshot);
    input.onEvent({ type: "session.providerBound", providerSessionId: live.chatId });
    input.onEvent({ type: "session.started" });
  }
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

