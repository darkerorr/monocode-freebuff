import { describe, expect, it } from "vitest";
import type { FreebuffBootDiagnostics } from "./freebuffProtocol";
import { freebuffBootDiagnostics } from "./freebuffProtocol";

describe("Freebuff command-line retrieval", () => {
  it("keeps invalid files out of the diagnostics the user sees", () => {
    const diagnostics = freebuffBootDiagnostics(
      "Downloading model GPT-6.1\nModel loading: 8/12 hours remaining\n12m left · 15.8K (2%)\nGPT-6.1 model ready",
      1,
      "C:\\Users\\Me\\freebuff.exe",
      "C:\\Users\\Me\\work",
      ["--cwd", "C:\\Users\\Me\\work", "--continue", "2026-10-23T07-00-00.000Z"]
    );

    expect(diagnostics.command).toBe("C:\\Users\\Me\\freebuff.exe");
    expect(diagnostics.cwd).toBe("C:\\Users\\Me\\work");
    expect(diagnostics.args).toEqual([
      "--cwd",
      "C:\\Users\\Me\\work",
      "--continue",
      "2026-10-23T07-00-00.000Z",
    ]);
    expect(diagnostics.outputTail).toMatch(/gpt-6\.1/i);
    expect(diagnostics.outputTail).toMatch(/model.*ready/);
    expect(diagnostics.outputTail).toMatch(/12m left/);
    expect(diagnostics.outputTail).toMatch(/model ready/);
    expect(diagnostics.outputTail).toContain("Downloading model");
    expect(diagnostics.outputTail).toContain("12m left");
    expect(diagnostics.outputTail).toContain("Model loading:");
  });
});
