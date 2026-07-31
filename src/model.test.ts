import { describe, expect, test } from "bun:test";
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2";
import {
  type ChildRecord,
  displayWidth,
  differingModel,
  displayStatus,
  displayTitle,
  formatDuration,
  headerLine,
  headerSegments,
  startObservedTiming,
  retainError,
  resolveSessionModel,
  rowLines,
  sortAndPrune,
  truncateWidth,
  updateStatus,
} from "./model";

function session(id: string, input: Partial<Session> = {}): Session {
  return {
    id,
    slug: id,
    projectID: "project",
    directory: "/tmp",
    title: id,
    version: "1",
    time: { created: 1, updated: 1 },
    ...input,
  };
}

function child(
  id: string,
  status: SessionStatus = { type: "idle" },
  input: Partial<Session> = {},
): ChildRecord {
  return { session: session(id, input), status };
}

describe("display data", () => {
  test("cleans titles and removes only matching conventional agent suffix", () => {
    expect(
      displayTitle({ title: "  Locate\nauth\u0007  (@explore subagent) ", agent: "explore" }),
    ).toBe("Locate auth");
    expect(displayTitle({ title: "Locate (@other subagent)", agent: "explore" })).toBe(
      "Locate (@other subagent)",
    );
  });

  test("compares provider and model id", () => {
    const parent = { providerID: "p", id: "m", variant: "high" };
    expect(differingModel({ ...parent }, parent)).toBeUndefined();
    expect(differingModel({ ...parent, variant: "low" }, parent)).toBeUndefined();
    expect(differingModel({ providerID: "q", id: "m" }, parent)).toBe("q/m");
    expect(differingModel(undefined, parent)).toBeUndefined();
    expect(differingModel({ providerID: "p", id: "m" }, undefined)).toBe("p/m");
  });

  test("resolves parent model from latest user message when session model is absent", () => {
    const messages = [
      {
        id: "message",
        sessionID: "parent",
        role: "user" as const,
        time: { created: 1 },
        agent: "build",
        model: { providerID: "github-copilot", modelID: "gpt-5.6-sol", variant: "high" },
      },
    ];
    expect(resolveSessionModel(session("parent"), messages)).toEqual({
      providerID: "github-copilot",
      id: "gpt-5.6-sol",
      variant: "high",
    });
    expect(
      differingModel(
        { providerID: "github-copilot", id: "gpt-5.6-sol", variant: "low" },
        resolveSessionModel(session("parent"), messages),
      ),
    ).toBeUndefined();
  });

  test("truncates by terminal display width without splitting graphemes", () => {
    expect(truncateWidth("abcdef", 4)).toBe("abc…");
    expect(truncateWidth("界界界", 5)).toBe("界界…");
    expect(truncateWidth("👨‍👩‍👧‍👦 family", 4)).toBe("👨‍👩‍👧‍👦 …");
    expect(displayWidth("🇮🇩")).toBe(2);
    expect(displayWidth("1️⃣")).toBe(2);
  });
});

describe("lifecycle", () => {
  test("times repeated runs and clears retained errors on restart", () => {
    let value = child("a");
    value = updateStatus(value, { type: "busy" }, 1_000);
    expect(value.timing).toEqual({ startedAt: 1_000 });
    value = retainError(value, 4_000);
    expect(displayStatus(value)).toBe("error");
    expect(formatDuration(value.timing, 9_000)).toBe("3s");
    value = updateStatus(
      value,
      { type: "retry", attempt: 1, message: "later", next: 8_000 },
      7_000,
    );
    expect(value.errorAt).toBeUndefined();
    expect(value.timing).toEqual({ startedAt: 7_000 });
  });

  test("starts timing when an active child is first observed", () => {
    const value = startObservedTiming(child("a", { type: "busy" }), 1_000);
    expect(formatDuration(value.timing, 61_000)).toBe("1m");
  });
});

