import { describe, expect, test } from "bun:test";
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2";
import { ChildController } from "./controller";
import { displayStatus } from "./model";

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

describe("ChildController", () => {
  test("loads only direct children and reconciles host status", async () => {
    const statuses = new Map<string, SessionStatus>([["a", { type: "busy" }]]);
    const controller = new ChildController({
      fetchChildren: async () => [session("a"), session("wrong", "other")],
      status: (id) => statuses.get(id),
    });
    controller.setParent("parent");
    await tick();
    expect([...controller.snapshot().children.keys()]).toEqual(["a"]);
    expect(displayStatus(controller.snapshot().children.get("a")!)).toBe("busy");
    expect(controller.snapshot().children.get("a")!.timing?.lowerBound).toBeTrue();
    controller.dispose();
  });

  test("buffered lifecycle status wins over older fetch result", async () => {
    const gate = deferred<Session[]>();
    const controller = new ChildController({
      fetchChildren: () => gate.promise,
      status: () => ({ type: "idle" }),
    });
    controller.setParent("parent");
    gate.resolve([session("a")]);
    await gate.promise;
    await tick();
    controller.onStatus("a", { type: "retry", attempt: 1, message: "x", next: 2 });
    expect(displayStatus(controller.snapshot().children.get("a")!)).toBe("retry");
    controller.dispose();
  });

  test("buffers status received before direct child is fetched", async () => {
    const gate = deferred<Session[]>();
    const controller = new ChildController({
      fetchChildren: () => gate.promise,
      status: () => ({ type: "idle" }),
    });
    controller.setParent("parent");
    controller.onStatus("a", { type: "busy" });
    gate.resolve([session("a")]);
    await gate.promise;
    await tick();
    expect(displayStatus(controller.snapshot().children.get("a")!)).toBe("busy");
    controller.dispose();
  });

  test("buffers complete error received before direct child is fetched", async () => {
    const gate = deferred<Session[]>();
    const controller = new ChildController({
      fetchChildren: () => gate.promise,
      status: () => ({ type: "busy" }),
    });
    controller.setParent("parent");
    controller.onError("a", { name: "x" });
    gate.resolve([session("a")]);
    await gate.promise;
    await tick();
    expect(displayStatus(controller.snapshot().children.get("a")!)).toBe("error");
    controller.dispose();
  });

  test("early active status clears earlier buffered error", async () => {
    const gate = deferred<Session[]>();
    const controller = new ChildController({
      fetchChildren: () => gate.promise,
      status: () => undefined,
    });
    controller.setParent("parent");
    controller.onError("a", { name: "x" });
    controller.onStatus("a", { type: "busy" });
    gate.resolve([session("a")]);
    await gate.promise;
    await tick();
    expect(displayStatus(controller.snapshot().children.get("a")!)).toBe("busy");
    controller.dispose();
  });

  test("times active to error transition before child is fetched", async () => {
    const gate = deferred<Session[]>();
    let now = 10;
    const controller = new ChildController({
      fetchChildren: () => gate.promise,
      status: () => undefined,
      now: () => now,
    });
    controller.setParent("parent");
    controller.onStatus("a", { type: "busy" });
    now = 20;
    controller.onError("a", { name: "x" });
    gate.resolve([session("a")]);
    await gate.promise;
    await tick();
    const value = controller.snapshot().children.get("a")!;
    expect(displayStatus(value)).toBe("error");
    expect(value.timing).toEqual({ startedAt: 10, endedAt: 20, lowerBound: false });
    controller.dispose();
  });

  test("retains unknown lifecycle after failed fetch until ownership retry", async () => {
    let fail = true;
    const controller = new ChildController({
      fetchChildren: async () => {
        if (fail) throw new Error("offline");
        return [session("a")];
      },
      status: () => undefined,
      debounceMs: 1,
    });
    await controller.setParent("parent");
    controller.onError("a", { name: "x" });
    fail = false;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(displayStatus(controller.snapshot().children.get("a")!)).toBe("error");
    controller.dispose();
  });

  test("clears unverified lifecycle buffer when parent changes", async () => {
    const controller = new ChildController({
      fetchChildren: async () => [],
      status: () => undefined,
    });
    await controller.setParent("one");
    controller.onError("unknown", { name: "x" });
    await controller.setParent("two");
    await controller.setParent("one");
    expect(controller.snapshot().children.has("unknown")).toBeFalse();
    controller.dispose();
  });

  test("keeps created child missing from older in-flight fetch", async () => {
    const gate = deferred<Session[]>();
    let calls = 0;
    const controller = new ChildController({
      fetchChildren: () => (++calls === 1 ? gate.promise : Promise.resolve([session("new")])),
      status: () => undefined,
    });
    controller.setParent("parent");
    controller.onCreated(session("new"));
    gate.resolve([]);
    await gate.promise;
    await tick();
    expect(controller.snapshot().children.has("new")).toBeTrue();
    controller.dispose();
  });

  test("keeps newer session update over older in-flight fetch", async () => {
    const gate = deferred<Session[]>();
    let calls = 0;
    const controller = new ChildController({
      fetchChildren: () =>
        ++calls === 1 ? gate.promise : Promise.resolve([{ ...session("a"), title: "new title" }]),
      status: () => undefined,
    });
    controller.setParent("parent");
    controller.onUpdated({ ...session("a"), title: "new title", time: { created: 1, updated: 2 } });
    gate.resolve([{ ...session("a"), title: "old title" }]);
    await gate.promise;
    await tick();
    expect(controller.snapshot().children.get("a")?.session.title).toBe("new title");
    controller.dispose();
  });

  test("does not resurrect child deleted during in-flight fetch", async () => {
    const gate = deferred<Session[]>();
    const controller = new ChildController({
      fetchChildren: () => gate.promise,
      status: () => undefined,
    });
    controller.setParent("parent");
    controller.onCreated(session("a"));
    controller.onDeleted(session("a"));
    gate.resolve([session("a")]);
    await gate.promise;
    await tick();
    expect(controller.snapshot().children.has("a")).toBeFalse();
    controller.dispose();
  });

  test("does not resurrect deleted child while fetch remains stale", async () => {
    let include = true;
    const controller = new ChildController({
      fetchChildren: async () => (include ? [session("a")] : []),
      status: () => undefined,
    });
    await controller.setParent("parent");
    controller.onDeleted(session("a"));
    await controller.refresh();
    expect(controller.snapshot().children.has("a")).toBeFalse();
    include = false;
    await controller.refresh();
    expect(controller.snapshot().children.has("a")).toBeFalse();
    controller.dispose();
  });

  test("shows created child after authoritative fetch catches up", async () => {
    let include = false;
    const controller = new ChildController({
      fetchChildren: async () => (include ? [session("a")] : []),
      status: () => undefined,
    });
    await controller.setParent("parent");
    controller.onCreated(session("a"));
    await controller.refresh();
    expect(controller.snapshot().children.has("a")).toBeFalse();
    include = true;
    await controller.refresh();
    expect(controller.snapshot().children.has("a")).toBeTrue();
    controller.dispose();
  });

  test("queued lifecycle status wins stale host status without corrupting timing", async () => {
    const gate = deferred<Session[]>();
    let now = 10;
    const controller = new ChildController({
      fetchChildren: () => gate.promise,
      status: () => ({ type: "busy" }),
      now: () => now,
    });
    controller.setParent("parent");
    controller.onCreated(session("a"));
    controller.onStatus("a", { type: "busy" });
    now = 20;
    controller.onStatus("a", { type: "idle" });
    gate.resolve([session("a")]);
    await gate.promise;
    await tick();
    const value = controller.snapshot().children.get("a")!;
    expect(displayStatus(value)).toBe("idle");
    expect(value.timing).toEqual({ startedAt: 10, endedAt: 20, lowerBound: false });
    controller.dispose();
  });

  test("snapshots do not mutate after later updates", () => {
    const controller = new ChildController({
      fetchChildren: async () => [],
      status: () => undefined,
    });
    controller.setParent("parent");
    const before = controller.snapshot();
    controller.onCreated(session("a"));
    expect(before.children.has("a")).toBeFalse();
    controller.dispose();
  });

  test("retains complete direct-child errors and clears them when work restarts", async () => {
    let now = 10;
    const controller = new ChildController({
      fetchChildren: async () => [session("a")],
      status: () => undefined,
      now: () => now,
    });
    controller.setParent("parent");
    await tick();
    controller.onError(undefined, { name: "x" });
    controller.onError("a", undefined);
    controller.onError("unknown", { name: "x" });
    controller.onError("a", { name: "x" });
    expect(displayStatus(controller.snapshot().children.get("a")!)).toBe("error");
    now = 20;
    controller.onStatus("a", { type: "busy" });
    expect(displayStatus(controller.snapshot().children.get("a")!)).toBe("busy");
    controller.dispose();
  });

  test("removes known deleted child immediately", async () => {
    const controller = new ChildController({
      fetchChildren: async () => [session("a")],
      status: () => undefined,
    });
    controller.setParent("parent");
    await tick();
    controller.onDeleted(session("a"));
    expect(controller.snapshot().children.has("a")).toBeFalse();
    controller.dispose();
  });

  test("refetches direct child so early lifecycle events are retained", async () => {
    const controller = new ChildController({
      fetchChildren: async () => [session("a")],
      status: () => undefined,
    });
    controller.setParent("parent");
    controller.onCreated(session("a"));
    controller.onStatus("a", { type: "busy" });
    controller.onError("a", { name: "x" });
    await tick();
    expect(displayStatus(controller.snapshot().children.get("a")!)).toBe("error");
    controller.dispose();
  });

  test("keeps prior rows and marks stale after refresh failure", async () => {
    let fail = false;
    const controller = new ChildController({
      fetchChildren: async () => {
        if (fail) throw new Error("nope");
        return [session("a")];
      },
      status: () => undefined,
    });
    controller.setParent("parent");
    await tick();
    fail = true;
    await controller.refresh();
    expect(controller.snapshot().loadState).toBe("ready");
    expect(controller.snapshot().stale).toBeTrue();
    expect(controller.snapshot().children.has("a")).toBeTrue();
    controller.dispose();
  });

  test("reports unavailable after initial failure", async () => {
    const controller = new ChildController({
      fetchChildren: async () => Promise.reject("nope"),
      status: () => undefined,
    });
    controller.setParent("parent");
    await tick();
    expect(controller.snapshot().loadState).toBe("unavailable");
    controller.dispose();
  });

  test("runs at most one fetch and one trailing refresh", async () => {
    const first = deferred<Session[]>();
    let calls = 0;
    const controller = new ChildController({
      fetchChildren: async () => {
        calls++;
        if (calls === 1) return first.promise;
        return [];
      },
      status: () => undefined,
    });
    controller.setParent("parent");
    await controller.refresh();
    await controller.refresh();
    expect(calls).toBe(1);
    first.resolve([]);
    await first.promise;
    await tick();
    expect(calls).toBe(2);
    controller.dispose();
  });

  test("ignores old-parent response after parent change", async () => {
    const old = deferred<Session[]>();
    const controller = new ChildController({
      fetchChildren: (parent) =>
        parent === "old" ? old.promise : Promise.resolve([session("new-child", "new")]),
      status: () => undefined,
    });
    controller.setParent("old");
    controller.setParent("new");
    old.resolve([session("old-child", "old")]);
    await old.promise;
    await tick();
    expect(controller.snapshot().parentID).toBe("new");
    expect(controller.snapshot().children.has("old-child")).toBeFalse();
    expect(controller.snapshot().children.has("new-child")).toBeTrue();
    controller.dispose();
  });

  test("restores process-lifetime error and timing after navigating away and back", async () => {
    let now = 10;
    const controller = new ChildController({
      fetchChildren: async (parent) => (parent === "one" ? [session("a", "one")] : []),
      status: () => undefined,
      now: () => now,
    });
    controller.setParent("one");
    await tick();
    controller.onStatus("a", { type: "busy" });
    now = 20;
    controller.setParent("two");
    controller.onError("a", { name: "x" });
    controller.setParent("one");
    await tick();
    const restored = controller.snapshot().children.get("a")!;
    expect(displayStatus(restored)).toBe("error");
    expect(restored.timing).toEqual({ startedAt: 10, endedAt: 20, lowerBound: false });
    controller.dispose();
  });

  test("deletes remembered child while another parent is visible", async () => {
    let deleted = false;
    const controller = new ChildController({
      fetchChildren: async (parent) => (parent === "one" && !deleted ? [session("a", "one")] : []),
      status: () => undefined,
    });
    controller.setParent("one");
    await tick();
    controller.setParent("two");
    deleted = true;
    controller.onDeleted(session("a", "one"));
    controller.setParent("one");
    await tick();
    expect(controller.snapshot().children.has("a")).toBeFalse();
    controller.dispose();
  });
});
