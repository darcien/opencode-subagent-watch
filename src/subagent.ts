/**
 * Defines lifecycle state and transitions for one tracked subagent.
 */
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2";

export type ActiveStatus = "busy" | "retry";
export type DisplayStatus = ActiveStatus | "idle" | "error";

export type RunTiming = {
  startedAt: number;
  endedAt?: number;
};

export type SubagentRecord = {
  session: Session;
  status: SessionStatus;
  errorAt?: number;
  timing?: RunTiming;
};

const ACTIVE = new Set<SessionStatus["type"]>(["busy", "retry"]);

export function isActive(
  status: SessionStatus | undefined,
): status is Extract<SessionStatus, { type: ActiveStatus }> {
  return status !== undefined && ACTIVE.has(status.type);
}

export function normalizeStatus(status: SessionStatus | undefined): SessionStatus {
  return status && isActive(status) ? status : { type: "idle" };
}

export function displayStatus(subagent: SubagentRecord): DisplayStatus {
  if (isActive(subagent.status)) return subagent.status.type;
  if (subagent.errorAt !== undefined) return "error";
  return "idle";
}

function transitionTiming(
  timing: RunTiming | undefined,
  previous: SessionStatus | undefined,
  next: SessionStatus | undefined,
  now: number,
): RunTiming | undefined {
  const wasActive = isActive(previous);
  const active = isActive(next);
  if (active && !wasActive) return { startedAt: now };
  if (!active && wasActive && timing) return { ...timing, endedAt: now };
  return timing;
}

export function updateStatus(
  subagent: SubagentRecord,
  status: SessionStatus | undefined,
  now: number,
): SubagentRecord {
  const next = normalizeStatus(status);
  const active = isActive(next);
  const timing = transitionTiming(subagent.timing, subagent.status, next, now);

  return {
    ...subagent,
    status: next,
    errorAt: active ? undefined : subagent.errorAt,
    timing,
  };
}

export function startObservedTiming(subagent: SubagentRecord, now: number): SubagentRecord {
  if (!isActive(subagent.status) || subagent.timing) return subagent;
  return { ...subagent, timing: { startedAt: now } };
}

export function retainError(subagent: SubagentRecord, now: number): SubagentRecord {
  const timing =
    isActive(subagent.status) && subagent.timing
      ? { ...subagent.timing, endedAt: now }
      : subagent.timing;
  return { ...subagent, status: { type: "idle" }, errorAt: now, timing };
}

export function cancelSubagent(subagent: SubagentRecord, now: number): SubagentRecord {
  if (!isActive(subagent.status)) return subagent;
  return { ...updateStatus(subagent, { type: "idle" }, now), errorAt: undefined };
}
