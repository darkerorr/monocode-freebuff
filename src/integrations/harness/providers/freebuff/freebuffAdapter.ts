import {
  bindFreebuffSession,
  cancelFreebuffTurn,
  forgetFreebuffSession,
  respondFreebuffApproval,
  sendFreebuffTurn,
  steerFreebuffTurn,
  stopFreebuffSession,
} from "./freebuff";
import { registerHarness, type HarnessAdapter } from "../../core/registry";

export const freebuffAdapter: HarnessAdapter = {
  id: "freebuff",
  live: true,
  // The TUI has no mid-turn injection: a follow-up starts after this turn.
  canSteer: false,
  sendTurn: sendFreebuffTurn,
  steerTurn: steerFreebuffTurn,
  cancelTurn: cancelFreebuffTurn,
  respondApproval: respondFreebuffApproval,
  stopSession: stopFreebuffSession,
  forgetSession: forgetFreebuffSession,
  bindSession: bindFreebuffSession,
};

let registered = false;

export function ensureFreebuffRegistered(): void {
  if (registered) return;
  registerHarness(freebuffAdapter);
  registered = true;
}

