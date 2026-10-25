import type { FreebuffChatSnapshot } from "../../core/child";
import type { HarnessEvent } from "../../core/types";

/**
 * Freebuff exposes no ACP, JSON-RPC or headless mode. MonoCode drives its
 * terminal UI and follows the transcript Freebuff persists for the chat.
 * These markers are the UI text that has proven stable across 0.2.x.
 */
export const FREEBUFF_BOOT_MARKER = /enter a coding task|for commands/i;
export const FREEBUFF_BOOT_TIMEOUT_MS = 30_000;
export const FREEBUFF_PROMPT_TIMEOUT_MS = 30_000;
export const FREEBUFF_TURN_TIMEOUT_MS = 30 * 60_000;
export const FREEBUFF_POLL_MS = 600;
/**
 * The prompt marker can paint before the composer accepts keys: measured
 * against 0.2.34, a paste in the same frame is dropped.
 */
export const FREEBUFF_BOOT_SETTLE_MS = 1_200;
/** Enter after the composer has echoed the paste, not on a fixed schedule. */
export const FREEBUFF_PASTE_SETTLE_MS = 400;
export const FREEBUFF_ECHO_TIMEOUT_MS = 5_000;
export const FREEBUFF_SUBMIT_KEY = "\r";
/** Errors Freebuff prints in place of starting a session. */
export const FREEBUFF_SESSION_ERROR =
  /not enough hours|out of hours|session limit|freebuff login|log in to freebuff|please log in/i;

/** Diagnostic label stitched into boot failure messages by the Freebuff boot
 * waiter. It does not attach tokens, credentials, chat ids or prompts. */
export type FreebuffBootDiagnostics = {
  /** What launched, as far as the adapter could resolve before the attempt. */
  command: string;
  /** Working directory the process was given. Absolutized before spawn. */
  cwd: string;
  /** Arguments passed to the process. No user data. */
  args: string[];
  /** Last visible tail of the TUI when boot failed or timed out. */
  outputTail: string;
  /** Exit code, if the process finished before the marker appeared. */
  exitCode: number | null;
  /** Which CLI candidate resolved before the attempt. */
  source: string;
};

/** Stitch a small, privacy-safe diagnostic struct from a failed or timed-out
 * Freebuff boot. Callers may log it; it must never be shown as a user reply
 * unless the caller redacts it first.
 */
export function freebuffBootDiagnostics(
  output: string,
  exitCode: number | null,
  command: string,
  cwd: string,
  args: string[],
  source = "resolved path",
): FreebuffBootDiagnostics {
  return {
    command,
    cwd,
    args,
    exitCode,
    outputTail: freebuffPtyTail(output, 600),
    source,
  };
}
export const FREEBUFF_TOOL_DETAIL_CHARS = 4_000;

const ANSI =
  /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]/g;

