import { expect, test } from "bun:test";
import { clearActivity, observeActivity, touchActivity } from "./activity";

test("observes activity immutably", () => {
  const before = new Map();
  const after = observeActivity(before, "child", "grep", 1_000);
  expect(before.size).toBe(0);
  expect(after.get("child")).toEqual({ label: "grep", observedAt: 1_000 });
});

test("clears one child activity immutably", () => {
  const before = new Map([
    ["a", { label: "thinking", observedAt: 1 }],
    ["b", { label: "shell", observedAt: 2 }],
  ]);
  const after = clearActivity(before, "a");
  expect(before.size).toBe(2);
  expect([...after.keys()]).toEqual(["b"]);
  expect(clearActivity(after, "missing")).toBe(after);
});

test("throttles activity touches to one update per second", () => {
  const before = new Map([["a", { label: "thinking", observedAt: 1_000 }]]);
  expect(touchActivity(before, "a", 1_500)).toBe(before);
  expect(touchActivity(before, "a", 2_000).get("a")).toEqual({
    label: "thinking",
    observedAt: 2_000,
  });
});
