// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FreebuffAccountPanel } from "./FreebuffAccountPanel";
import {
  getFreebuffAccountSnapshot,
  resetFreebuffAccountForTests,
} from "../model/freebuffAccount";
import {
  configureChildBackend,
  startHarnessBridge,
} from "../../../integrations/harness/core/child";
import { ModelPicker } from "../../sessions/ui/ModelPicker";

const BOOT = `
Enter a coding task or / for commands
GPT-6.1 Sol • medium · ~\\proj · /model to change
8/12 hours remaining
12m left · 15.8K (2%)
`;

const PICKER = `↑↓ choose model · Tab reasoning · Enter select · Esc cancel
│› DeepSeek V4.1 Flash 10/17 • max · Smart & Fast · Images│
│  MiMo v2.6 Flash Slow · Slow · cheapest · Images│`;

let container: HTMLDivElement;
let root: Root;
let releaseBridge: (() => void) | undefined;
const handlers = new Map<string, (event: { payload: unknown }) => void>();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  resetFreebuffAccountForTests();
  handlers.clear();
  configureChildBackend({
    invoke: vi.fn(async (command: string) => {
      if (command === "harness_resolve_freebuff") return { path: "freebuff" };
      if (command === "harness_exec") return "0.2.34";
      return undefined;
    }),
    listen: vi.fn(
      async (event: string, handler: (event: { payload: unknown }) => void) => {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
    ),
  });
  releaseBridge = startHarnessBridge();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  releaseBridge?.();
  releaseBridge = undefined;
  await vi.runAllTimersAsync();
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function flushBridgeListeners() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(handlers.has("harness-freebuff-pty")).toBe(true);
}

function emitPty(data: string) {
  handlers.get("harness-freebuff-pty")?.({
    payload: { sessionId: "monocode-freebuff-test-session", data },
  });
}

it("streams PTY bridge frames through the account store into the panel and session model label", async () => {
  await flushBridgeListeners();
  await act(async () =>
    root.render(
      createElement(
        "div",
        null,
        createElement(FreebuffAccountPanel),
        createElement(ModelPicker, {
          harness: "freebuff",
          model: "",
          values: {},
          onChange: vi.fn(),
          onSettingsChange: vi.fn(),
        }),
      ),
    ),
  );

  await act(async () => {
    emitPty(BOOT);
    // This frame is the real 0.2.34 footer: Ink paints the box corner and the
    // model on one line and glues `V4.1` to `Flash`. It must still reach the
    // panel and the session label on a redraw with no boot marker.
    emitPty(
      "\u001b[H\u001b[2K╯ DeepSeek V4.1Flash 10/17 • max · ~\\proj · /model to change · Chat: New chat\r\n0/12 hours remaining\r\n12m left · 15.8K (2%)",
    );
    emitPty(PICKER);
  });

  const text = container.textContent ?? "";
  expect(getFreebuffAccountSnapshot().model.value).toEqual({
    name: "DeepSeek V4.1 Flash 10/17",
    effort: "max",
  });
  expect(text).toContain("0 / 12 h remaining");
  expect(text).toContain("12 min left in this session");
  expect(text).toContain("DeepSeek V4.1 Flash 10/17 · max");
  expect(text).toContain("MiMo v2.6 Flash Slow");
  expect(text).toContain("conversation context — not account tokens");
  expect(text).toContain("Not exposed");
  expect(text).toContain("source: Freebuff terminal");
  expect(text).not.toContain("Freebuff (CLI default)");
});

it("shows unavailable information honestly before a session runs", async () => {
  await flushBridgeListeners();
  await act(async () => root.render(createElement(FreebuffAccountPanel)));
  const text = container.textContent ?? "";
  expect(text).toContain("Not confirmed");
  expect(text).toContain("Not available from the CLI");
  expect(text).toContain("Start a Freebuff session in MonoCode");
  expect(text).not.toContain("0 / 0 h remaining");
  expect(text).toContain("Use the MonoCode model picker to read and change Freebuff's visible /model choices.");
  expect(text).not.toContain("Freebuff (CLI default)");
});

it("does not launch another interactive CLI to refresh the panel", async () => {
  await flushBridgeListeners();
  await act(async () => root.render(createElement(FreebuffAccountPanel)));
  const before = getFreebuffAccountSnapshot();
  await act(async () => {
    vi.advanceTimersByTime(60_000);
  });
  expect(getFreebuffAccountSnapshot().model.value).toBe(before.model.value);
  expect(getFreebuffAccountSnapshot().error).toBeNull();
});
