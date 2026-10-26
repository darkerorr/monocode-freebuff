import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  runtimeProviderBinaryPath,
  type ConfigurableBinaryProvider,
} from "../../../features/providers/model/providerBinaryPaths";

/** Process I/O is supplied by the desktop or a headless host. Provider
 * protocols never need to know which process owns their children. */
export interface ChildBackend {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(
    event: string,
    handler: (event: { payload: T }) => void,
  ): Promise<UnlistenFn>;
}

let backend: ChildBackend | undefined;

export function configureChildBackend(next: ChildBackend): void {
  if (bridge || users)
    throw new Error("Configure the child backend before starting the bridge");
  backend = next;
}

export function hasHeadlessChildBackend(): boolean {
  return backend !== undefined;
}

/** Provider-owned transcript files are read on the machine running the child. */
export function readHarnessTextFile(path: string): Promise<string> {
  return invoke<string>(backend ? "harness_read_text_file" : "read_text_file", {
    path,
  });
}

export function prepareMonoCodexStore(
  providerAccountId?: string,
  threadId?: string,
): Promise<{ home: string; hasThread: boolean }> {
  return invoke("codex_mono_store_prepare", { providerAccountId, threadId });
}

export function copyMonoCodexThreads(
  providerAccountId: string | undefined,
  threadId: string,
  paths: string[],
  sqliteHome?: string,
): Promise<void> {
  return invoke("codex_mono_store_copy", {
    providerAccountId,
    threadId,
    paths,
    sqliteHome,
  });
}

/** Copy a native Claude or Codex conversation into another account's home,
 * so that account resumes the same provider session id. */
export function transferProviderSession(
  provider: "claude" | "codex",
  fromAccountId: string | undefined,
  toAccountId: string | undefined,
  providerSessionId: string,
): Promise<void> {
  return invoke("provider_session_transfer", {
    provider,
    fromAccountId,
    toAccountId,
    providerSessionId,
  });
}

export function restoreMonoCodexAgentState(
  providerAccountId: string | undefined,
  threadId: string,
): Promise<void> {
  return invoke("codex_mono_store_restore_agent_state", {
    providerAccountId,
    threadId,
  });
}

function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return backend
    ? backend.invoke<T>(command, args)
    : tauriInvoke<T>(command, args);
}

function listen<T>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<UnlistenFn> {
  return backend ? backend.listen(event, handler) : tauriListen(event, handler);
}

type LinePayload = { sessionId: string; line: string };
// The desktop batches a frame's stdout lines and SSE events into one event;
// the remote host still sends them one at a time.
type LinesPayload = LinePayload | { sessionId: string; lines: string[] };
type ExitPayload = { sessionId: string; code: number | null; pid?: number };
type SsePayload =
  { sessionId: string; data: string } | { sessionId: string; events: string[] };
type SseEndPayload = { sessionId: string; error?: string | null };

type LineHandler = (line: string) => void;
type ExitHandler = (code: number | null) => void;

/** Freebuff's terminal UI is driven through a private PTY, not line JSON. */
export type FreebuffPtyData = { sessionId: string; data: string };
export type FreebuffPtyExit = {
  sessionId: string;
  code: number | null;
  pid?: number;
};

export type FreebuffPtyEvent =
  | { kind: "data"; sessionId: string; data: string }
  | { kind: "exit"; sessionId: string; code: number | null };

export type FreebuffPtySubscriber = (event: FreebuffPtyEvent) => void;

const freebuffPtySubscribers = new Set<FreebuffPtySubscriber>();
const freebuffPtyReplay = new Map<string, string>();
const MAX_FREEBUFF_REPLAY_CHARS = 64_000;

/** Subscribe to active Freebuff PTYs and replay their bounded current screen. */
export function subscribeFreebuffPty(
  subscriber: FreebuffPtySubscriber,
): () => void {
  freebuffPtySubscribers.add(subscriber);
  for (const [sessionId, data] of freebuffPtyReplay) {
    subscriber({ kind: "data", sessionId, data });
  }
  return () => freebuffPtySubscribers.delete(subscriber);
}

type SseHandler = (data: string) => void;
type SseEndHandler = (error?: string) => void;

