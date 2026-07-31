import { expect, test } from "bun:test";
import type { Part } from "@opencode-ai/sdk/v2";
import { clearActivity, observeActivity, touchActivity, updateActivity } from "./activity";

test("observes activity immutably", () => {
  const before = new Map();
  const after = observeActivity(before, "child", "grep", 1_000);
  expect(before.size).toBe(0);
  expect(after.get("child")).toEqual({ label: "grep", observedAt: 1_000 });
  expect(observeActivity(after, "child", "read", Number.NaN)).toBe(after);
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

const part = (value: Partial<Part> & Pick<Part, "type">): Part =>
  ({ id: "part", sessionID: "child", messageID: "message", ...value }) as Part;

test.each([
  [part({ type: "reasoning", text: "", time: { start: 1 } }), "thinking", undefined],
  [part({ type: "text", text: "answer" }), "responding", "assistant"],
  [
    part({
      type: "tool",
      callID: "call",
      tool: "grep",
      state: { status: "running", input: {}, time: { start: 1 } },
    }),
    "grep",
    undefined,
  ],
  [
    part({
      type: "tool",
      callID: "call",
      tool: "bash",
      state: {
        status: "completed",
        input: {},
        output: "",
        title: "",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    }),
    "bash",
    undefined,
  ],
] as const)("maps $type parts to observed activity", (value, label, role) => {
  expect(updateActivity(new Map(), "child", value, 1_000, role).get("child")).toEqual({
    label,
    observedAt: 1_000,
  });
});

test("ignores synthetic text and unrelated parts", () => {
  const before = new Map([["child", { label: "grep", observedAt: 1_000 }]]);
  expect(
    updateActivity(before, "child", part({ type: "text", text: "input" }), 2_000, "user"),
  ).toBe(before);
  expect(
    updateActivity(
      before,
      "child",
      part({ type: "text", text: "", synthetic: true }),
      2_000,
      "assistant",
    ),
  ).toBe(before);
  expect(updateActivity(before, "child", part({ type: "step-start" }), 2_000)).toBe(before);
});

test("updates labels immediately and throttles repeated part updates", () => {
  const before = new Map([["child", { label: "thinking", observedAt: 1_000 }]]);
  const reasoning = part({ type: "reasoning", text: "", time: { start: 1 } });
  const tool = part({
    type: "tool",
    callID: "call",
    tool: "read",
    state: { status: "pending", input: {}, raw: "" },
  });
  expect(updateActivity(before, "child", reasoning, 1_500)).toBe(before);
  expect(updateActivity(before, "child", tool, 1_500).get("child")).toEqual({
    label: "read",
    observedAt: 1_500,
  });
  expect(updateActivity(before, "child", tool, 500)).toBe(before);
});

test("retains exact real tool names in activity state", () => {
  const tool = part({
    type: "tool",
    callID: "call",
    tool: "svelte_get-documentation",
    state: { status: "pending", input: {}, raw: "" },
  });
  expect(updateActivity(new Map(), "child", tool, 1_000).get("child")?.label).toBe(
    "svelte_get-documentation",
  );
});
