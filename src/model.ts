import type { Message, Session, SessionStatus } from "@opencode-ai/sdk/v2";

export type ActiveStatus = "busy" | "retry";
export type DisplayStatus = ActiveStatus | "idle" | "error";

export type RunTiming = {
  startedAt: number;
  endedAt?: number;
};

export type ActivityObservation = {
  label: string;
  observedAt: number;
};

export type ChildRecord = {
  session: Session;
  status: SessionStatus;
  errorAt?: number;
  timing?: RunTiming;
};

export type ChildList = {
  visible: ChildRecord[];
  omitted: number;
};

const ACTIVE = new Set<SessionStatus["type"]>(["busy", "retry"]);
const WHITESPACE = /\s+/g;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const REGIONAL_INDICATOR = /\p{Regional_Indicator}/u;
const EMOJI_VARIATION = /\ufe0f/u;
const KEYCAP = /\u20e3/u;
const FORMAT_CONTROL = /\p{Cf}/u;
const ZERO_WIDTH_ONLY = /^[\p{Mark}\p{Cf}]+$/u;
const EMOJI_JOIN_IGNORABLE = /[\p{Mark}\p{Emoji_Modifier}]/u;
const EMOJI_TAG_SEQUENCE = /^\u{1f3f4}[\u{e0020}-\u{e007e}]+\u{e007f}$/u;
const EMOJI_TAG_CHARACTER = /[\u{e0020}-\u{e007f}]/u;
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function isActive(
  status: SessionStatus | undefined,
): status is Extract<SessionStatus, { type: ActiveStatus }> {
  return status !== undefined && ACTIVE.has(status.type);
}

export function normalizeStatus(status: SessionStatus | undefined): SessionStatus {
  return status && isActive(status) ? status : { type: "idle" };
}

export function displayStatus(child: ChildRecord): DisplayStatus {
  if (isActive(child.status)) return child.status.type;
  if (child.errorAt !== undefined) return "error";
  return "idle";
}

export function transitionTiming(
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
  child: ChildRecord,
  status: SessionStatus | undefined,
  now: number,
): ChildRecord {
  const next = normalizeStatus(status);
  const active = isActive(next);
  const timing = transitionTiming(child.timing, child.status, next, now);

  return {
    ...child,
    status: next,
    errorAt: active ? undefined : child.errorAt,
    timing,
  };
}

export function startObservedTiming(child: ChildRecord, now: number): ChildRecord {
  if (!isActive(child.status) || child.timing) return child;
  return { ...child, timing: { startedAt: now } };
}

export function retainError(child: ChildRecord, now: number): ChildRecord {
  const timing =
    isActive(child.status) && child.timing ? { ...child.timing, endedAt: now } : child.timing;
  return { ...child, status: { type: "idle" }, errorAt: now, timing };
}

export function sanitizeText(value: string): string {
  return [...SEGMENTER.segment(value)]
    .flatMap(({ segment }) => {
      const characters = [...segment];
      const emojiTagSequence = EMOJI_TAG_SEQUENCE.test(segment);
      const joinedPictographs = (index: number) => {
        const neighbor = (direction: -1 | 1) => {
          let cursor = index + direction;
          while (characters[cursor] && EMOJI_JOIN_IGNORABLE.test(characters[cursor]!))
            cursor += direction;
          return characters[cursor];
        };
        const previous = neighbor(-1);
        const next = neighbor(1);
        return (
          !!previous &&
          !!next &&
          EXTENDED_PICTOGRAPHIC.test(previous) &&
          EXTENDED_PICTOGRAPHIC.test(next)
        );
      };
      return characters.filter((character, index) => {
        const code = character.codePointAt(0) ?? 0;
        const control =
          code <= 0x08 || (code >= 0x0b && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
        if (control) return false;
        if (character === "\u200d") return joinedPictographs(index);
        if (EMOJI_TAG_CHARACTER.test(character)) return emojiTagSequence;
        return !FORMAT_CONTROL.test(character);
      });
    })
    .join("")
    .replace(WHITESPACE, " ")
    .trim();
}

function isWide(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

export function displayWidth(value: string): number {
  return [...SEGMENTER.segment(value)].reduce((width, { segment }) => {
    if (ZERO_WIDTH_ONLY.test(segment)) return width;
    const emoji =
      EMOJI_PRESENTATION.test(segment) ||
      REGIONAL_INDICATOR.test(segment) ||
      EMOJI_VARIATION.test(segment) ||
      KEYCAP.test(segment);
    return width + (emoji || isWide(segment.codePointAt(0) ?? 0) ? 2 : 1);
  }, 0);
}

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

function byID(left: ChildRecord, right: ChildRecord): number {
  return left.session.id.localeCompare(right.session.id);
}

export function sortAndPrune(children: Iterable<ChildRecord>, limit = 5): ChildList {
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

export function truncateWidth(value: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(value) <= width) return value;
  if (width === 1) return "…";

  const limit = width - 1;
  const { result } = [...SEGMENTER.segment(value)]
    .map(({ segment }) => segment)
    .reduce(
      (state, segment) =>
        state.done || displayWidth(state.result + segment) > limit
          ? { ...state, done: true }
          : { result: state.result + segment, done: false },
      { result: "", done: false },
    );
  return result + "…";
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

export function summarize(children: Iterable<ChildRecord>): Summary {
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
  child: ChildRecord,
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
