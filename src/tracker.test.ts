import { describe, expect, test } from "bun:test";
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2";
import { SubagentTracker } from "./tracker";
import { displayStatus } from "./subagent";

function session(id: string, parentID = "parent"): Session {
  return {
    id,
    parentID,
    slug: id,
    projectID: "project",
    directory: "/tmp",
    title: id,
    version: "1",
    time: { created: 1, updated: 1 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SubagentTracker", () => {
  test("loads only direct children and reconciles host status", async () => {
    const statuses = new Map<string, SessionStatus>([["a", { type: "busy" }]]);
    const tracker = new SubagentTracker({
      fetchChildren: async () => [session("a"), session("wrong", "other")],
      status: (id) => statuses.get(id),
    });
    tracker.setParent("parent");
    await tick();
    expect([...tracker.snapshot().children.keys()]).toEqual(["a"]);
    expect(displayStatus(tracker.snapshot().children.get("a")!)).toBe("busy");
    expect(tracker.snapshot().children.get("a")!.timing).toEqual({
      startedAt: expect.any(Number),
    });
    tracker.dispose();
  });

  test("buffered lifecycle status wins over older fetch result", async () => {
    const gate = deferred<Session[]>();
    const tracker = new SubagentTracker({
      fetchChildren: () => gate.promise,
      status: () => ({ type: "idle" }),
    });
    tracker.setParent("parent");
    gate.resolve([session("a")]);
    await gate.promise;
    await tick();
    tracker.onStatus("a", { type: "retry", attempt: 1, message: "x", next: 2 });
    expect(displayStatus(tracker.snapshot().children.get("a")!)).toBe("retry");
    tracker.dispose();
  });

  test("buffers status received before direct child is fetched", async () => {
    const gate = deferred<Session[]>();
    const tracker = new SubagentTracker({
      fetchChildren: () => gate.promise,
      status: () => ({ type: "idle" }),
    });
    tracker.setParent("parent");
    tracker.onStatus("a", { type: "busy" });
    gate.resolve([session("a")]);
    await gate.promise;
    await tick();
    expect(displayStatus(tracker.snapshot().children.get("a")!)).toBe("busy");
    tracker.dispose();
  });

  test("buffers complete error received before direct child is fetched", async () => {
    const gate = deferred<Session[]>();
    const tracker = new SubagentTracker({
      fetchChildren: () => gate.promise,
      status: () => ({ type: "busy" }),
    });
    tracker.setParent("parent");
    tracker.onError("a", { name: "x" });
    gate.resolve([session("a")]);
    await gate.promise;
    await tick();
    expect(displayStatus(tracker.snapshot().children.get("a")!)).toBe("error");
    tracker.dispose();
  });

  test("treats aborted child as cancelled instead of retained error", async () => {
    let now = 10;
    const tracker = new SubagentTracker({
      fetchChildren: async () => [session("a")],
      status: () => ({ type: "busy" }),
      now: () => now,
    });
    await tracker.setParent("parent");
    now = 20;
    tracker.onError("a", { name: "MessageAbortedError", data: { message: "Aborted" } });
    const value = tracker.snapshot().children.get("a")!;
    expect(displayStatus(value)).toBe("idle");
    expect(value.errorAt).toBeUndefined();
    expect(value.timing).toEqual({ startedAt: 10, endedAt: 20 });
    tracker.dispose();
  });

  test("buffers child cancellation received before ownership fetch", async () => {
    const gate = deferred<Session[]>();
    const tracker = new SubagentTracker({
      fetchChildren: () => gate.promise,
      status: () => ({ type: "busy" }),
    });
    tracker.setParent("parent");
    tracker.onError("a", { name: "MessageAbortedError", data: { message: "Aborted" } });
    gate.resolve([session("a")]);
    await gate.promise;
    await tick();
    expect(displayStatus(tracker.snapshot().children.get("a")!)).toBe("idle");
    tracker.dispose();
  });

  test("early active status clears earlier buffered error", async () => {
    const gate = deferred<Session[]>();
    const tracker = new SubagentTracker({
      fetchChildren: () => gate.promise,
      status: () => undefined,
    });
    tracker.setParent("parent");
    tracker.onError("a", { name: "x" });
    tracker.onStatus("a", { type: "busy" });
    gate.resolve([session("a")]);
    await gate.promise;
    await tick();
    expect(displayStatus(tracker.snapshot().children.get("a")!)).toBe("busy");
    tracker.dispose();
  });

  test("times active to error transition before child is fetched", async () => {
    const gate = deferred<Session[]>();
    let now = 10;
    const tracker = new SubagentTracker({
      fetchChildren: () => gate.promise,
      status: () => undefined,
      now: () => now,
    });
    tracker.setParent("parent");
    tracker.onStatus("a", { type: "busy" });
    now = 20;
    tracker.onError("a", { name: "x" });
    gate.resolve([session("a")]);
    await gate.promise;
    await tick();
    const value = tracker.snapshot().children.get("a")!;
    expect(displayStatus(value)).toBe("error");
    expect(value.timing).toEqual({ startedAt: 10, endedAt: 20 });
    tracker.dispose();
  });

  test("retains unknown lifecycle after failed fetch until ownership retry", async () => {
    let fail = true;
    const tracker = new SubagentTracker({
      fetchChildren: async () => {
        if (fail) throw new Error("offline");
        return [session("a")];
      },
      status: () => undefined,
      debounceMs: 1,
    });
    await tracker.setParent("parent");
    tracker.onError("a", { name: "x" });
    fail = false;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(displayStatus(tracker.snapshot().children.get("a")!)).toBe("error");
    tracker.dispose();
  });

  test("clears unverified lifecycle buffer when parent changes", async () => {
    const tracker = new SubagentTracker({
      fetchChildren: async () => [],
      status: () => undefined,
    });
    await tracker.setParent("one");
    tracker.onError("unknown", { name: "x" });
    await tracker.setParent("two");
    await tracker.setParent("one");
    expect(tracker.snapshot().children.has("unknown")).toBeFalse();
    tracker.dispose();
  });

  test("keeps created child missing from older in-flight fetch", async () => {
    const gate = deferred<Session[]>();
    let calls = 0;
    const tracker = new SubagentTracker({
      fetchChildren: () => (++calls === 1 ? gate.promise : Promise.resolve([session("new")])),
      status: () => undefined,
    });
    tracker.setParent("parent");
    tracker.onCreated(session("new"));
    gate.resolve([]);
    await gate.promise;
    await tick();
    expect(tracker.snapshot().children.has("new")).toBeTrue();
    tracker.dispose();
  });

  test("keeps newer session update over older in-flight fetch", async () => {
    const gate = deferred<Session[]>();
    let calls = 0;
    const tracker = new SubagentTracker({
      fetchChildren: () =>
        ++calls === 1 ? gate.promise : Promise.resolve([{ ...session("a"), title: "new title" }]),
      status: () => undefined,
    });
    tracker.setParent("parent");
    tracker.onUpdated({ ...session("a"), title: "new title", time: { created: 1, updated: 2 } });
    gate.resolve([{ ...session("a"), title: "old title" }]);
    await gate.promise;
    await tick();
    expect(tracker.snapshot().children.get("a")?.session.title).toBe("new title");
    tracker.dispose();
  });

  test("keeps child first seen by update over older in-flight fetch", async () => {
    const gate = deferred<Session[]>();
    let calls = 0;
    const tracker = new SubagentTracker({
      fetchChildren: () => (++calls === 1 ? gate.promise : Promise.resolve([session("new")])),
      status: () => undefined,
    });
    tracker.setParent("parent");
    tracker.onUpdated(session("new"));
    gate.resolve([]);
    await gate.promise;
    await tick();
    expect(tracker.snapshot().children.has("new")).toBeTrue();
    tracker.dispose();
  });

  test("does not resurrect child deleted during in-flight fetch", async () => {
    const gate = deferred<Session[]>();
    const tracker = new SubagentTracker({
      fetchChildren: () => gate.promise,
      status: () => undefined,
    });
    tracker.setParent("parent");
    tracker.onCreated(session("a"));
    tracker.onDeleted(session("a"));
    gate.resolve([session("a")]);
    await gate.promise;
    await tick();
    expect(tracker.snapshot().children.has("a")).toBeFalse();
    tracker.dispose();
  });

  test("does not resurrect deleted child while fetch remains stale", async () => {
    let include = true;
    const tracker = new SubagentTracker({
      fetchChildren: async () => (include ? [session("a")] : []),
      status: () => undefined,
    });
    await tracker.setParent("parent");
    tracker.onDeleted(session("a"));
    await tracker.refresh();
    expect(tracker.snapshot().children.has("a")).toBeFalse();
    include = false;
    await tracker.refresh();
    expect(tracker.snapshot().children.has("a")).toBeFalse();
    tracker.dispose();
  });

  test("shows created child after authoritative fetch catches up", async () => {
    let include = false;
    const tracker = new SubagentTracker({
      fetchChildren: async () => (include ? [session("a")] : []),
      status: () => undefined,
    });
    await tracker.setParent("parent");
    tracker.onCreated(session("a"));
    await tracker.refresh();
    expect(tracker.snapshot().children.has("a")).toBeFalse();
    include = true;
    await tracker.refresh();
    expect(tracker.snapshot().children.has("a")).toBeTrue();
    tracker.dispose();
  });

  test("queued lifecycle status wins stale host status without corrupting timing", async () => {
    const gate = deferred<Session[]>();
    let now = 10;
    const tracker = new SubagentTracker({
      fetchChildren: () => gate.promise,
      status: () => ({ type: "busy" }),
      now: () => now,
    });
    tracker.setParent("parent");
    tracker.onCreated(session("a"));
    tracker.onStatus("a", { type: "busy" });
    now = 20;
    tracker.onStatus("a", { type: "idle" });
    gate.resolve([session("a")]);
    await gate.promise;
    await tick();
    const value = tracker.snapshot().children.get("a")!;
    expect(displayStatus(value)).toBe("idle");
    expect(value.timing).toEqual({ startedAt: 10, endedAt: 20 });
    tracker.dispose();
  });

  test("snapshots do not mutate after later updates", () => {
    const tracker = new SubagentTracker({
      fetchChildren: async () => [],
      status: () => undefined,
    });
    tracker.setParent("parent");
    const before = tracker.snapshot();
    tracker.onCreated(session("a"));
    expect(before.children.has("a")).toBeFalse();
    tracker.dispose();
  });

  test("retains complete direct-child errors and clears them when work restarts", async () => {
    let now = 10;
    const tracker = new SubagentTracker({
      fetchChildren: async () => [session("a")],
      status: () => undefined,
      now: () => now,
    });
    tracker.setParent("parent");
    await tick();
    tracker.onError(undefined, { name: "x" });
    tracker.onError("a", undefined);
    tracker.onError("unknown", { name: "x" });
    tracker.onError("a", { name: "x" });
    expect(displayStatus(tracker.snapshot().children.get("a")!)).toBe("error");
    now = 20;
    tracker.onStatus("a", { type: "busy" });
    expect(displayStatus(tracker.snapshot().children.get("a")!)).toBe("busy");
    tracker.dispose();
  });

  test("removes known deleted child immediately", async () => {
    const tracker = new SubagentTracker({
      fetchChildren: async () => [session("a")],
      status: () => undefined,
    });
    tracker.setParent("parent");
    await tick();
    tracker.onDeleted(session("a"));
    expect(tracker.snapshot().children.has("a")).toBeFalse();
    tracker.dispose();
  });

  test("refetches direct child so early lifecycle events are retained", async () => {
    const tracker = new SubagentTracker({
      fetchChildren: async () => [session("a")],
      status: () => undefined,
    });
    tracker.setParent("parent");
    tracker.onCreated(session("a"));
    tracker.onStatus("a", { type: "busy" });
    tracker.onError("a", { name: "x" });
    await tick();
    expect(displayStatus(tracker.snapshot().children.get("a")!)).toBe("error");
    tracker.dispose();
  });

  test("keeps prior rows and marks stale after refresh failure", async () => {
    let fail = false;
    const tracker = new SubagentTracker({
      fetchChildren: async () => {
        if (fail) throw new Error("nope");
        return [session("a")];
      },
      status: () => undefined,
    });
    tracker.setParent("parent");
    await tick();
    fail = true;
    await tracker.refresh();
    expect(tracker.snapshot().loadState).toBe("ready");
    expect(tracker.snapshot().stale).toBeTrue();
    expect(tracker.snapshot().children.has("a")).toBeTrue();
    tracker.dispose();
  });

  test("reports unavailable after initial failure", async () => {
    const tracker = new SubagentTracker({
      fetchChildren: async () => Promise.reject("nope"),
      status: () => undefined,
    });
    tracker.setParent("parent");
    await tick();
    expect(tracker.snapshot().loadState).toBe("unavailable");
    tracker.dispose();
  });

  test("runs at most one fetch and one trailing refresh", async () => {
    const first = deferred<Session[]>();
    let calls = 0;
    const tracker = new SubagentTracker({
      fetchChildren: async () => {
        calls++;
        if (calls === 1) return first.promise;
        return [];
      },
      status: () => undefined,
    });
    tracker.setParent("parent");
    await tracker.refresh();
    await tracker.refresh();
    expect(calls).toBe(1);
    first.resolve([]);
    await first.promise;
    await tick();
    expect(calls).toBe(2);
    tracker.dispose();
  });

  test("ignores old-parent response after parent change", async () => {
    const old = deferred<Session[]>();
    const tracker = new SubagentTracker({
      fetchChildren: (parent) =>
        parent === "old" ? old.promise : Promise.resolve([session("new-child", "new")]),
      status: () => undefined,
    });
    tracker.setParent("old");
    tracker.setParent("new");
    old.resolve([session("old-child", "old")]);
    await old.promise;
    await tick();
    expect(tracker.snapshot().parentID).toBe("new");
    expect(tracker.snapshot().children.has("old-child")).toBeFalse();
    expect(tracker.snapshot().children.has("new-child")).toBeTrue();
    tracker.dispose();
  });

  test("restores process-lifetime error and timing after navigating away and back", async () => {
    let now = 10;
    const tracker = new SubagentTracker({
      fetchChildren: async (parent) => (parent === "one" ? [session("a", "one")] : []),
      status: () => undefined,
      now: () => now,
    });
    tracker.setParent("one");
    await tick();
    tracker.onStatus("a", { type: "busy" });
    now = 20;
    tracker.setParent("two");
    tracker.onError("a", { name: "x" });
    tracker.setParent("one");
    await tick();
    const restored = tracker.snapshot().children.get("a")!;
    expect(displayStatus(restored)).toBe("error");
    expect(restored.timing).toEqual({ startedAt: 10, endedAt: 20 });
    tracker.dispose();
  });

  test("deletes remembered child while another parent is visible", async () => {
    let deleted = false;
    const tracker = new SubagentTracker({
      fetchChildren: async (parent) => (parent === "one" && !deleted ? [session("a", "one")] : []),
      status: () => undefined,
    });
    tracker.setParent("one");
    await tick();
    tracker.setParent("two");
    deleted = true;
    tracker.onDeleted(session("a", "one"));
    tracker.setParent("one");
    await tick();
    expect(tracker.snapshot().children.has("a")).toBeFalse();
    tracker.dispose();
  });
});
