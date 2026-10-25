// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QuickModelSelector } from "./QuickModelSelector";
import {
  FREEBUFF_SESSION_MODEL,
  resetHarnessModelOverlays,
  setHarnessModels,
  saveLastModelSettings,
  type AgentModel,
} from "../../sessions/model/models";

const freebuffControl = vi.hoisted(() => {
  const listFreebuffModels = vi.fn(async () => [
    { name: "GPT-6.1 Sol", effort: "high", descriptors: [], selected: true },
    { name: "MiMo v2.6 Flash Slow", effort: null, descriptors: [], selected: false },
  ]);
  const selectFreebuffModel = vi.fn(async () => undefined);
  return {
    listFreebuffModels,
    selectFreebuffModel,
    getActiveFreebuffSessionId: vi.fn(() => "freebuff-running-session"),
  };
});

vi.mock("../../../integrations/harness/providers/freebuff/freebuff", () => freebuffControl);

const freebuffStore = vi.hoisted(() => {
  const unavailable = {
    state: "unknown",
    value: null,
    reason: null,
    source: "Freebuff terminal",
    checkedAt: null,
  };
  const listeners = new Set<() => void>();
  let snapshot = {
    model: unavailable,
    models: unavailable,
    context: unavailable,
    contextCapacity: unavailable,
    dailyHours: unavailable,
    sessionLeftMinutes: unavailable,
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setModel: (value: { name: string; effort: string } | null) => {
      snapshot = {
        ...snapshot,
        model: {
          ...unavailable,
          value,
          state: value ? "available" : "unknown",
        },
      };
      for (const listener of listeners) listener();
    },
    setModels: (value: Array<{ name: string; effort: string | null; descriptors: string[]; selected: boolean }> | null) => {
      snapshot = {
        ...snapshot,
        models: { ...unavailable, value, state: value ? "available" : "unavailable" },
      };
      for (const listener of listeners) listener();
    },
  };
});

