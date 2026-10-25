import { afterEach, describe, expect, it, vi } from "vitest";
import type { FreebuffChatSnapshot } from "../../core/child";
import {
  resetFreebuffForTests,
  listFreebuffModels,
  selectFreebuffModel,
  sendFreebuffTurn,
  setFreebuffRuntimeForTests,
  stopFreebuffSession,
  type FreebuffRuntime,
} from "./freebuff";

const boot = "Enter a coding task or / for commands\r\n";
const footer = (model: string) =>
  `╯ ${model} • max · ~\\repo · /model to change\r\n`;
const selectedPicker = (model: string) => [
  "↑↓ choose model · Tab reasoning · Enter select · Esc cancel",
  "OPTIMIZED · Strongest price-to-performance models",
  `│${model === "DeepSeek V4.1 Flash 10/17" ? "›" : " "}DeepSeek V4.1 Flash 10/17 • max · Smart & Fast · Images`,
  `│${model === "MiMo v2.6 Flash Slow" ? "›" : " "}MiMo v2.6 Flash Slow · Slow · cheapest · Images`,
].join("\r\n");
const emptyChat: FreebuffChatSnapshot = { messages: [], size: 2, mtimeMs: 1 };

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
      } else if (data === "\u001b") {
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
});

describe("Freebuff interactive model control", () => {
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
    expect(probe.writes).toContain("/model\r");
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
    expect(probe.writes).toContain("/model\r");
    expect(probe.writes).toContain("\u001b");
    expect(probe.getActive()).toBe("DeepSeek V4.1 Flash 10/17");
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
    expect(probe.writes).not.toContain("\r");
  });

  it("fails closed when the session is not running", async () => {
    await expect(selectFreebuffModel("missing-session", "MiMo"))
      .rejects.toThrow("Start this Freebuff session");
  });
});