export function stripFreebuffAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Last few visible characters of the TUI, for an error the user can act on. */
export function freebuffPtyTail(output: string, limit = 600): string {
  const text = stripFreebuffAnsi(output).replace(/\s+/g, " ").trim();
  if (!text) return "";
  // Keep the visible tail short enough for an error summary while retaining
  // the action a user can act on, e.g. "Down loading model … 12m left · 15.8K".
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

/**
 * A chat id Freebuff will resume. The CLI names chat folders with an ISO
 * timestamp; MonoCode creates the folder first so the id is stable even when
 * several sessions share one project.
 */
export function freebuffChatId(now: Date, attempt = 0): string {
  const base = now.toISOString().replace(/:/g, "-");
  return attempt > 0 ? `${base}-${attempt}` : base;
}

/**
 * Bracketed paste inserts the whole prompt (newlines included) into the
 * composer; a raw newline would submit the first line on its own.
 */
/** The opening of the prompt the composer echoes back once the paste lands. */
export function freebuffPromptEcho(text: string): string {
  const line = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .find((entry) => entry.trim());
  return (line ?? "").replace(/\s+/g, " ").trim().slice(0, 16);
}

export function freebuffPromptPayload(text: string): string {
  const cleaned = text
    .replace(/\r\n/g, "\n")
    .replace(/\x1b\[20[01]~/g, "")
    .trimEnd();
  if (!cleaned) return "";
  return `\x1b[200~${cleaned}\x1b[201~`;
}

/** Turn a failed boot into something the user can fix. */
export function freebuffStartupError(
  output: string,
  code?: number | null,
  timeoutMs = FREEBUFF_BOOT_TIMEOUT_MS,
): string {
  const tail = freebuffPtyTail(output);
  const suffix = tail ? `\n\nLast Freebuff output: ${tail}` : "";
  if (/freebuff login|log in to freebuff|not logged in|please log in|sign in/i.test(tail)) {
    return `Freebuff is not signed in. Run \`freebuff login\` in a terminal, complete the browser step, then retry.${suffix}`;
  }
  if (code != null) {
    return `Freebuff exited before its prompt appeared${code === 0 ? "" : ` (exit code ${code})`}.${suffix}`;
  }
  return `Freebuff did not show its prompt within ${Math.round(timeoutMs / 1000)}s.${suffix}`;
}

const TOOL_TITLES: Record<string, string> = {
  read_files: "Read files",
  read_file: "Read file",
  list_directory: "List directory",
  write_file: "Write file",
  edit_file: "Edit file",
  str_replace: "Edit file",
  apply_patch: "Apply patch",
  grep_search: "Search files",
  glob: "Find files",
  run_terminal_command: "Run command",
  run_command: "Run command",
  web_search: "Search the web",
  fetch_url: "Fetch URL",
  spawn_agent: "Start agent",
  task: "Start agent",
};

export function freebuffToolTitle(toolName?: string): string {
  const name = toolName?.trim();
  if (!name) return "Tool";
  const known = TOOL_TITLES[name];
  if (known) return known;
  return name
    .replace(/[_-]+/g, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

export function freebuffToolKind(toolName?: string): string {
  const name = (toolName ?? "").toLowerCase();
  if (/agent|subagent|delegate|task/.test(name)) return "agent";
  if (/write|edit|replace|patch|create|delete|move|rename/.test(name)) {
    return "edit";
  }
  if (/grep|search|find/.test(name)) return "search";
  if (/read|list|glob|inspect|view/.test(name)) return "read";
  if (/run|shell|term|command|exec|bash/.test(name)) return "execute";
  return "tool";
}

export type FreebuffTurnState = {
  /** Messages Freebuff had persisted before this turn was submitted. */
  baseline: number;
  text: Map<string, string>;
  reasoning: Map<string, string>;
  reasoningClosed: Set<string>;
  toolsStarted: Set<string>;
  toolsCompleted: Set<string>;
  messagesCompleted: Set<string>;
  sawUser: boolean;
  userText: string;
};

export function createFreebuffTurnState(baseline: number): FreebuffTurnState {
  return {
    baseline,
    text: new Map(),
    reasoning: new Map(),
    reasoningClosed: new Set(),
    toolsStarted: new Set(),
    toolsCompleted: new Set(),
    messagesCompleted: new Set(),
    sawUser: false,
    userText: "",
  };
}

export type FreebuffTurnProgress = {
  events: HarnessEvent[];
  /** The newest assistant message for this turn reported isComplete. */
  complete: boolean;
};

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

/**
 * Transcript snapshots are cumulative. Emit only the new suffix, but survive a
 * snapshot that rewrites earlier text by re-syncing at the common prefix.
 */
function appendDelta(
  map: Map<string, string>,
  key: string,
  content: string,
  emit: (text: string) => void,
): void {
  const previous = map.get(key);
  if (previous === undefined) {
    map.set(key, content);
    if (content) emit(content);
    return;
  }
  if (content === previous) return;
  if (content.length > previous.length && content.startsWith(previous)) {
    map.set(key, content);
    emit(content.slice(previous.length));
    return;
  }
  const common = commonPrefixLength(previous, content);
  map.set(key, content);
  if (content.length > common) emit(content.slice(common));
}

/**
 * Translate one transcript snapshot into MonoCode transcript events. The
 * user message is the turn boundary: anything before it (the welcome divider,
 * earlier turns after a resume) is old history and is never replayed.
 */
export function freebuffTurnProgress(
  state: FreebuffTurnState,
  snapshot: FreebuffChatSnapshot,
): FreebuffTurnProgress {
  const events: HarnessEvent[] = [];
  let lastAssistantComplete: boolean | null = null;
  let lastAssistantKey = "";

  const closeReasoning = (key: string) => {
    if (![...state.reasoning.keys()].some((entry) => entry.startsWith(`${key}:`))) {
      return;
    }
    if (state.reasoningClosed.has(key)) return;
    state.reasoningClosed.add(key);
    events.push({ type: "reasoning.completed" });
  };

  for (
    let index = Math.min(state.baseline, snapshot.messages.length);
    index < snapshot.messages.length;
    index += 1
  ) {
    const message = snapshot.messages[index];
    if (message.variant === "user") {
      state.sawUser = true;
      state.userText = message.content;
      lastAssistantComplete = null;
      continue;
    }
    if (!state.sawUser) continue;

    const key = message.id || `ai-${index}`;
    lastAssistantKey = key;
    const blocks =
      message.blocks.length > 0
        ? message.blocks
        : message.content
          ? [
              {
                type: "text",
                textType: "text",
                content: message.content,
              },
            ]
          : [];

    blocks.forEach((block, blockIndex) => {
      if (block.type === "text") {
        const content = block.content ?? "";
        if (block.textType === "reasoning") {
          appendDelta(state.reasoning, `${key}:${blockIndex}`, content, (text) =>
            events.push({ type: "reasoning.delta", text }),
          );
          return;
        }
        closeReasoning(key);
        appendDelta(state.text, `${key}:${blockIndex}`, content, (text) =>
          events.push({ type: "message.delta", text }),
        );
        return;
      }
      if (block.type !== "tool") return;
      closeReasoning(key);
      const callId = block.toolCallId || `${key}:tool-${blockIndex}`;
      if (!state.toolsStarted.has(callId)) {
        state.toolsStarted.add(callId);
        events.push({
          type: "tool.started",
          callId,
          title: freebuffToolTitle(block.toolName),
          kind: freebuffToolKind(block.toolName),
        });
      }
      if (block.output != null && !state.toolsCompleted.has(callId)) {
        state.toolsCompleted.add(callId);
        events.push({
          type: "tool.updated",
          callId,
          status: "completed",
          detail:
            block.output.slice(0, FREEBUFF_TOOL_DETAIL_CHARS) || undefined,
        });
      }
    });

    lastAssistantComplete = message.isComplete === true;
    if (message.isComplete) {
      closeReasoning(key);
      if (!state.messagesCompleted.has(key)) {
        state.messagesCompleted.add(key);
        events.push({ type: "message.completed" });
      }
    }
  }

  if (lastAssistantComplete && lastAssistantKey) {
    closeReasoning(lastAssistantKey);
  }

  return {
    events,
    complete: lastAssistantComplete === true,
  };
}
