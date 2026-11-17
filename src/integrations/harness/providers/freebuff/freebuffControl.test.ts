import { afterEach, describe, expect, it, vi } from "vitest";
import type { FreebuffChatSnapshot } from "../../core/child";
import type { HarnessEvent } from "../../core/types";
import {
  getFreebuffSessionModel,
  resetFreebuffAccountForTests,
} from "../../../../features/providers/model/freebuffAccount";
import { stripFreebuffAnsi } from "./freebuffProtocol";
import {
  resetFreebuffForTests,
  getActiveFreebuffSessionId,
  getActiveFreebuffModel,
  listFreebuffModels,
  selectFreebuffModel,
  startFreebuffSession,
  sendFreebuffTurn,
  setFreebuffRuntimeForTests,
  stopFreebuffSession,
  type FreebuffRuntime,
} from "./freebuff";

const boot = "Enter a coding task or / for commands\r\n";
const footer = (model: string) =>
  `╯ ${model} • max · ~\\repo · /model to change\r\n`;const emptyChat: FreebuffChatSnapshot = { messages: [], size: 2, mtimeMs: 1 };

function selectedPicker(model: string): string {
  return [
    "↑↓ choose model · Tab reasoning · Enter select · Esc cancel",
    "OPTIMIZED · Strongest price-to-performance models",
    `│${model === "DeepSeek V4.1 Flash 10/17" ? "›" : " "}DeepSeek V4.1 Flash 10/17 • max · Smart & Fast · Images`,
    `│${model === "MiMo v2.6 Flash Slow" ? "›" : " "}MiMo v2.6 Flash Slow · Slow · cheapest · Images`,
  ].join("\r\n");
}

function makeRuntime(): {
  runtime: FreebuffRuntime;
  writes: string[];
  emit: (text: string) => void;
  getOutput: () => string;
  getActive: () => string;
} {
  let output = "";
  let onData: ((data: string) => void) | undefined;
  let active = "DeepSeek V4.1 Flash 10/17";
  let highlighted = active;
  let pickerOpen = false;
  let typedModelCommand = false;
  const writes: string[] = [];
  const emit = (text: string) => {
    output += text;
    onData?.(text);
  };
  const runtime: FreebuffRuntime = {
    resolveBinary: async () => ({ path: "/usr/bin/freebuff" }),
    prepareChat: async (_cwd, chatId) => ({ path: `/chat/${chatId}`, created: true }),
    readChat: async () => emptyChat,
    spawn: async () => {
      emit(`${boot}${footer(active)}`);
      return 77;
    },
    write: async (_session, data) => {
      writes.push(data);
      if (data === "/model\r") {
        // Real Freebuff swallows an Enter sent in the same burst as the command.
        emit("\r\n│  /model│");
      } else if (data === "/model") {
        typedModelCommand = true;
        emit("\r\n│  /model│");
      } else if (data === "\r" && typedModelCommand && !pickerOpen) {
        typedModelCommand = false;
        pickerOpen = true;
        highlighted = active;
        emit(selectedPicker(active));
      } else if (data === "\u001b[B" || data === "\u001b[A") {
        highlighted = highlighted === "DeepSeek V4.1 Flash 10/17"
          ? "MiMo v2.6 Flash Slow"
          : "DeepSeek V4.1 Flash 10/17";
        emit(selectedPicker(highlighted));
      } else if (data === "\r" && pickerOpen) {
        active = highlighted;
        pickerOpen = false;
        emit(footer(active));
      } else if (data === "\u001b" && pickerOpen) {
        pickerOpen = false;
        // xterm redraws its screen buffer asynchronously; let the callback
        // settle so the adapter sees the updated footer just as it does from
        // a real ConPTY frame.
        emit(`\u001b[2J\u001b[H${boot}${footer(active)}`);
      }
    },
    kill: async () => undefined,
    watch: (_session, data) => {
      onData = data;
    },
    unwatch: () => undefined,
    delay: async (milliseconds) => {
      if (milliseconds > 10) await new Promise((resolve) => setTimeout(resolve, 0));
      else await Promise.resolve();
    },
    now: () => Date.now(),
  };
  return { runtime, writes, emit, getOutput: () => output, getActive: () => active };
}

afterEach(async () => {
  await stopFreebuffSession("freebuff-control-session").catch(() => undefined);
  resetFreebuffForTests();
  resetFreebuffAccountForTests();
});

