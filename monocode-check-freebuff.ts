import { FREEBUFF_BOOT_MARKER } from "./src/integrations/harness/providers/freebuff/freebuffProtocol";
import { stripFreebuffAnsi } from "./src/integrations/harness/providers/freebuff/freebuffProtocol";
import { setFreebuffRuntimeForTests } from "./src/integrations/harness/providers/freebuff/freebuff";

const fake = {
  inspect: async () => ({ path: "/fb", version: "0.2.34" }),
  prepareChat: async () => ({ path: "/chat", created: false }),
  home: async () => "/home/me",
  spawn: async () => {
    const id = "probe";
    setTimeout(() => {
      fake.data(id, "▍Enter a coding task or / for commands\r\n");
    }, 0);
    return id;
  },
  write: async () => undefined,
  kill: async () => undefined,
  watch: (id, onData) => {
    fake.data = onData;
  },
  unwatch: () => undefined,
  delay: () => new Promise((r) => setTimeout(r, 0)),
  now: () => Date.now(),
} as const;

// Never silence console.error permanently; the boot path writes diagnostics
// through the runtime's console.error, and the probe reports failure by
// catching the surfaced Error, not by watching stderr.
setFreebuffRuntimeForTests(fake);

const { sendFreebuffTurn } = await import(
  "./src/integrations/harness/providers/freebuff/freebuff"
);

try {
  await sendFreebuffTurn({
    sessionId: "probe",
    text: "hi",
    onEvent: () => {},
    onAccepted: () => {},
  });

  console.log(JSON.stringify({ ok: false, reason: "Freebuff turned without surfacing the prompt error" }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("Freebuff did not show its prompt within")) {
    console.log(JSON.stringify({ ok: false, reason: `unexpected error: ${message}` }));
    return;
  }

  const stripped = stripFreebuffAnsi("▍Enter a coding task or / for commands\r\n");
  if (!FREEBUFF_BOOT_MARKER.test(stripped)) {
    console.log(JSON.stringify({ ok: false, reason: "boot marker does not match the stripped prompt" }));
    return;
  }

  console.log(JSON.stringify({ ok: true, binaryMarker: stripped, diagnostics: message }));
}