const lineHandlers = new Map<string, LineHandler>();
const exitHandlers = new Map<string, ExitHandler>();
const lineBuffer = new Map<string, string[]>();
const stderrHandlers = new Map<string, LineHandler>();
const sseHandlers = new Map<string, SseHandler>();
const sseEndHandlers = new Map<string, SseEndHandler>();
const sseBuffer = new Map<string, string[]>();
const freebuffPtyHandlers = new Map<string, (data: string) => void>();
const freebuffPtyExitHandlers = new Map<string, ExitHandler>();
const freebuffPtyBuffer = new Map<string, string[]>();
const freebuffPendingExit = new Map<string, number | null>();
// Output is broadcast to every window. Only ids this window spawned or opened
// may buffer while unwatched; anything else would be held until the bridge
// is torn down, since nothing here ever watches or unwatches it.
const ownedChildren = new Set<string>();
const ownedSse = new Set<string>();
const livePid = new Map<string, number>();
const pendingExit = new Map<
  string,
  Array<{ code: number | null; pid: number }>
>();

/** True when this exit belongs to the child we currently have spawned. */
export function isCurrentChildExit(
  expectedPid: number | undefined,
  exitedPid: number | undefined,
): boolean {
  if (expectedPid == null || expectedPid <= 0) return false;
  if (exitedPid == null || exitedPid <= 0) return false;
  return exitedPid === expectedPid;
}

const MAX_BUFFERED = 1000;
let bridge: Promise<UnlistenFn[]> | null = null;
let bridgeAttempt: symbol | null = null;
let users = 0;
let teardownTimer: ReturnType<typeof setTimeout> | undefined;

function pushBounded(
  map: Map<string, string[]>,
  sessionId: string,
  item: string,
) {
  const queued = map.get(sessionId) ?? [];
  queued.push(item);
  if (queued.length > MAX_BUFFERED) {
    queued.splice(0, queued.length - MAX_BUFFERED);
  }
  map.set(sessionId, queued);
}

function ensureBridge() {
  if (bridge) return;
  let failed = false;
  const installed: UnlistenFn[] = [];
  const register = (pending: Promise<UnlistenFn>) =>
    pending.then((unlisten) => {
      if (failed) {
        unlisten();
        return () => undefined;
      }
      installed.push(unlisten);
      return unlisten;
    });
  const attempt = Symbol("bridge-installation");
  bridgeAttempt = attempt;
  const installation = Promise.all([
    register(
      listen<LinesPayload>("harness-stdout", (event) => {
        const { payload } = event;
        const { sessionId } = payload;
        const lines = "lines" in payload ? payload.lines : [payload.line];
        for (const line of lines) {
          // A handler may detach mid-batch; later lines follow the old path.
          const handler = lineHandlers.get(sessionId);
          if (handler) handler(line);
          else if (ownedChildren.has(sessionId)) {
            pushBounded(lineBuffer, sessionId, line);
          }
        }
      }),
    ),
    register(
      listen<LinePayload>("harness-stderr", (event) => {
        const { sessionId, line } = event.payload;
        stderrHandlers.get(sessionId)?.(line);
      }),
    ),
    register(
      listen<ExitPayload>("harness-exit", (event) => {
        const { sessionId, code, pid } = event.payload;
        const handler = exitHandlers.get(sessionId);
        if (!handler || pid == null || pid <= 0) return;
        const currentPid = livePid.get(sessionId);
        if (isCurrentChildExit(currentPid, pid)) {
          livePid.delete(sessionId);
          handler(code);
          return;
        }
        if (currentPid != null) return;
        const exits = pendingExit.get(sessionId) ?? [];
        exits.push({ code, pid });
        if (exits.length > 8) exits.splice(0, exits.length - 8);
        pendingExit.set(sessionId, exits);
      }),
    ),
    register(
      listen<SsePayload>("harness-sse", (event) => {
        const { payload } = event;
        const { sessionId } = payload;
        const events = "events" in payload ? payload.events : [payload.data];
        for (const data of events) {
          const handler = sseHandlers.get(sessionId);
          if (handler) handler(data);
          else if (ownedSse.has(sessionId)) {
            pushBounded(sseBuffer, sessionId, data);
          }
        }
      }),
    ),
    register(
      listen<SseEndPayload>("harness-sse-end", (event) => {
        const { sessionId, error } = event.payload;
        sseEndHandlers.get(sessionId)?.(error ?? undefined);
      }),
    ),
    register(
      listen<FreebuffPtyData>("harness-freebuff-pty", (event) => {
        const { sessionId, data } = event.payload;
        if (ownedChildren.has(sessionId) || freebuffPtySubscribers.size > 0) {
          const replay = `${freebuffPtyReplay.get(sessionId) ?? ""}${data}`;
          freebuffPtyReplay.set(
            sessionId,
            replay.slice(-MAX_FREEBUFF_REPLAY_CHARS),
          );
        }
        for (const subscriber of freebuffPtySubscribers) {
          subscriber({ kind: "data", sessionId, data });
        }
        const handler = freebuffPtyHandlers.get(sessionId);
        if (handler) handler(data);
        else if (ownedChildren.has(sessionId)) {
          pushBounded(freebuffPtyBuffer, sessionId, data);
        }
      }),
    ),
    register(
      listen<FreebuffPtyExit>("harness-freebuff-exit", (event) => {
        const { sessionId, code } = event.payload;
        freebuffPtyReplay.delete(sessionId);
        for (const subscriber of freebuffPtySubscribers) {
          subscriber({ kind: "exit", sessionId, code });
        }
        const handler = freebuffPtyExitHandlers.get(sessionId);
        if (handler) handler(code);
        else if (ownedChildren.has(sessionId)) {
          freebuffPendingExit.set(sessionId, code);
        }
      }),
    ),
  ]).catch((error: unknown) => {
    failed = true;
    installed.splice(0).forEach((unlisten) => unlisten());
    if (bridgeAttempt === attempt) {
      bridge = null;
      bridgeAttempt = null;
    }
    throw error;
  });
  void installation.catch(() => undefined);
  bridge = installation;
}

