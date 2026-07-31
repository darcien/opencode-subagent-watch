/**
 * Builds bounded sidebar rows and summaries from tracked subagents.
 */
import type { Message, Session } from "@opencode-ai/sdk/v2";
import type { ActivityObservation } from "./activity";
import {
  displayStatus,
  isActive,
  type DisplayStatus,
  type RunTiming,
  type SubagentRecord,
} from "./subagent";
import { displayWidth, sanitizeText, truncateWidth } from "./terminal-text";

export type SubagentList = {
  visible: SubagentRecord[];
  omitted: number;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function displayTitle(session: Pick<Session, "title" | "agent">): string {
  const full = sanitizeText(session.title);
  if (!session.agent) return full;
  const stripped = full
    .replace(new RegExp(`\\s+\\(@${escapeRegExp(session.agent)} subagent\\)$`), "")
    .trim();
  return stripped || full;
}

export function modelsEqual(left: Session["model"], right: Session["model"]): boolean {
  if (!left || !right) return left === right;
  return left.providerID === right.providerID && left.id === right.id;
}

export function resolveSessionModel(
  session: Session | undefined,
  messages: readonly Message[],
): Session["model"] {
  if (session?.model) return session.model;
  const message = messages.findLast((item) => item.role === "user");
  if (!message) return;
  return {
    providerID: message.model.providerID,
    id: message.model.modelID,
    variant: message.model.variant,
  };
}

export function differingModel(
  child: Session["model"],
  parent: Session["model"],
): string | undefined {
  if (!child || modelsEqual(child, parent)) return;
  return `${child.providerID}/${child.id}`;
}

function byID(left: SubagentRecord, right: SubagentRecord): number {
  return left.session.id.localeCompare(right.session.id);
}

export function sortAndPrune(children: Iterable<SubagentRecord>, limit = 5): SubagentList {
  const values = [...children];
  const active = values
    .filter((child) => isActive(child.status))
    .toSorted(
      (left, right) => left.session.time.created - right.session.time.created || byID(left, right),
    );
  const errors = values
    .filter((child) => displayStatus(child) === "error")
    .toSorted((left, right) => (right.errorAt ?? 0) - (left.errorAt ?? 0) || byID(left, right));
  const idle = values
    .filter((child) => displayStatus(child) === "idle")
    .toSorted(
      (left, right) => right.session.time.updated - left.session.time.updated || byID(left, right),
    );

  const sorted = [...active, ...errors, ...idle];
  return {
    visible: sorted.slice(0, limit),
    omitted: Math.max(0, sorted.length - limit),
  };
}

export function formatDuration(timing: RunTiming | undefined, now: number): string | undefined {
  if (!timing) return;
  const seconds = Math.max(0, Math.floor(((timing.endedAt ?? now) - timing.startedAt) / 1000));
  let value: string;
  if (seconds < 60) value = `${seconds}s`;
  else if (seconds < 3600) value = `${Math.floor(seconds / 60)}m`;
  else {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    value = minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return value;
}

export function formatCost(cost: number | undefined): string | undefined {
  if (!cost || cost <= 0 || !Number.isFinite(cost)) return;
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export type Summary = { total: number; active: number; errors: number };

export function summarize(children: Iterable<SubagentRecord>): Summary {
  return [...children].reduce(
    (summary, child) => {
      const status = displayStatus(child);
      return {
        total: summary.total + 1,
        active: summary.active + (status === "busy" || status === "retry" ? 1 : 0),
        errors: summary.errors + (status === "error" ? 1 : 0),
      };
    },
    { total: 0, active: 0, errors: 0 },
  );
}

export function headerLine(
  summary: Summary,
  collapsed: boolean,
  width: number,
  stale = false,
): string {
  const arrow = collapsed ? "▶" : "▼";
  if (summary.total === 0 && !stale) return truncateWidth(`${arrow} Subagents · none`, width);
  const counts = [
    summary.active ? `${summary.active} active` : "",
    summary.errors ? `${summary.errors} error` : "",
    `${summary.total} total`,
    stale ? "stale" : "",
  ].filter(Boolean);
  return truncateWidth(`${arrow} Subagents · ${counts.join(" · ")}`, width);
}

export function headerSegments(
  summary: Summary,
  collapsed: boolean,
  width: number,
  stale = false,
): string[] {
  return headerLine(summary, collapsed, width, stale).split(" · ");
}

export type RowLines = {
  first: string;
  prefix: string;
  title: string;
  second?: string;
  third?: string;
};

function formatActivity(
  activity: ActivityObservation | undefined,
  now: number,
): { label: string; age: string } | undefined {
  if (!activity) return;
  const age = formatDuration({ startedAt: activity.observedAt, endedAt: now }, now);
  const label = sanitizeText(activity.label);
  if (!label || !age) return;
  return { label, age: `${age} ago` };
}

function fitFields(fields: readonly string[], width: number): string | undefined {
  const values = fields.filter(Boolean);
  const line = values.length ? `  ${values.join(" · ")}` : "";
  return line && displayWidth(line) <= width ? line : undefined;
}

function fitActivityColumns(
  activity: { label: string; age: string },
  duration: string,
  width: number,
): string | undefined {
  const separator = "  ";
  const activityWidth = width - displayWidth(`  ${separator}${duration}`);
  const labelWidth = activityWidth - displayWidth(` ${activity.age}`);
  if (labelWidth <= 0) return;

  const label = truncateWidth(activity.label, labelWidth);
  if (!label || (label === "…" && activity.label !== "…")) return;
  const field = `${label} ${activity.age}`;
  return `  ${field}${" ".repeat(Math.max(0, activityWidth - displayWidth(field)))}${separator}${duration}`;
}

function fitActivityOnly(
  activity: { label: string; age: string },
  width: number,
): string | undefined {
  const labelWidth = width - displayWidth(`   ${activity.age}`);
  if (labelWidth > 0) {
    const label = truncateWidth(activity.label, labelWidth);
    if (label !== "…" || activity.label === "…") return `  ${label} ${activity.age}`;
  }
  return fitFields([activity.age], width);
}

function fitActiveDetails(
  activity: ActivityObservation | undefined,
  runtime: string | undefined,
  width: number,
  now: number,
): string | undefined {
  const observed = formatActivity(activity, now);
  if (!observed) {
    const duration = runtime ? `dur ${runtime}` : undefined;
    return fitFields([duration ?? ""], width);
  }

  const duration = runtime ? `dur ${runtime}` : undefined;
  if (duration) {
    return fitActivityColumns(observed, duration, width) ?? fitActivityOnly(observed, width);
  }
  return fitActivityOnly(observed, width);
}

function fitIdentity(agent: string, model: string | undefined, width: number): string | undefined {
  if (!agent) return model && width > 2 ? `  ${truncateWidth(model, width - 2)}` : undefined;
  const full = model ? fitFields([agent, model], width) : fitFields([agent], width);
  if (full) return full;
  if (!model) return width > 2 ? `  ${truncateWidth(agent, width - 2)}` : undefined;

  const modelPrefix = " · ";
  const modelWidth = width - displayWidth(`  ${agent}${modelPrefix}`);
  if (modelWidth > 0) return `  ${agent}${modelPrefix}${truncateWidth(model, modelWidth)}`;
  return width > 2 ? `  ${truncateWidth(agent, width - 2)}` : undefined;
}

function fitSettledDetails(
  runtime: string | undefined,
  cost: string | undefined,
  width: number,
): string | undefined {
  const duration = runtime ? `dur ${runtime}` : undefined;
  return (
    fitFields([duration ?? "", cost ?? ""], width) ??
    fitFields([duration ?? ""], width) ??
    fitFields([cost ?? ""], width)
  );
}

export function rowLines(
  child: SubagentRecord,
  parentModel: Session["model"],
  width: number,
  now: number,
  activity?: ActivityObservation,
): RowLines {
  const status = displayStatus(child);
  const symbol: Record<DisplayStatus, string> = {
    busy: "*",
    retry: "~",
    error: "!",
    idle: "-",
  };
  const fullTitle = displayTitle(child.session);
  const statusPrefix = `${symbol[status]} ${status}`;
  const fullPrefix = `${symbol[status]} ${status} · `;
  const showTitle = !!fullTitle && displayWidth(fullPrefix) < width;
  const prefix = showTitle ? fullPrefix : truncateWidth(statusPrefix, width);
  const title = showTitle ? truncateWidth(fullTitle, width - displayWidth(fullPrefix)) : "";
  const first = prefix + title;
  const agent = sanitizeText(child.session.agent ?? "");
  const runtime = formatDuration(child.timing, now);
  const cost = formatCost(child.session.cost);
  const model = sanitizeText(differingModel(child.session.model, parentModel) ?? "") || undefined;
  const second = isActive(child.status)
    ? fitActiveDetails(activity, runtime, width, now)
    : fitSettledDetails(runtime, cost, width);
  const third = fitIdentity(agent, model, width);

  return { first: truncateWidth(first, width), prefix, title, second, third };
}
