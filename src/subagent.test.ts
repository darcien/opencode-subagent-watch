import { describe, expect, test } from "bun:test";
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2";
import {
  displayStatus,
  retainError,
  startObservedTiming,
  type SubagentRecord,
  updateStatus,
} from "./subagent";

function session(id: string): Session {
  return {
    id,
    slug: id,
    projectID: "project",
    directory: "/tmp",
    title: id,
    version: "1",
    time: { created: 1, updated: 1 },
  };
}

function subagent(id: string, status: SessionStatus = { type: "idle" }): SubagentRecord {
  return { session: session(id), status };
}

describe("subagent lifecycle", () => {
  test("times repeated runs and clears retained errors on restart", () => {
    let value = subagent("a");
    value = updateStatus(value, { type: "busy" }, 1_000);
    expect(value.timing).toEqual({ startedAt: 1_000 });
    value = retainError(value, 4_000);
    expect(displayStatus(value)).toBe("error");
    value = updateStatus(
      value,
      { type: "retry", attempt: 1, message: "later", next: 8_000 },
      7_000,
    );
    expect(value.errorAt).toBeUndefined();
    expect(value.timing).toEqual({ startedAt: 7_000 });
  });

  test("starts timing when an active subagent is first observed", () => {
    const value = startObservedTiming(subagent("a", { type: "busy" }), 1_000);
    expect(value.timing).toEqual({ startedAt: 1_000 });
  });
});
