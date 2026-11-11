import type { StopReason } from "@agentclientprotocol/sdk/unstable";

export interface StopReasonLogger {
  error: (...args: unknown[]) => void;
}

export function mapStopReason(raw: unknown, logger?: StopReasonLogger): StopReason {
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      if (raw !== null && raw !== undefined) {
        logger?.error("[stop-reason-map] unmapped stop_reason, defaulting to end_turn:", raw);
      }
      return "end_turn";
  }
}