function teardownBridge() {
  const pending = bridge;
  bridge = null;
  bridgeAttempt = null;
  lineHandlers.clear();
  exitHandlers.clear();
  lineBuffer.clear();
  stderrHandlers.clear();
  sseHandlers.clear();
  sseEndHandlers.clear();
  sseBuffer.clear();
  freebuffPtyHandlers.clear();
  freebuffPtyExitHandlers.clear();
  freebuffPtyBuffer.clear();
  freebuffPendingExit.clear();
  freebuffPtyReplay.clear();
  ownedChildren.clear();
  ownedSse.clear();
  livePid.clear();
  pendingExit.clear();
  void pending?.then((fns) => fns.forEach((fn) => fn())).catch(() => undefined);
}

export function startHarnessBridge(): () => void {
  users += 1;
  if (teardownTimer) {
    clearTimeout(teardownTimer);
    teardownTimer = undefined;
  }
  ensureBridge();
  return () => {
    users -= 1;
    if (users > 0) return;
    users = 0;
    teardownTimer = setTimeout(() => {
      teardownTimer = undefined;
      if (users === 0) teardownBridge();
    }, 0);
  };
}

export async function acquireHarnessBridge(): Promise<() => void> {
  const release = startHarnessBridge();
  const installation = bridge;
  try {
    await installation;
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    users = 0;
    if (teardownTimer) {
      clearTimeout(teardownTimer);
      teardownTimer = undefined;
    }
    teardownBridge();
  });
}

export function watchChild(
  sessionId: string,
  onLine: LineHandler,
  onExit: ExitHandler,
  onStderr?: LineHandler,
) {
  const queued = lineBuffer.get(sessionId);
  lineBuffer.delete(sessionId);
  lineHandlers.set(sessionId, onLine);
  exitHandlers.set(sessionId, onExit);
  if (onStderr) stderrHandlers.set(sessionId, onStderr);
  if (queued) queued.forEach(onLine);
}

export function unwatchChild(sessionId: string) {
  lineHandlers.delete(sessionId);
  exitHandlers.delete(sessionId);
  lineBuffer.delete(sessionId);
  ownedChildren.delete(sessionId);
  stderrHandlers.delete(sessionId);
  pendingExit.delete(sessionId);
}

export function watchSse(
  sessionId: string,
  onData: SseHandler,
  onEnd?: SseEndHandler,
) {
  const queued = sseBuffer.get(sessionId);
  sseBuffer.delete(sessionId);
  sseHandlers.set(sessionId, onData);
  if (onEnd) sseEndHandlers.set(sessionId, onEnd);
  if (queued) queued.forEach(onData);
}

export function unwatchSse(sessionId: string) {
  sseHandlers.delete(sessionId);
  sseEndHandlers.delete(sessionId);
  sseBuffer.delete(sessionId);
  ownedSse.delete(sessionId);
}

