import { describe, expect, it } from "vitest";
import type {
  FreebuffChatBlock,
  FreebuffChatMessage,
} from "../../core/child";
import type { HarnessEvent } from "../../core/types";
import {
  createFreebuffTurnState,
  freebuffBootDiagnostics,
  freebuffChatId,
  freebuffPromptPayload,
  freebuffPtyTail,
  freebuffStartupError,
  freebuffToolKind,
  freebuffToolTitle,
  freebuffTurnProgress,
  stripFreebuffAnsi,
} from "./freebuffProtocol";

const snapshot = (messages: FreebuffChatMessage[]) => ({
  messages,
  size: 1,
  mtimeMs: 1,
});

const BOOT_DIAGNOSTICS = freebuffBootDiagnostics(
  "Down\nloading model for GPT-6.1 Sol…\n8/12 hours remaining\n12m left · 15.8K (2%)\n",
  9,
  "C:\\Program Files\\Freebuff\\freebuff.exe",
  "C:\\Users\\Me\\My Project",
  ["--cwd", "C:\\Users\\Me\\My Project", "--continue", "2026-10-23T07-00-00.000Z"],
);

const user = (content: string, id = "user-1"): FreebuffChatMessage => ({
  id,
  variant: "user",
  content,
  blocks: [],
});

const assistant = (
  id: string,
  blocks: FreebuffChatBlock[],
  isComplete?: boolean,
): FreebuffChatMessage => ({
  id,
  variant: "ai",
  content: "",
  isComplete,
  blocks,
});

const text = (content: string, textType = "text"): FreebuffChatBlock => ({
  type: "text",
  textType,
  content,
});

const tool = (
  toolName: string,
  output?: string,
  toolCallId = "call-1",
): FreebuffChatBlock => ({
  type: "tool",
  toolName,
  toolCallId,
  output,
});

describe("Freebuff chat identity", () => {
  it("uses the ISO folder name Freebuff itself resumes", () => {
    expect(
      freebuffChatId(new Date("2026-10-23T06:45:39.187Z")),
    ).toBe("2026-10-23T06-45-39.187Z");
    expect(
      freebuffChatId(new Date("2026-10-23T06:45:39.187Z"), 2),
    ).toBe("2026-10-23T06-45-39.187Z-2");
  });
});

describe("Freebuff prompt encoding", () => {
  it("keeps newlines inside one bracketed paste", () => {
    expect(freebuffPromptPayload("first\nsecond")).toBe(
      "\x1b[200~first\nsecond\x1b[201~",
    );
  });

  it("normalises CRLF and removes paste markers from user text", () => {
    expect(freebuffPromptPayload("a\r\nb\x1b[201~c")).toBe(
      "\x1b[200~a\nbc\x1b[201~",
    );
  });

  it("does not submit an empty prompt", () => {
    expect(freebuffPromptPayload("   \n")).toBe("");
  });
});

describe("Freebuff startup diagnostics", () => {
  it("strips terminal control sequences before showing output", () => {
    expect(stripFreebuffAnsi("\x1b[31mred\x1b[0m text")).toBe("red text");
    expect(freebuffPtyTail("a\n b\n c")).toBe("a b c");
  });

  it("points a signed-out user at the CLI login", () => {
    expect(
      freebuffStartupError("Freebuff Login\nWaiting for login...", null),
    ).toContain("freebuff login");
  });

  it("reports an early exit with its code", () => {
    expect(freebuffStartupError("boom", 3)).toContain("exit code 3");
    expect(freebuffStartupError("boom", 3)).toContain("boom");
  });

  it("reports a boot timeout", () => {
    expect(freebuffStartupError("", undefined)).toContain("within 30s");
  });

  it("keeps a failed boot’s diagnostics privacy-safe", () => {
    expect(BOOT_DIAGNOSTICS).toEqual({
      command: "C:\\Program Files\\Freebuff\\freebuff.exe",
      cwd: "C:\\Users\\Me\\My Project",
      args: ["--cwd", "C:\\Users\\Me\\My Project", "--continue", "2026-10-23T07-00-00.000Z"],
      exitCode: 9,
      outputTail: "Down loading model for GPT-6.1 Sol… 8/12 hours remaining 12m left · 15.8K (2%)",
      source: "resolved path",
    });
    expect(BOOT_DIAGNOSTICS.outputTail).toContain("GPT-6.1");
    expect(BOOT_DIAGNOSTICS.outputTail).not.toContain("Enter a coding task");
    expect(BOOT_DIAGNOSTICS.outputTail).toContain("Down");
    expect(BOOT_DIAGNOSTICS.outputTail).toContain("loading model");
  });
});

