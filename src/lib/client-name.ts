// Control, format (bidi overrides, zero-width), private-use, surrogate and unassigned code points,
// plus the invisible fillers and variation selectors outside those categories. Each code point is
// removed on its own, so a variation selector in the class is intended.
const INVISIBLE =
  // eslint-disable-next-line no-misleading-character-class
  /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\u034F\u115F\u1160\u3164\uFFA0\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;
const SEPARATORS = /[\p{Zs}\p{Zl}\p{Zp}]+/gu;

/** An app-supplied client name as shown on the consent page: visible characters, single spaces. */
export function cleanClientName(value: string): string {
  return value.replace(INVISIBLE, "").replace(SEPARATORS, " ").trim();
}