/**
 * Watch one Freebuff PTY. Output produced between spawn and this call is
 * replayed, so a TUI that greets the user immediately is not missed.
 */
export function watchFreebuffPty(
  sessionId: string,
  onData: (data: string) => void,
  onExit: ExitHandler,
): void {
  const buffered = freebuffPtyBuffer.get(sessionId);
  freebuffPtyBuffer.delete(sessionId);
  freebuffPtyHandlers.set(sessionId, onData);
  freebuffPtyExitHandlers.set(sessionId, onExit);
  if (buffered) buffered.forEach(onData);
  const exit = freebuffPendingExit.get(sessionId);
  if (exit !== undefined) {
    freebuffPendingExit.delete(sessionId);
    onExit(exit);
  }
}

export function unwatchFreebuffPty(sessionId: string): void {
  freebuffPtyHandlers.delete(sessionId);
  freebuffPtyExitHandlers.delete(sessionId);
  freebuffPtyBuffer.delete(sessionId);
  freebuffPendingExit.delete(sessionId);
}

export async function spawnChild(
  sessionId: string,
  command: string,
  args: string[],
  cwd: string,
  account?: { provider: "claude" | "codex"; id: string },
  binaryProvider?: ConfigurableBinaryProvider,
  codexStore?: "mono",
  /** `devin acp` only: start with an approval rule for every edit. */
  devinAskEdits?: boolean,
): Promise<void> {
  livePid.delete(sessionId);
  pendingExit.delete(sessionId);
  ownedChildren.add(sessionId);
  const binaryPath = binaryProvider
    ? runtimeProviderBinaryPath(binaryProvider)
    : undefined;
  const pid = await invoke<number>("harness_spawn", {
    sessionId,
    command,
    args,
    cwd,
    account,
    binaryProvider,
    binaryPath,
    ...(codexStore ? { codexStore } : {}),
    ...(devinAskEdits ? { devinAskEdits } : {}),
  });
  if (typeof pid !== "number" || pid <= 0) return;
  livePid.set(sessionId, pid);
  const exits = pendingExit.get(sessionId);
  pendingExit.delete(sessionId);
  const exited = exits?.find((event) => event.pid === pid);
  if (!exited) return;
  livePid.delete(sessionId);
  exitHandlers.get(sessionId)?.(exited.code);
}

export function writeChild(sessionId: string, line: string): Promise<void> {
  return invoke("harness_write", { sessionId, line });
}

export function killChild(sessionId: string): Promise<void> {
  livePid.delete(sessionId);
  pendingExit.delete(sessionId);
  unwatchChild(sessionId);
  return invoke("harness_kill", { sessionId });
}

export function killAllChildren(): Promise<void> {
  lineHandlers.clear();
  exitHandlers.clear();
  lineBuffer.clear();
  stderrHandlers.clear();
  sseHandlers.clear();
  sseEndHandlers.clear();
  sseBuffer.clear();
  ownedChildren.clear();
  ownedSse.clear();
  livePid.clear();
  pendingExit.clear();
  return invoke("harness_kill_all");
}

type ResolvedHarnessBinary = { path: string; args?: string[] };

async function resolveHarnessBinary(
  provider: ConfigurableBinaryProvider,
  binaryPath?: string | null,
): Promise<ResolvedHarnessBinary> {
  const configuredPath =
    binaryPath === undefined
      ? runtimeProviderBinaryPath(provider)
      : binaryPath?.trim();
  if (configuredPath) {
    return invoke("harness_resolve_configured", {
      provider,
      binaryPath: configuredPath,
    });
  }
  const command: Record<ConfigurableBinaryProvider, string> = {
    claude: "harness_resolve_claude",
    codex: "harness_resolve_codex",
    cursor: "harness_resolve_cursor",
    grok: "harness_resolve_grok",
    opencode: "harness_resolve_opencode",
    pi: "harness_resolve_pi",
    omp: "harness_resolve_omp",
    fx: "harness_resolve_fx",
    hermes: "harness_resolve_hermes",
    antigravity: "harness_resolve_antigravity",
    devin: "harness_resolve_devin",
    freebuff: "harness_resolve_freebuff",
  };
  return invoke(command[provider]);
}

export function resolveCursorBinary(
  binaryPath?: string | null,
): Promise<{ path: string }> {
  return resolveHarnessBinary("cursor", binaryPath);
}

export function resolveCodexBinary(
  binaryPath?: string | null,
): Promise<{ path: string }> {
  return resolveHarnessBinary("codex", binaryPath);
}

