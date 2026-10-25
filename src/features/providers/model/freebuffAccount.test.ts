import { afterEach, describe, expect, it } from "vitest";
import {
  freebuffSnapshotFromProbe,
  getFreebuffAccountSnapshot,
  recordFreebuffModelControl,
  parseFreebuffUsageScreen,
  resetFreebuffAccountForTests,
  updateFreebuffAccountFromPty,
} from "./freebuffAccount";

/**
 * Real frames captured from `freebuff` 0.2.34 in a 120x40 ConPTY (cwd and
 * chat title shortened). The footer starts with the box corner because Ink
 * paints the border and the model on the same line.
 */
const boot = [
  "Enter a coding task or / for commands",
  "╯ DeepSeek V4.1Flash 10/17 • max · ~\\proj · /model to change · Chat: New chat",
  "0/12 hours remaining",
  "12m left · 15.8K (2%)",
].join("\r\n");

const picker = [
  "↑↓ choose model · Tab reasoning · Enter select · Esc cancel",
  "OPTIMIZED · Strongest price-to-performance models",
  "│›DeepSeek V4.1 Flash 10/17 • max · Smart & Fast · Images",
  "│  MiMo v2.6 Flash Slow · Slow · cheapest · Images",
].join("\r\n");

afterEach(() => resetFreebuffAccountForTests());

describe("Freebuff account snapshots", () => {
  it("parses observed usage and visible picker choices while leaving selection to Freebuff", () => {
    const snapshot = freebuffSnapshotFromProbe({
      boot,
      picker,
      version: "0.2.34",
      booted: true,
      checkedAt: 1761230000000,
    });

    expect(snapshot.version.value).toBe("0.2.34");
    expect(snapshot.signedIn.value).toBe(true);
    expect(snapshot.dailyHours.value).toEqual({ remaining: 0, limit: 12 });
    expect(snapshot.sessionLeftMinutes.value).toBe(12);
    expect(snapshot.context.value).toEqual({ label: "15.8K", percent: 2 });
    expect(snapshot.contextCapacity.value).toBeNull();
    expect(snapshot.contextCapacity.state).toBe("unavailable");
    expect(snapshot.model.value).toEqual({
      name: "DeepSeek V4.1 Flash 10/17",
      effort: "max",
    });
    expect(snapshot.models.value).toEqual([
      {
        name: "DeepSeek V4.1 Flash 10/17",
        effort: "max",
        descriptors: ["Smart & Fast", "Images"],
        selected: true,
      },
      {
        name: "MiMo v2.6 Flash Slow",
        effort: null,
        descriptors: ["Slow", "cheapest", "Images"],
        selected: false,
      },
    ]);
    expect(snapshot.modelControl.state).toBe("available");
  });

  it("does not claim token totals, plan details, or a reset time", () => {
    const snapshot = freebuffSnapshotFromProbe({
      boot,
      picker,
      booted: true,
      checkedAt: 1761230000000,
    });
    expect(snapshot.accountTokens.value).toBeNull();
    expect(snapshot.accountTokens.state).toBe("unavailable");
    expect(snapshot.plan.value).toBeNull();
    expect(snapshot.resetsAt.value).toBeNull();
    expect(snapshot.contextCapacity.value).toBeNull();
  });
});