describe("Freebuff tool labels", () => {
  it("gives known tools readable titles and kinds", () => {
    expect(freebuffToolTitle("read_files")).toBe("Read files");
    expect(freebuffToolTitle("custom_tool")).toBe("Custom Tool");
    expect(freebuffToolKind("read_files")).toBe("read");
    expect(freebuffToolKind("write_file")).toBe("edit");
    expect(freebuffToolKind("grep_search")).toBe("search");
    expect(freebuffToolKind("run_terminal_command")).toBe("execute");
    expect(freebuffToolKind("spawn_agent")).toBe("agent");
  });
});

describe("Freebuff transcript events", () => {
  it("ignores persisted history and waits for the user boundary", () => {
    const state = createFreebuffTurnState(2);
    const progress = freebuffTurnProgress(
      state,
      snapshot([
        assistant("divider", [{ type: "mode-divider" }]),
        user("old question", "old-user"),
        assistant("old", [text("old answer")], true),
        user("new question", "new-user"),
      ]),
    );
    expect(progress.events).toEqual([]);
    expect(progress.complete).toBe(false);
    expect(state.sawUser).toBe(true);
    expect(state.userText).toBe("new question");
  });

  it("streams reasoning, text deltas and turn completion once", () => {
    const state = createFreebuffTurnState(0);
    const first = freebuffTurnProgress(
      state,
      snapshot([
        user("hello"),
        assistant("a1", [
          text("thinking", "reasoning"),
          text("Hel"),
        ]),
      ]),
    );
    expect(first.events).toEqual<HarnessEvent[]>([
      { type: "reasoning.delta", text: "thinking" },
      { type: "reasoning.completed" },
      { type: "message.delta", text: "Hel" },
    ]);
    expect(first.complete).toBe(false);

    const second = freebuffTurnProgress(
      state,
      snapshot([
        user("hello"),
        assistant(
          "a1",
          [text("thinking", "reasoning"), text("Hello")],
          true,
        ),
      ]),
    );
    expect(second.events).toEqual<HarnessEvent[]>([
      { type: "message.delta", text: "lo" },
      { type: "message.completed" },
    ]);
    expect(second.complete).toBe(true);

    const third = freebuffTurnProgress(
      state,
      snapshot([
        user("hello"),
        assistant(
          "a1",
          [text("thinking", "reasoning"), text("Hello")],
          true,
        ),
      ]),
    );
    expect(third.events).toEqual([]);
    expect(third.complete).toBe(true);
  });

  it("reports a tool once, then its completion once", () => {
    const state = createFreebuffTurnState(0);
    const started = freebuffTurnProgress(
      state,
      snapshot([user("read it"), assistant("a1", [tool("read_files")])]),
    );
    expect(started.events).toEqual<HarnessEvent[]>([
      {
        type: "tool.started",
        callId: "call-1",
        title: "Read files",
        kind: "read",
      },
    ]);

    const finished = freebuffTurnProgress(
      state,
      snapshot([
        user("read it"),
        assistant("a1", [tool("read_files", "file contents")], true),
      ]),
    );
    expect(finished.events).toEqual<HarnessEvent[]>([
      {
        type: "tool.updated",
        callId: "call-1",
        status: "completed",
        detail: "file contents",
      },
      { type: "message.completed" },
    ]);
  });

  it("re-syncs instead of duplicating when a snapshot rewrites text", () => {
    const state = createFreebuffTurnState(0);
    freebuffTurnProgress(
      state,
      snapshot([user("hi"), assistant("a1", [text("Hello")])]),
    );
    const rewritten = freebuffTurnProgress(
      state,
      snapshot([user("hi"), assistant("a1", [text("Hello there")])]),
    );
    expect(rewritten.events).toEqual<HarnessEvent[]>([
      { type: "message.delta", text: " there" },
    ]);

    const shrunk = freebuffTurnProgress(
      state,
      snapshot([user("hi"), assistant("a1", [text("Hello")])]),
    );
    expect(shrunk.events).toEqual([]);
  });

  it("falls back to the legacy content field when there are no blocks", () => {
    const state = createFreebuffTurnState(0);
    const progress = freebuffTurnProgress(state, {
      messages: [
        user("hi"),
        {
          id: "a1",
          variant: "ai",
          content: "legacy reply",
          isComplete: true,
          blocks: [],
        },
      ],
      size: 1,
      mtimeMs: 1,
    });
    expect(progress.events).toEqual<HarnessEvent[]>([
      { type: "message.delta", text: "legacy reply" },
      { type: "message.completed" },
    ]);
    expect(progress.complete).toBe(true);
  });
});