describe("Freebuff interactive model control", () => {
  it("starts without a prompt and reuses the ready PTY when the first message arrives", async () => {
    const probe = makeRuntime();
    setFreebuffRuntimeForTests(probe.runtime);
    const events: string[] = [];
    const input = {
      sessionId: "freebuff-control-session",
      cwd: "/repo",
      model: "freebuff:session",
      runtimeMode: "supervised" as const,
      onEvent: (event: { type: string }) => events.push(event.type),
    };

    await startFreebuffSession(input);
    expect(getActiveFreebuffSessionId(input.sessionId)).toBe(input.sessionId);
    expect(probe.writes).toEqual([]);
    expect(events).toEqual([]);
    expect(await getActiveFreebuffModel(input.sessionId)).toEqual({
      name: "DeepSeek V4.1 Flash 10/17",
      effort: "max",
    });

    const firstTurnEvents: string[] = [];
    await sendFreebuffTurn({
      ...input,
      text: "",
      onEvent: (event) => firstTurnEvents.push(event.type),
    });
    expect(firstTurnEvents).toEqual(["session.providerBound", "session.started"]);
    expect(getActiveFreebuffSessionId(input.sessionId)).toBe(input.sessionId);
  });

  it("uses the observed /model row, confirms each movement and the active footer", async () => {
    const probe = makeRuntime();
    setFreebuffRuntimeForTests(probe.runtime);
    await sendFreebuffTurn({
      sessionId: "freebuff-control-session",
      cwd: "/repo",
      model: "freebuff:session",
      runtimeMode: "supervised",
      text: "",
      onEvent: () => undefined,
    });

    await expect(
      selectFreebuffModel("freebuff-control-session", "MiMo v2.6 Flash Slow"),
    ).resolves.toBeUndefined();
    // The command and its Enter go out separately; Freebuff drops a joined one.
    expect(probe.writes).toContain("/model");
    expect(probe.writes).not.toContain("/model\r");
    expect(probe.writes).toContain("\u001b[B");
    expect(probe.writes).toContain("\r");
    expect(probe.getOutput()).toContain("MiMo v2.6 Flash Slow • max");
    expect(probe.getActive()).toBe("MiMo v2.6 Flash Slow");
  });

  it("lists the active CLI model choices without selecting a new model", async () => {
    const probe = makeRuntime();
    setFreebuffRuntimeForTests(probe.runtime);
    await sendFreebuffTurn({
      sessionId: "freebuff-control-session",
      cwd: "/repo",
      model: "freebuff:session",
      runtimeMode: "supervised",
      text: "",
      onEvent: () => undefined,
    });

    await expect(listFreebuffModels("freebuff-control-session")).resolves.toEqual([
      { name: "DeepSeek V4.1 Flash 10/17", effort: "max", descriptors: ["Smart & Fast", "Images"], selected: true },
      { name: "MiMo v2.6 Flash Slow", effort: null, descriptors: ["Slow", "cheapest", "Images"], selected: false },
    ]);
    expect(probe.writes).toContain("/model");
    expect(probe.writes).toContain("\u001b");
    expect(probe.getActive()).toBe("DeepSeek V4.1 Flash 10/17");
    expect(await getActiveFreebuffModel("freebuff-control-session")).toEqual({
      name: "DeepSeek V4.1 Flash 10/17",
      effort: "max",
    });
  });

  it("rejects an unavailable model without sending a select key", async () => {
    const probe = makeRuntime();
    setFreebuffRuntimeForTests(probe.runtime);
    await sendFreebuffTurn({
      sessionId: "freebuff-control-session",
      cwd: "/repo",
      model: "freebuff:session",
      runtimeMode: "supervised",
      text: "",
      onEvent: () => undefined,
    });

    await expect(
      selectFreebuffModel("freebuff-control-session", "Not in the picker"),
    ).rejects.toThrow("does not currently offer");
    // One Enter opened the picker; none confirmed a model.
    expect(probe.writes.filter((write) => write === "\r")).toHaveLength(1);
    expect(probe.getActive()).toBe("DeepSeek V4.1 Flash 10/17");
  });

  it("fails closed when the session is not running", async () => {
    await expect(selectFreebuffModel("missing-session", "MiMo"))
      .rejects.toThrow("Start this Freebuff session");
  });
});

/**
 * Windows ConPTY sends only the cells that changed and positions them with
 * cursor moves, so the raw stream with escapes stripped glues or drops
 * letters. These frames reproduce that shape: each word lands at an explicit
 * column, and nothing but the emulated screen holds the full sentence.
 */
function conptyLine(row: number, words: string[]): string {
  let column = 2;
  return words
    .map((word) => {
      const piece = `\u001b[${row};${column}H${word}`;
      column += word.length + 1;
      return piece;
    })
    .join("");
}

const CONPTY_BOOT = `\u001b[2J${conptyLine(20, ["Enter", "a", "coding", "task", "or", "/", "for", "commands"])}`;
const CONPTY_FOOTER = conptyLine(23, [
  "DeepSeek", "V4.1", "Flash", "Fast", "•", "max", "·", "~\\repo", "·", "/model", "to", "change",
]) + conptyLine(24, ["12m", "left", "·", "15.8K", "(2%)"]);