describe("Freebuff terminal facts", () => {
  it("uses the latest repaint values instead of the first status frame", () => {
    const read = parseFreebuffUsageScreen(
      [
        "MiMo v2.6 Flash • low · ~\\proj",
        "2/12 hours remaining",
        "1m left · 2K (1%)",
        "GPT-6 Luna • high · ~\\proj",
        "5/12 hours remaining",
        "24m left · 50K (25%)",
      ].join("\r\n"),
    );
    expect(read.model).toEqual({ name: "GPT-6 Luna", effort: "high" });
    expect(read.dailyHours).toEqual({ remaining: 5, limit: 12 });
    expect(read.sessionLeftMinutes).toBe(24);
    expect(read.context).toEqual({ label: "50K", percent: 25 });
  });

  it("rejects malformed, missing, and out-of-range values without inventing zeroes", () => {
    expect(
      parseFreebuffUsageScreen("Freebuff balance unavailable"),
    ).toMatchObject({
      dailyHours: null,
      context: null,
      model: null,
      balanceUnavailable: true,
    });
    expect(
      parseFreebuffUsageScreen("14/12 hours remaining").dailyHours,
    ).toBeNull();
    expect(
      parseFreebuffUsageScreen("1/0 hours remaining").dailyHours,
    ).toBeNull();
    expect(parseFreebuffUsageScreen("150K (101%)").context).toBeNull();
  });

  it("updates facts on redraw frames even when they omit the boot marker", () => {
    const sessionId = "monocode-freebuff-redraw-test";
    updateFreebuffAccountFromPty({
      kind: "data",
      sessionId,
      data: "Enter a coding task or / for commands\r\n",
    });
    updateFreebuffAccountFromPty({
      kind: "data",
      sessionId,
      data: "\u001b[H\u001b[2K╯ GPT-6.1 Sol • medium · ~\\proj · /model to change\r\n8/12 hours remaining\r\n12m left · 15.8K (32%)",
    });

    expect(getFreebuffAccountSnapshot()).toMatchObject({
      model: { value: { name: "GPT-6.1 Sol", effort: "medium" } },
      dailyHours: { value: { remaining: 8, limit: 12 } },
      sessionLeftMinutes: { value: 12 },
      context: { value: { label: "15.8K", percent: 32 } },
    });
  });

  it("accumulates streamed output to parse the active model and usage", () => {
    const sessionId = "monocode-freebuff-stream-test";
    updateFreebuffAccountFromPty({
      kind: "data",
      sessionId,
      data: "Enter a coding task or / for commands\r\n╯ Claude Opus 4.6 • medium · ~\\proj · /model to change\r\n8/12 hours remaining\r\n",
    });
    updateFreebuffAccountFromPty({
      kind: "data",
      sessionId,
      data: "12m left · 15.8K (32%)",
    });

    const snapshot = getFreebuffAccountSnapshot();
    expect(snapshot.dailyHours.value).toEqual({ remaining: 8, limit: 12 });
    expect(snapshot.model.value?.name).toBe("Claude Opus 4.6");
    expect(snapshot.context.value).toEqual({ label: "15.8K", percent: 32 });
    expect(snapshot.modelControl.state).toBe("available");
  });

  it("stores picker results only after MonoCode has actively read them from the PTY", () => {
    const sessionId = "monocode-freebuff-picker-test";
    updateFreebuffAccountFromPty({
      kind: "data",
      sessionId,
      data: `${boot}\r\n`,
    });
    expect(getFreebuffAccountSnapshot().models.value).toBeNull();
    updateFreebuffAccountFromPty({ kind: "data", sessionId, data: picker });
    expect(getFreebuffAccountSnapshot().models.value).not.toBeNull();
    expect(getFreebuffAccountSnapshot().models.value?.[0].selected).toBe(true);
    recordFreebuffModelControl("monocode-freebuff-picker-test", [
      { name: "DeepSeek V4.1 Flash 10/17", effort: "max", descriptors: [], selected: true },
      { name: "MiMo v2.6 Flash Slow", effort: null, descriptors: [], selected: false },
    ]);
    expect(
      getFreebuffAccountSnapshot().models.value?.map(({ name }) => name),
    ).toEqual(["DeepSeek V4.1 Flash 10/17", "MiMo v2.6 Flash Slow"]);
  });

  it("reads the footer model when Freebuff glues it to the border", () => {
    const read = parseFreebuffUsageScreen(
      "╯ DeepSeek V4.1Flash 10/17 • max · ~\\Music\\monocode\\proj · /model to change · Chat: New chat",
    );
    expect(read.model).toEqual({
      name: "DeepSeek V4.1 Flash 10/17",
      effort: "max",
    });
  });

  it("keeps picker rows from replacing the model reported in use", () => {
    const read = parseFreebuffUsageScreen(
      [
        "╯ GPT-6.1 Sol • medium · ~\\proj · /model to change · Chat: New chat",
        "│›DeepSeek V4.1 Flash 10/17 • max · Smart & Fast · Images",
      ].join("\r\n"),
    );
    expect(read.model).toEqual({ name: "GPT-6.1 Sol", effort: "medium" });
  });

  it("marks session facts unknown after its PTY exits", () => {
    const sessionId = "monocode-freebuff-exit-test";
    updateFreebuffAccountFromPty({ kind: "data", sessionId, data: boot });
    updateFreebuffAccountFromPty({ kind: "exit", sessionId, code: 0 });
    expect(getFreebuffAccountSnapshot().dailyHours.value).toBeNull();
    expect(getFreebuffAccountSnapshot().model.value).toBeNull();
  });
});
