// Company branding (architecture §14.8, ADM-36): design tokens only. Pure: no I/O and no
// environment. It imports field-types.ts and record-schemas.ts, never config.ts, which imports it.
import { z } from "zod";
import { configHelpText, configLabel } from "./field-types";
import { uuidSchema } from "./record-schemas";

/** Exactly `#` and six hex digits; anything else, CSS text included, is refused. */
export const COLOUR_PATTERN = /^#[0-9a-f]{6}$/i;
const colour = z
  .string()
  .regex(COLOUR_PATTERN, "A colour is # and six hex digits.")
  .overwrite((value) => value.toLowerCase());

export const PALETTE_STEPS = [
  "50",
  "100",
  "200",
  "300",
  "400",
  "500",
  "600",
  "700",
  "800",
  "900",
] as const;
export type PaletteStep = (typeof PALETTE_STEPS)[number];
/** Positive mixes with white, negative with black; 500 is the accent itself (BRD-003). */
const PALETTE_FACTORS: Record<PaletteStep, number> = {
  "50": 0.92,
  "100": 0.84,
  "200": 0.68,
  "300": 0.5,
  "400": 0.25,
  "500": 0,
  "600": -0.15,
  "700": -0.3,
  "800": -0.45,
  "900": -0.6,
};

export const THEME_TOKENS = [
  "primary",
  "primaryHover",
  "primarySoft",
  "primaryText",
  "focus",
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];
export type ThemeTokens = Record<ThemeToken, string>;
export type Palette = Record<PaletteStep, string>;

const channels = (hex: string) =>
  [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));

/** The palette generated from the accent: each sRGB channel mixed linearly, then rounded. */
export function brandingPalette(accent: string): Palette {
  const rgb = channels(accent);
  return Object.fromEntries(
    PALETTE_STEPS.map((step) => {
      const factor = PALETTE_FACTORS[step];
      const mixed = rgb.map((channel) =>
        Math.round(
          factor >= 0
            ? channel + (255 - channel) * factor
            : channel * (1 + factor),
        ),
      );
      return [
        step,
        `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`,
      ];
    }),
  ) as Palette;
}

/** WCAG 2.2 relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG 2.2 contrast ratio of two #rrggbb colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

export const BRANDING_THEMES = ["light", "dark"] as const;
export type BrandingTheme = (typeof BRANDING_THEMES)[number];
/** The fixed colours tokens are drawn on or under, as in src/app/globals.css. */
export const BRANDING_BASE_COLOURS: Record<
  BrandingTheme,
  { surface: string; background: string; buttonText: string }
> = {
  light: { surface: "#ffffff", background: "#f5f6fa", buttonText: "#ffffff" },
  dark: { surface: "#1b1e2a", background: "#11131c", buttonText: "#19152f" },
};

type Base = (typeof BRANDING_BASE_COLOURS)[BrandingTheme];
/** The token pairs checked at publish in each theme: label, foreground, background and minimum. */
const CONTRAST_PAIRS: [
  string,
  (tokens: ThemeTokens, base: Base) => string,
  (tokens: ThemeTokens, base: Base) => string,
  number,
][] = [
  ["Button text on primary", (_, b) => b.buttonText, (t) => t.primary, 4.5],
  [
    "Button text on primary hover",
    (_, b) => b.buttonText,
    (t) => t.primaryHover,
    4.5,
  ],
  ["Link text on surface", (t) => t.primaryText, (_, b) => b.surface, 4.5],
  [
    "Link text on page background",
    (t) => t.primaryText,
    (_, b) => b.background,
    4.5,
  ],
  [
    "Selected text on its tint",
    (t) => t.primaryText,
    (t) => t.primarySoft,
    4.5,
  ],
  ["Primary colour on surface", (t) => t.primary, (_, b) => b.surface, 3],
  ["Focus ring on surface", (t) => t.focus, (_, b) => b.surface, 3],
  ["Focus ring on page background", (t) => t.focus, (_, b) => b.background, 3],
];

export type ContrastFailure = {
  theme: BrandingTheme;
  pair: string;
  ratio: number;
  minimum: number;
};