export function resolveOpenCodeBinary(
  binaryPath?: string | null,
): Promise<{ path: string }> {
  return resolveHarnessBinary("opencode", binaryPath);
}

export function resolveClaudeBinary(
  binaryPath?: string | null,
): Promise<{ path: string }> {
  return resolveHarnessBinary("claude", binaryPath);
}

export function resolvePiBinary(
  binaryPath?: string | null,
): Promise<{ path: string }> {
  return resolveHarnessBinary("pi", binaryPath);
}

export function resolveOmpBinary(
  binaryPath?: string | null,
): Promise<{ path: string }> {
  return resolveHarnessBinary("omp", binaryPath);
}

export function resolveFxBinary(
  binaryPath?: string | null,
): Promise<{ path: string }> {
  return resolveHarnessBinary("fx", binaryPath);
}

export function resolveGrokBinary(
  binaryPath?: string | null,
): Promise<{ path: string }> {
  return resolveHarnessBinary("grok", binaryPath);
}

export function resolveHermesBinary(
  binaryPath?: string | null,
): Promise<{ path: string }> {
  return resolveHarnessBinary("hermes", binaryPath);
}

export function resolveDevinBinary(
  binaryPath?: string | null,
): Promise<{ path: string }> {
  return resolveHarnessBinary("devin", binaryPath);
}

export function resolveFreebuffBinary(
  binaryPath?: string | null,
): Promise<{ path: string }> {
  return resolveHarnessBinary("freebuff", binaryPath);
}

/** The subset of Freebuff's persisted transcript MonoCode consumes. */
export type FreebuffChatBlock = {
  type: string;
  textType?: string;
  content?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: string;
};

export type FreebuffChatMessage = {
  id: string;
  variant: "user" | "ai";
  content: string;
  isComplete?: boolean;
  completionTime?: string;
  blocks: FreebuffChatBlock[];
};

export type FreebuffChatSnapshot = {
  messages: FreebuffChatMessage[];
  size: number;
  mtimeMs: number;
};

/**
 * Reserve the conversation folder Freebuff resumes. Its chats are keyed by an
 * id, so creating the empty transcript first makes MonoCode's session and
 * Freebuff's chat the same object instead of "whichever folder is newest".
 */
export function prepareFreebuffChat(
  cwd: string,
  chatId: string,
): Promise<{ path: string; created: boolean }> {
  return invoke("harness_freebuff_prepare_chat", { cwd, chatId });
}

export function readFreebuffChat(
  cwd: string,
  chatId: string,
): Promise<FreebuffChatSnapshot> {
  return invoke("harness_freebuff_read_chat", { cwd, chatId });
}

export function spawnFreebuffPty(input: {
  sessionId: string;
  command: string;
  cwd: string;
  chatId: string;
  binaryPath?: string | null;
}): Promise<number> {
  ownedChildren.add(input.sessionId);
  freebuffPendingExit.delete(input.sessionId);
  freebuffPtyReplay.delete(input.sessionId);
  return invoke<number>("harness_freebuff_pty_spawn", input);
}

export function writeFreebuffPty(
  sessionId: string,
  data: string,
): Promise<void> {
  return invoke("harness_freebuff_pty_write", { sessionId, data });
}

export function killFreebuffPty(sessionId: string): Promise<void> {
  freebuffPtyReplay.delete(sessionId);
  return invoke("harness_freebuff_pty_kill", { sessionId });
}

/** Apply a model change through Freebuff's interactive /model picker. */
export type FreebuffModelChoice = {
  name: string;
  effort: string | null;
  descriptors: string[];
  selected: boolean;
};

export type FreebuffPtyModelControlRequest =
  | {
      sessionId: string;
      action: "list";
      resolve: (models: FreebuffModelChoice[]) => void;
      reject: (error: Error) => void;
    }
  | {
      sessionId: string;
      action: "select";
      data: string;
      resolve: () => void;
      reject: (error: Error) => void;
    }
  | {
      sessionId: string;
      action: "activeModel";
      resolve: (model: { name: string; effort: string } | null) => void;
      reject: (error: Error) => void;
    };

const freebuffPtyModelControlSubscribers = new Set<
  (request: FreebuffPtyModelControlRequest) => boolean
>();