describe("ordering", () => {
  test("groups active, retained errors, and newest idle with deterministic ties", () => {
    const values = [
      child("idle-old", { type: "idle" }, { time: { created: 1, updated: 2 } }),
      { ...child("error-old"), errorAt: 3 },
      child("active-new", { type: "busy" }, { time: { created: 4, updated: 4 } }),
      child(
        "active-old",
        { type: "retry", attempt: 1, message: "x", next: 2 },
        { time: { created: 2, updated: 9 } },
      ),
      { ...child("error-new"), errorAt: 8 },
      child("idle-new", { type: "idle" }, { time: { created: 1, updated: 7 } }),
    ];
    expect(
      sortAndPrune(values, Number.POSITIVE_INFINITY).visible.map((item) => item.session.id),
    ).toEqual(["active-old", "active-new", "error-new", "error-old", "idle-new", "idle-old"]);
  });

  test("keeps only the first five grouped rows", () => {
    const values = Array.from({ length: 13 }, (_, index) =>
      child(
        `idle-${index.toString().padStart(2, "0")}`,
        { type: "idle" },
        { time: { created: 1, updated: index } },
      ),
    );
    values.push(child("busy", { type: "busy" }), { ...child("error"), errorAt: 1 });
    const result = sortAndPrune(values);
    expect(result.visible).toHaveLength(5);
    expect(result.visible.map((item) => item.session.id)).toEqual([
      "busy",
      "error",
      "idle-12",
      "idle-11",
      "idle-10",
    ]);
    expect(result.omitted).toBe(10);
  });
});

describe("responsive lines", () => {
  const value = {
    ...child(
      "child",
      { type: "busy" },
      {
        title: "Long authentication investigation",
        agent: "investigator",
        model: { providerID: "provider", id: "model", variant: "high" },
        cost: 0.14,
      },
    ),
    timing: { startedAt: 0 },
  };

  for (const width of [24, 32, 40]) {
    test(`bounds every line at ${width} columns`, () => {
      const header = headerLine({ total: 14, active: 2, errors: 1 }, false, width);
      const lines = rowLines(value, { providerID: "other", id: "model" }, width, 600_000);
      expect(displayWidth(header)).toBeLessThanOrEqual(width);
      expect(displayWidth(lines.first)).toBeLessThanOrEqual(width);
      expect(displayWidth(lines.second ?? "")).toBeLessThanOrEqual(width);
      expect(displayWidth(lines.third ?? "")).toBeLessThanOrEqual(width);
      expect(lines.first).toContain("busy");
      expect(lines.first).toStartWith("* busy · ");
      expect(lines.second).toContain("investigator");
    });
  }

  test("uses full header labels with middle-dot separators", () => {
    expect(headerLine({ total: 14, active: 2, errors: 1 }, false, 80)).toBe(
      "▼ Subagents · 2 active · 1 error · 14 total",
    );
    expect(headerLine({ total: 0, active: 0, errors: 0 }, false, 80)).toBe("▼ Subagents · none");
    expect(headerSegments({ total: 14, active: 2, errors: 1 }, false, 80)).toEqual([
      "▼ Subagents",
      "2 active",
      "1 error",
      "14 total",
    ]);
  });

  test("splits activity from run details so cost remains visible", () => {
    const lines = rowLines(value, undefined, 40, 600_000, {
      label: "grep",
      observedAt: 592_000,
    });
    expect(lines.second).toBe("  investigator · grep 8s ago");
    expect(lines.third).toBe("  run 10m · $0.14 · provider/model");
    expect(rowLines(value, undefined, 12, 600_000).third).not.toContain("$0.…");
  });

  test("bounds status prefix at extremely narrow widths", () => {
    const lines = rowLines(value, undefined, 5, 0);
    expect(displayWidth(lines.prefix)).toBeLessThanOrEqual(5);
    expect(lines.title).toBe("");
  });

  test("omits metadata line when no metadata exists", () => {
    expect(rowLines(child("plain"), undefined, 24, 0).second).toBeUndefined();
    expect(rowLines(child("plain"), undefined, 24, 0).third).toBeUndefined();
  });
});
