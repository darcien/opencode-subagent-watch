/**
 * Derives recent subagent activity from public part events.
 */
import type { Message, Part } from "@opencode-ai/sdk/v2";

export type ActivityObservation = {
  label: string;
  observedAt: number;
};

export type ActivityMap = ReadonlyMap<string, ActivityObservation>;

export function observeActivity(
  activities: ActivityMap,
  sessionID: string,
  label: string,
  observedAt: number,
): ActivityMap {
  if (!Number.isFinite(observedAt)) return activities;
  return new Map(activities).set(sessionID, { label, observedAt });
}

export function clearActivity(activities: ActivityMap, sessionID: string): ActivityMap {
  if (!activities.has(sessionID)) return activities;
  return new Map([...activities].filter(([id]) => id !== sessionID));
}

export function touchActivity(
  activities: ActivityMap,
  sessionID: string,
  observedAt: number,
): ActivityMap {
  const previous = activities.get(sessionID);
  if (!previous || !Number.isFinite(observedAt) || observedAt - previous.observedAt < 1_000) {
    return activities;
  }
  return observeActivity(activities, sessionID, previous.label, observedAt);
}

function activityLabel(part: Part, messageRole: Message["role"] | undefined): string | undefined {
  if (part.type === "reasoning") return "thinking";
  if (part.type === "text" && messageRole === "assistant" && !part.synthetic && !part.ignored)
    return "responding";
  if (part.type === "tool") return part.tool;
}

export function updateActivity(
  activities: ActivityMap,
  sessionID: string,
  part: Part,
  observedAt: number,
  messageRole?: Message["role"],
): ActivityMap {
  const label = activityLabel(part, messageRole);
  if (!label || !Number.isFinite(observedAt)) return activities;
  const previous = activities.get(sessionID);
  if (previous && observedAt < previous.observedAt) return activities;
  return previous?.label === label
    ? touchActivity(activities, sessionID, observedAt)
    : observeActivity(activities, sessionID, label, observedAt);
}