vi.mock("../../providers/model/freebuffAccount", () => ({
  getFreebuffAccountSnapshot: freebuffStore.getSnapshot,
  subscribeFreebuffAccount: freebuffStore.subscribe,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

const claude: AgentModel = {
  id: "test-claude",
  name: "Test Claude",
  harness: "claude",
  settings: [
    {
      id: "effort",
      label: "Effort",
      kind: "select",
      value: "low",
      options: [
        { label: "Low", value: "low" },
        { label: "High", value: "high" },
      ],
    },
    {
      id: "fast",
      label: "Fast",
      kind: "toggle",
      value: "false",
      options: [
        { label: "Off", value: "false" },
        { label: "On", value: "true" },
      ],
    },
  ],
};
const grok: AgentModel = {
  id: "test-grok",
  name: "Test Grok",
  harness: "grok",
};
let container: HTMLDivElement;
let root: Root;
const onChange = vi.fn();
const onSettingsChange = vi.fn();
const onClose = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  resetHarnessModelOverlays();
  setHarnessModels("claude", [claude]);
  setHarnessModels("grok", [grok]);
  freebuffStore.setModel(null);
  freebuffControl.listFreebuffModels.mockClear();
  freebuffControl.selectFreebuffModel.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      createElement(QuickModelSelector, {
        model: claude,
        values: { effort: "low" },
        availableHarnesses: ["claude", "grok", "freebuff"],
        onChange,
        onSettingsChange,
        onClose,
      }),
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetHarnessModelOverlays();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("browses one provider at a time and selects a model without closing settings", () => {
  const tabs = container.querySelectorAll('[role="tab"]');
  expect(tabs).toHaveLength(4); // Favorites and the three available providers.
  expect(container.querySelector('[role="listbox"]')?.textContent).toContain(
    "Test Claude",
  );
  act(() =>
    container
      .querySelector<HTMLButtonElement>(
        '[role="tab"][aria-label="Grok Build"]',
      )!
      .click(),
  );
  expect(container.querySelector('[role="listbox"]')?.textContent).toContain(
    "Test Grok",
  );
  expect(
    container.querySelector('[role="listbox"]')?.textContent,
  ).not.toContain("Test Claude");
  act(() =>
    container.querySelector<HTMLButtonElement>('[role="option"]')!.click(),
  );
  expect(onChange).toHaveBeenCalledWith(grok);
  expect(onClose).not.toHaveBeenCalled();
});

it("loads real Freebuff choices from the PTY and selects them without leaving the composer", async () => {
  act(() => freebuffStore.setModel({ name: "GPT-6.1 Sol", effort: "high" }));
  act(() =>
    root.render(
      createElement(QuickModelSelector, {
        model: claude,
        values: {},
        availableHarnesses: ["claude", "grok", "freebuff"],
        onChange,
        onSettingsChange,
        onClose,
      }),
    ),
  );

  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[role="tab"][aria-label="Freebuff"]')!
      .click();
    await Promise.resolve();
    await Promise.resolve();
  });
  const list = container.querySelector('[role="listbox"]')!;
  expect(freebuffControl.listFreebuffModels).toHaveBeenCalledWith("freebuff-running-session");
  expect(list.textContent).toContain("GPT-6.1 Sol");
  expect(list.textContent).toContain("high");
  expect(list.textContent).not.toContain("No matching models");
  expect(list.textContent).toContain("MiMo v2.6 Flash Slow");

  await act(async () => {
    [...list.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("MiMo v2.6 Flash Slow"))!
      .click();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(freebuffControl.selectFreebuffModel).toHaveBeenCalledWith(
    "freebuff-running-session",
    "MiMo v2.6 Flash Slow",
  );
  expect(onChange).toHaveBeenCalledWith(FREEBUFF_SESSION_MODEL);
});

it("shows a clear no-session error instead of claiming the model list was loaded", async () => {
  freebuffControl.getActiveFreebuffSessionId.mockReturnValue(null);
  await act(async () => {
    root.render(createElement(QuickModelSelector, {
      model: claude,
      values: {},
      availableHarnesses: ["claude", "grok", "freebuff"],
      onChange,
      onSettingsChange,
      onClose,
    }));
    container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Freebuff"]')!.click();
    await Promise.resolve();
  });
  expect(container.textContent).toContain("No active Freebuff session.");
  expect(freebuffControl.listFreebuffModels).not.toHaveBeenCalled();
});

it("updates effort inline and closes with Escape", () => {
  const slider = container.querySelector<HTMLInputElement>(
    'input[type="range"]',
  )!;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(slider, "1");
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(onSettingsChange).toHaveBeenCalledWith({ effort: "high" });
  act(() =>
    slider.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(onClose).toHaveBeenCalledOnce();
});

it("shows saved favorites across provider tabs", () => {
  act(() =>
    container
      .querySelector<HTMLButtonElement>('[title="Add to favorites"]')!
      .click(),
  );
  act(() =>
    container
      .querySelector<HTMLButtonElement>('[role="tab"][aria-label="Favorites"]')!
      .click(),
  );
  expect(container.querySelector('[role="listbox"]')?.textContent).toContain(
    "Test Claude",
  );
  act(() =>
    container
      .querySelector<HTMLButtonElement>('[title="Remove from favorites"]')!
      .click(),
  );
  expect(container.querySelector('[role="listbox"]')?.textContent).toContain(
    "No favorite models",
  );
});

it("toggles fast mode from the lightning button", () => {
  const fast = container.querySelector<HTMLButtonElement>(
    '[aria-label="Fast mode"]',
  )!;
  expect(fast.getAttribute("aria-pressed")).toBe("false");
  act(() => fast.click());
  expect(onSettingsChange).toHaveBeenCalledWith({
    effort: "low",
    fast: "true",
  });
});

it("resets reasoning and fast mode to saved user defaults", () => {
  saveLastModelSettings({ effort: "high", fast: "false" });
  act(() =>
    root.render(
      createElement(QuickModelSelector, {
        model: claude,
        values: { effort: "low", fast: "true", context: "256k" },
        availableHarnesses: ["claude", "grok"],
        onChange,
        onSettingsChange,
        onClose,
      }),
    ),
  );
  const fast = container.querySelector<HTMLButtonElement>(
    '[aria-label="Fast mode"]',
  )!;
  expect(fast.getAttribute("aria-pressed")).toBe("true");
  expect(fast.querySelector("svg")?.getAttribute("fill")).toBe("currentColor");
  act(() =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Reset to saved defaults"]',
      )!
      .click(),
  );
  expect(onSettingsChange).toHaveBeenCalledWith({
    effort: "high",
    fast: "false",
    context: "256k",
  });
});