/** Every failing pair of both themes (WCAG 2.2 AA), compared on the unrounded ratio. */
export function brandingContrastFailures(body: {
  light: ThemeTokens;
  dark: ThemeTokens;
}): ContrastFailure[] {
  return BRANDING_THEMES.flatMap((theme) =>
    CONTRAST_PAIRS.flatMap(([pair, foreground, background, minimum]) => {
      const base = BRANDING_BASE_COLOURS[theme];
      const ratio = contrastRatio(
        foreground(body[theme], base),
        background(body[theme], base),
      );
      return ratio < minimum ? [{ theme, pair, ratio, minimum }] : [];
    }),
  );
}

/** `<theme>: <pair> <ratio>:1, needs <minimum>:1`, the ratio truncated to two decimals. */
export function contrastFailureText(failure: ContrastFailure): string {
  const ratio = (Math.floor(failure.ratio * 100) / 100).toFixed(2);
  return `${failure.theme}: ${failure.pair} ${ratio}:1, needs ${failure.minimum}:1`;
}

// A web address in text shown before sign-in could be used for phishing, even as plain text.
const WEB_ADDRESS = /[a-z][a-z0-9+.-]*:\/\/|www\./i;
const plainText = <T extends z.ZodType<string>>(schema: T) =>
  schema.refine(
    (text) => !WEB_ADDRESS.test(text),
    "Web addresses are not allowed.",
  );

const themeTokens = z
  .object(
    Object.fromEntries(THEME_TOKENS.map((token) => [token, colour])) as Record<
      ThemeToken,
      typeof colour
    >,
  )
  .strict();
const palette = z
  .object(
    Object.fromEntries(PALETTE_STEPS.map((step) => [step, colour])) as Record<
      PaletteStep,
      typeof colour
    >,
  )
  .strict();

/**
 * The company branding body: the accent, the palette generated from it, the light and dark tokens,
 * the logo and favicon asset ids, and two plain texts. Strict on every level and hex only, so no
 * CSS text, URL or unknown key is stored; text that looks like HTML or markdown is stored as it
 * is and only ever rendered escaped.
 */
export const brandingBodySchema = z
  .object({
    accent: colour,
    palette,
    light: themeTokens,
    dark: themeTokens,
    logoAssetId: uuidSchema.optional(),
    faviconAssetId: uuidSchema.optional(),
    signInMessage: plainText(configHelpText.min(1)).optional(),
    emailHeader: plainText(configLabel).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const expected = brandingPalette(body.accent);
    if (PALETTE_STEPS.some((step) => body.palette[step] !== expected[step]))
      ctx.addIssue({
        code: "custom",
        path: ["palette"],
        message: "The palette is generated from the accent.",
      });
  });
export type BrandingBody = z.output<typeof brandingBodySchema>;

/**
 * What tenant_context.public_branding() returns before sign-in: never the email header. Shape only;
 * the palette is not recomputed.
 */
export const publicBrandingSchema = z
  .object({
    accent: colour,
    palette,
    light: themeTokens,
    dark: themeTokens,
    logoAssetId: uuidSchema.optional(),
    faviconAssetId: uuidSchema.optional(),
    signInMessage: configHelpText.min(1).optional(),
  })
  .strict();
export type PublicBranding = z.output<typeof publicBrandingSchema>;

/** Token names to CSS custom properties; the palette steps go to --accent-<step>. */
const THEME_PROPERTIES: Record<ThemeToken, string> = {
  primary: "--primary",
  primaryHover: "--primary-hover",
  primarySoft: "--primary-soft",
  primaryText: "--primary-text",
  focus: "--focus",
};

/**
 * The style text for the published tokens: light values and the palette on :root:root, dark values
 * on :root:root[data-theme="dark"], which outrank globals.css in either order. Every value is
 * checked again; nothing but these properties and colours is written.
 */
export function brandingCss(
  tokens: Pick<PublicBranding, "accent" | "palette" | "light" | "dark">,
): string {
  const declaration = (property: string, value: string) => {
    if (!COLOUR_PATTERN.test(value))
      throw new Error(`Branding token ${property} is not a colour.`);
    return `${property}:${value.toLowerCase()};`;
  };
  const theme = (values: ThemeTokens) =>
    THEME_TOKENS.map((token) =>
      declaration(THEME_PROPERTIES[token], values[token]),
    ).join("");
  const light =
    theme(tokens.light) +
    declaration("--accent", tokens.accent) +
    PALETTE_STEPS.map((step) =>
      declaration(`--accent-${step}`, tokens.palette[step]),
    ).join("");
  return `:root:root{${light}}:root:root[data-theme="dark"]{${theme(tokens.dark)}}`;
}