export function subscribeFreebuffPtyWrites(
  subscriber: (request: FreebuffPtyModelControlRequest) => boolean,
): () => void {
  freebuffPtyModelControlSubscribers.add(subscriber);
  return () => freebuffPtyModelControlSubscribers.delete(subscriber);
}

function dispatchFreebuffModelControl(
  request: FreebuffPtyModelControlRequest,
  unavailableMessage: string,
): void {
  if (freebuffPtyModelControlSubscribers.size === 0) {
    request.reject(new Error("Freebuff model control is not available."));
    return;
  }
  let accepted = false;
  for (const subscriber of freebuffPtyModelControlSubscribers) {
    try {
      accepted = subscriber(request) || accepted;
    } catch (error) {
      request.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (!accepted) request.reject(new Error(unavailableMessage));
}

export function requestFreebuffModelChange(
  sessionId: string,
  modelName: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    dispatchFreebuffModelControl(
      { sessionId, action: "select", data: modelName, resolve, reject },
      "No active Freebuff PTY accepted the model change.",
    );
  });
}export function requestFreebuffModelChoices(
  sessionId: string,
): Promise<FreebuffModelChoice[]> {
  return new Promise<FreebuffModelChoice[]>((resolve, reject) => {
    dispatchFreebuffModelControl(
      { sessionId, action: "list", resolve, reject },
      "No active Freebuff PTY accepted the model-list request.",
    );
  });
}
export function requestFreebuffActiveModel(
  sessionId: string,
): Promise<{ name: string; effort: string } | null> {
  return new Promise<{ name: string; effort: string } | null>((resolve, reject) => {
    dispatchFreebuffModelControl(
      { sessionId, action: "activeModel", resolve, reject },
      "No active Freebuff PTY accepted the active-model request.",
    );
  });
}
export function killAllFreebuffPtys(): Promise<void> {
  freebuffPtyReplay.clear();
  return invoke("harness_freebuff_pty_kill_all");
}

export function resolveAntigravityBinary(
  binaryPath?: string | null,
): Promise<{ path: string; args: string[] }> {
  return resolveHarnessBinary("antigravity", binaryPath) as Promise<{
    path: string;
    args: string[];
  }>;
}

export function freeHarnessPort(): Promise<number> {
  return invoke("harness_free_port");
}

export function harnessHttp(input: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}): Promise<{ status: number; body: string }> {
  return invoke("harness_http", input);
}

export function openHarnessSse(
  sessionId: string,
  url: string,
  headers?: Record<string, string>,
): Promise<void> {
  ownedSse.add(sessionId);
  return invoke("harness_sse_open", { sessionId, url, headers });
}

export function closeHarnessSse(sessionId: string): Promise<void> {
  unwatchSse(sessionId);
  return invoke("harness_sse_close", { sessionId });
}

export type HarnessBinaryInspection = {
  path: string;
  version?: string;
  error?: string;
};

export function inspectHarnessBinary(
  provider: ConfigurableBinaryProvider,
  binaryPath?: string | null,
): Promise<HarnessBinaryInspection> {
  return resolveHarnessBinary(provider, binaryPath).then(async (resolved) => {
    if (provider === "antigravity") {
      return { path: resolved.path, version: "ACP server" };
    }
    try {
      const version = (
        await execChild(
          resolved.path,
          ["--version"],
          undefined,
          provider,
          binaryPath,
        )
      ).trim();
      return /\d+\.\d+\.\d+/.test(version)
        ? { path: resolved.path, version }
        : { path: resolved.path, error: "CLI returned no valid version." };
    } catch (error) {
      return {
        path: resolved.path,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

/** Runs the CLI's own self-update against the binary MonoCode uses. */
export async function updateHarnessCli(
  provider: ConfigurableBinaryProvider,
): Promise<void> {
  const resolved = await resolveHarnessBinary(provider);
  await invoke("harness_update", {
    command: resolved.path,
    binaryProvider: provider,
    binaryPath: runtimeProviderBinaryPath(provider),
  });
}

export function execChild(
  command: string,
  args: string[],
  cwd?: string,
  binaryProvider?: ConfigurableBinaryProvider,
  binaryPathOverride?: string | null,
): Promise<string> {
  const binaryPath =
    binaryPathOverride === undefined && binaryProvider
      ? runtimeProviderBinaryPath(binaryProvider)
      : binaryPathOverride;
  return invoke("harness_exec", {
    command,
    args,
    cwd,
    binaryProvider,
    binaryPath,
  });
}
