/**
 * Provides text operations bounded by terminal display width.
 */
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
