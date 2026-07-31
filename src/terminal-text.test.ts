import { describe, expect, test } from "bun:test";
import { displayWidth, sanitizeText, truncateWidth } from "./terminal-text";

describe("terminal text", () => {
  test("truncates by display width without splitting graphemes", () => {
    expect(truncateWidth("abcdef", 4)).toBe("abc…");
    expect(truncateWidth("界界界", 5)).toBe("界界…");
    expect(truncateWidth("👨‍👩‍👧‍👦 family", 4)).toBe("👨‍👩‍👧‍👦 …");
    expect(displayWidth("🇮🇩")).toBe(2);
    expect(displayWidth("1️⃣")).toBe(2);
  });

  test("strips invisible format controls without breaking emoji joins", () => {
    expect(sanitizeText("safe\u200b\u202eevil")).toBe("safeevil");
    expect(sanitizeText("safe\u200dtext")).toBe("safetext");
    expect(sanitizeText("👨\u200dtext")).toBe("👨text");
    expect(sanitizeText("👨‍👩‍👧‍👦")).toBe("👨‍👩‍👧‍👦");
    expect(sanitizeText("🏴󠁧󠁢󠁳󠁣󠁴󠁿")).toBe("🏴󠁧󠁢󠁳󠁣󠁴󠁿");
    expect(displayWidth("\u0301\u200d\ufe0f")).toBe(0);
  });
});
