import type { ActivityObservation } from "./model";

export type ActivityMap = ReadonlyMap<string, ActivityObservation>;

export function observeActivity(
  activities: ActivityMap,
  sessionID: string,
  label: string,
  observedAt: number,
): Map<string, ActivityObservation> {
  const timestamp = Number.isFinite(observedAt) ? observedAt : Date.now();
  return new Map(activities).set(sessionID, { label, observedAt: timestamp });
}

export function clearActivity(
  activities: ActivityMap,
  sessionID: string,
): Map<string, ActivityObservation> {
  if (!activities.has(sessionID)) return activities as Map<string, ActivityObservation>;
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