function conptyRuntime(chat: () => FreebuffChatSnapshot = () => emptyChat): {
  runtime: FreebuffRuntime;
  writes: string[];
  emit: (text: string) => void;
} {
  const handlers = new Map<string, (data: string) => void>();
  const writes: string[] = [];
  let current: string | null = null;
  const emit = (text: string) => {
    if (current) handlers.get(current)?.(text);
  };
  return {
    writes,
    emit,
    runtime: {
      resolveBinary: async () => ({ path: "C:\\npm\\freebuff.cmd" }),
      prepareChat: async (_cwd, chatId) => ({ path: `/chat/${chatId}`, created: true }),
      readChat: async () => chat(),
      spawn: async ({ sessionId }) => {
        current = sessionId;
        emit(CONPTY_BOOT + CONPTY_FOOTER);
        return 91;
      },
      write: async (sessionId, data) => {
        writes.push(data);
        current = sessionId;
      },
      kill: async () => undefined,
      watch: (sessionId, onData) => {
        handlers.set(sessionId, onData);
      },
      unwatch: (sessionId) => {
        handlers.delete(sessionId);
      },
      delay: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      now: () => Date.now(),
    },
  };
}

const SCREEN_PUBLISH_WAIT_MS = 320;

describe("Freebuff on a Windows ConPTY screen", () => {
  it("detects the prompt from the rendered screen when the raw stream glues words", async () => {
    expect(stripFreebuffAnsi(CONPTY_BOOT)).not.toMatch(/enter a coding task|for commands/i);
    const probe = conptyRuntime();
    setFreebuffRuntimeForTests(probe.runtime);

    await startFreebuffSession({
      sessionId: "freebuff-control-session",
      cwd: "C:\\repo",
      model: "freebuff:session",
      runtimeMode: "supervised",
      onEvent: () => undefined,
    });

    expect(getActiveFreebuffSessionId("freebuff-control-session")).toBe("freebuff-control-session");
  });

  it("shows the session's model and Freebuff's context from the footer", async () => {
    const probe = conptyRuntime();
    setFreebuffRuntimeForTests(probe.runtime);
    const input = {
      sessionId: "freebuff-control-session",
      cwd: "C:\\repo",
      model: "freebuff:session",
      runtimeMode: "supervised" as const,
      onEvent: () => undefined,
    };
    await startFreebuffSession(input);
    await new Promise((resolve) => setTimeout(resolve, SCREEN_PUBLISH_WAIT_MS));

    expect(getFreebuffSessionModel(input.sessionId)).toEqual({
      name: "DeepSeek V4.1 Flash Fast",
      effort: "max",
    });
    const events: HarnessEvent[] = [];
    await sendFreebuffTurn({ ...input, text: "", onEvent: (event) => events.push(event) });
    expect(events).toContainEqual({ type: "context", used: 15_800, window: 790_000 });

    await stopFreebuffSession(input.sessionId);
    expect(getFreebuffSessionModel(input.sessionId)).toBeNull();
  });

  it("submits a prompt the rendered composer shows, with an accented first line", async () => {
    let submitted = false;
    const probe = conptyRuntime(() =>
      submitted
        ? {
            size: 3,
            mtimeMs: 2,
            messages: [
              { id: "u1", variant: "user", content: "Corrige l'élément", blocks: [] },
              {
                id: "a1",
                variant: "ai",
                content: "",
                isComplete: true,
                blocks: [{ type: "text", textType: "text", content: "C'est corrigé." }],
              },
            ],
          }
        : emptyChat,
    );
    const write = probe.runtime.write;
    probe.runtime.write = async (sessionId, data) => {
      await write(sessionId, data);
      if (data.startsWith("\u001b[200~")) {
        probe.emit(conptyLine(21, ["Corrige", "l'élément", "du", "panneau"]));
      } else if (data === "\r") {
        submitted = true;
      }
    };
    setFreebuffRuntimeForTests(probe.runtime);
    const events: HarnessEvent[] = [];

    await sendFreebuffTurn({
      sessionId: "freebuff-control-session",
      cwd: "C:\\repo",
      model: "freebuff:session",
      runtimeMode: "supervised",
      text: "Corrige l'élément du panneau",
      onEvent: (event) => events.push(event),
    });

    expect(probe.writes).toContain("\r");
    expect(events).toContainEqual({ type: "message.delta", text: "C'est corrigé." });
    expect(events).toContainEqual({ type: "message.completed" });
    expect(getActiveFreebuffSessionId("freebuff-control-session")).toBe("freebuff-control-session");
  });

  it("never hands a picker another project's Freebuff terminal", async () => {
    setFreebuffRuntimeForTests(conptyRuntime().runtime);
    await startFreebuffSession({
      sessionId: "freebuff-control-session",
      cwd: "C:\\project-a",
      model: "freebuff:session",
      runtimeMode: "supervised",
      onEvent: () => undefined,
    });

    expect(getActiveFreebuffSessionId(undefined, "C:\\project-a")).toBe("freebuff-control-session");
    expect(getActiveFreebuffSessionId(undefined, "C:\\project-b")).toBeNull();
    // A named session that is not running is not swapped for another one.
    expect(getActiveFreebuffSessionId("some-other-session")).toBeNull();
  });
});
