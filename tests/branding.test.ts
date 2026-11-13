import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Requests pick the pool by role, as on a split-role deployment: the data role runs withTeam and the
// public branding read. The session lookup is never used here.
const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));
vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));

import type { AppDb, TeamTx } from "@/db";
import { withDeadlinesAndSnapshot } from "@/db/deadlines";
import { dataRoleHelpers } from "@/db/connection-boundary";
import {
  BRANDING_BASE_COLOURS,
  brandingContrastFailures,
  brandingCss,
  brandingPalette,
  contrastFailureText,
  contrastRatio,
  publicBrandingSchema,
  type BrandingBody,
} from "@/domain/branding";
import {
  BRANDING_KEY,
  JOB_ARCHITECTURE_KEY,
  configBodySchemas,
  type RoleBody,
} from "@/domain/config";
import { RECRUITER_ROLE } from "@/domain/config-defaults";
import { ThemeProvider } from "@/components/theme-provider";
import { revertBranding } from "@/lib/branding";
import {
  createConfigDraft,
  publishConfigVersion,
  updateConfigDraft,
} from "@/lib/config-store";
import type { Principal } from "@/lib/principal";
import type { ApiError } from "@/lib/errors";
import { createRecord } from "@/lib/records";
import { installTenantContext } from "@/lib/tenant-context";
import RootLayout from "@/app/layout";
import SignIn from "@/app/(auth)/sign-in/page";
import { createSplitRoleDb, seedApiToken, seedIdentity } from "./helpers/db";

// Fictional data only: one company workspace with two fictional teams, and a second fictional
// workspace inserted by the owner whose branding the public helper must never return (ADM-36, job
// 097).
const COMPANY = "00000000-0000-4000-a000-000000000001";
const OTHER = "00000000-0000-4000-a000-000000000002";
const TYPE = { type: "branding" } as const;
type Harness = Awaited<ReturnType<typeof createSplitRoleDb>>;
type Row = Record<string, unknown>;

/** Today's globals.css values, which pass every pair. */
const TODAY = {
  light: {
    primary: "#4338ca",
    primaryHover: "#352ba8",
    primarySoft: "#eeedff",
    primaryText: "#4338ca",
    focus: "#8277ee",
  },
  dark: {
    primary: "#b2a9ff",
    primaryHover: "#c7c0ff",
    primarySoft: "#302b53",
    primaryText: "#c4bcff",
    focus: "#8277ee",
  },
};
/** A fictional teal brand that passes every pair. */
const TEAL = {
  accent: "#0f766e",
  palette: brandingPalette("#0f766e"),
  light: {
    primary: "#0f766e",
    primaryHover: "#115e59",
    primarySoft: "#e6f4f1",
    primaryText: "#0f766e",
    focus: "#0f766e",
  },
  dark: {
    primary: "#5eead4",
    primaryHover: "#99f6e4",
    primarySoft: "#123c38",
    primaryText: "#5eead4",
    focus: "#5eead4",
  },
};
const branding = (extra: Partial<BrandingBody> = {}): BrandingBody => ({
  accent: "#4338ca",
  palette: brandingPalette("#4338ca"),
  ...structuredClone(TODAY),
  ...extra,
});
const LOGO = "00000000-0000-4000-a000-0000000000b1";
const FAVICON = "00000000-0000-4000-a000-0000000000b2";

/** A static render of the root layout around children, awaited as Next.js would. */
async function renderLayout(children: ReactNode) {
  return renderToStaticMarkup(await RootLayout({ children }));
}
/** The root layout's markup before ADM-36, for the same children. */
const todaysLayout = (children: ReactNode) =>
  renderToStaticMarkup(
    createElement(
      "html",
      { lang: "en", suppressHydrationWarning: true },
      createElement("body", null, createElement(ThemeProvider, null, children)),
    ),
  );
const signInPage = () => SignIn({ searchParams: Promise.resolve({}) });

describe("the branding domain", () => {
  it("accepts a valid body and stores colours lower-case", () => {
    const parsed = configBodySchemas.branding.parse({
      ...branding({
        accent: "#4338CA",
        logoAssetId: LOGO,
        faviconAssetId: FAVICON,
        signInMessage: " Fictional welcome to the careers team ",
        emailHeader: "Fictional Careers",
      }),
      light: { ...TODAY.light, primary: "#4338CA" },
    });
    expect(parsed).toEqual(
      branding({
        logoAssetId: LOGO,
        faviconAssetId: FAVICON,
        signInMessage: "Fictional welcome to the careers team",
        emailHeader: "Fictional Careers",
      }),
    );
  });

  it("refuses unknown keys, CSS text, URLs, a non-uuid asset id and a palette that differs", () => {
    const refused = (body: unknown, path: (string | number)[]) => {
      const result = configBodySchemas.branding.safeParse(body);
      expect(result.success, JSON.stringify(body)).toBe(false);
      expect(
        result.error?.issues.map((issue) => issue.path),
        JSON.stringify(body),
      ).toContainEqual(path);
    };
    refused({ ...branding(), customCss: "body{}" }, []);
    refused(
      { ...branding(), light: { ...TODAY.light, background: "#ffffff" } },
      ["light"],
    );
    for (const value of [
      "red",
      "#fff",
      "rgb(0,0,0)",
      "var(--x)",
      "url(https://example.test/a.png)",
      "#4338ca; background:url(x)",
      "#4338ca}",
      " #4338ca",
    ]) {
      refused(branding({ accent: value }), ["accent"]);
      refused({ ...branding(), light: { ...TODAY.light, primary: value } }, [
        "light",
        "primary",
      ]);
      refused({ ...branding(), dark: { ...TODAY.dark, focus: value } }, [
        "dark",
        "focus",
      ]);
      refused(
        {
          ...branding(),
          palette: { ...brandingPalette("#4338ca"), "300": value },
        },
        ["palette", "300"],
      );
    }
    refused(branding({ logoAssetId: "https://example.test/logo.png" }), [
      "logoAssetId",
    ]);
    refused(branding({ faviconAssetId: "favicon.ico" }), ["faviconAssetId"]);
    for (const text of [
      "Visit https://example.test",
      "Visit www.example.test today",
      "HTTP://EXAMPLE.TEST",
    ]) {
      refused(branding({ signInMessage: text }), ["signInMessage"]);
      refused(branding({ emailHeader: text }), ["emailHeader"]);
    }
    refused(branding({ signInMessage: "" }), ["signInMessage"]);
    refused(branding({ emailHeader: "a".repeat(121) }), ["emailHeader"]);
    refused(branding({ signInMessage: "a".repeat(501) }), ["signInMessage"]);
    refused(
      branding({
        palette: { ...brandingPalette("#4338ca"), "700": "#2f278e" },
      }),
      ["palette"],
    );
    const { palette: _palette, ...withoutPalette } = branding();
    refused(withoutPalette, ["palette"]);
  });

  it("stores text that looks like HTML or markdown as it is", () => {
    const text = "<b>Fictional welcome</b> **bold** <script>x</script>";
    expect(
      configBodySchemas.branding.parse(
        branding({ signInMessage: text, emailHeader: "# Fictional *header*" }),
      ),
    ).toMatchObject({
      signInMessage: text,
      emailHeader: "# Fictional *header*",
    });
  });

  it("generates a deterministic palette whose 500 step is the accent", () => {
    const palette = brandingPalette("#4338ca");
    expect(palette["500"]).toBe("#4338ca");
    expect(Object.keys(palette)).toEqual([
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
    ]);
    for (const value of Object.values(palette))
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    expect(brandingPalette("#4338ca")).toEqual(palette);
    // Mixed per channel with white (50: 0.92) and black (900: -0.6), rounded.
    expect(palette["50"]).toBe("#f0effb");
    expect(palette["900"]).toBe("#1b1651");
    expect(brandingPalette("#000000")["50"]).toBe("#ebebeb");
    expect(brandingPalette("#ffffff")["900"]).toBe("#666666");
  });

  it("measures WCAG 2.2 contrast", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 10);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 10);
    expect(contrastRatio("#4338ca", "#4338ca")).toBe(1);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.478, 3);
  });

  it("keeps the base colours equal to globals.css, where today's tokens pass every pair", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    const block = (selector: string) =>
      css.slice(css.indexOf(`${selector} {`)).split("}")[0];
    const value = (text: string, property: string) => {
      const raw = new RegExp(`${property}:\\s*(#[0-9a-f]+);`, "i").exec(
        text,
      )![1];
      return (
        raw.length === 4
          ? `#${[...raw.slice(1)].map((digit) => digit + digit).join("")}`
          : raw
      ).toLowerCase();
    };
    const light = block(":root");
    const dark = block(':root[data-theme="dark"]');
    expect(BRANDING_BASE_COLOURS.light).toEqual({
      surface: value(light, "--surface"),
      background: value(light, "--bg"),
      buttonText: value(
        css.slice(css.indexOf(".button {")).split("}")[0],
        "color",
      ),
    });
    expect(BRANDING_BASE_COLOURS.dark).toEqual({
      surface: value(dark, "--surface"),
      background: value(dark, "--bg"),
      buttonText: value(
        css
          .slice(
            css.indexOf(
              ':root[data-theme="dark"] .button:not(.secondary):not(.danger) {',
            ),
          )
          .split("}")[0],
        "color",
      ),
    });
    for (const token of Object.keys(
      TODAY.light,
    ) as (keyof typeof TODAY.light)[])
      expect(
        token === "focus" ? TODAY.light.focus : TODAY.light[token],
        token,
      ).toBe(
        value(
          light,
          token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
        ),
      );
    for (const token of [
      "primary",
      "primaryHover",
      "primarySoft",
      "primaryText",
    ] as const)
      expect(TODAY.dark[token], token).toBe(
        value(
          dark,
          token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
        ),
      );
    // Dark inherits --focus from :root.
    expect(dark).not.toContain("--focus");
    expect(brandingContrastFailures(TODAY)).toEqual([]);
  });

  it("lists every failing pair of both themes, compared unrounded and written truncated", () => {
    const failures = brandingContrastFailures({
      light: { ...TODAY.light, primaryText: "#a5a5ff" },
      dark: { ...TODAY.dark, focus: "#2a2d3a" },
    });
    expect(failures.map((failure) => [failure.theme, failure.pair])).toEqual([
      ["light", "Link text on surface"],
      ["light", "Link text on page background"],
      ["light", "Selected text on its tint"],
      ["dark", "Focus ring on surface"],
      ["dark", "Focus ring on page background"],
    ]);
    // Sixteen checks: every pair fails in both themes when every token is the surface colour.
    expect(
      brandingContrastFailures({
        light: {
          primary: "#ffffff",
          primaryHover: "#ffffff",
          primarySoft: "#ffffff",
          primaryText: "#ffffff",
          focus: "#ffffff",
        },
        dark: {
          primary: "#19152f",
          primaryHover: "#19152f",
          primarySoft: "#1b1e2a",
          primaryText: "#1b1e2a",
          focus: "#1b1e2a",
        },
      }),
    ).toHaveLength(16);
    // #777777 on white is 4.478:1: below 4.5 unrounded, written as 4.47, never rounded up.
    expect(
      contrastFailureText({
        theme: "light",
        pair: "Link text on surface",
        ratio: contrastRatio("#777777", "#ffffff"),
        minimum: 4.5,
      }),
    ).toBe("light: Link text on surface 4.47:1, needs 4.5:1");
    expect(
      contrastFailureText({
        theme: "dark",
        pair: "Focus ring on surface",
        ratio: 2.999,
        minimum: 3,
      }),
    ).toBe("dark: Focus ring on surface 2.99:1, needs 3:1");
  });

  it("writes only the mapped custom properties, light with the palette and dark on its own", () => {
    const css = brandingCss(TEAL);
    expect(css).toBe(
      `:root:root{--primary:#0f766e;--primary-hover:#115e59;--primary-soft:#e6f4f1;--primary-text:#0f766e;--focus:#0f766e;--accent:#0f766e;${Object.entries(
        TEAL.palette,
      )
        .map(([step, value]) => `--accent-${step}:${value};`)
        .join(
          "",
        )}}:root:root[data-theme="dark"]{--primary:#5eead4;--primary-hover:#99f6e4;--primary-soft:#123c38;--primary-text:#5eead4;--focus:#5eead4;}`,
    );
    // Text fields and asset ids never reach the style text, and a value that is not a colour throws.
    expect(
      brandingCss({
        ...TEAL,
        signInMessage: "Fictional text",
        logoAssetId: LOGO,
      } as never),
    ).toBe(css);
    expect(() =>
      brandingCss({
        ...TEAL,
        light: { ...TEAL.light, primary: "red;}body{display:none" },
      }),
    ).toThrow();
  });

  it("checks the public set's shape only and refuses the email header", () => {
    const { emailHeader: _header, ...rest } = branding({
      emailHeader: "Fictional",
    });
    expect(publicBrandingSchema.parse(rest)).toEqual(rest);
    expect(
      publicBrandingSchema.safeParse({ ...rest, emailHeader: "Fictional" })
        .success,
    ).toBe(false);
    // The palette is not recomputed.
    expect(
      publicBrandingSchema.safeParse({
        ...rest,
        palette: brandingPalette("#0f766e"),
      }).success,
    ).toBe(true);
  });
});

describe("branding under the split runtime roles", () => {
  let harness: Harness;
  let owner: Principal, brandingAdmin: Principal, fieldsAdmin: Principal;
  let teamOwnerB: Principal, recruiter: Principal, ownerToken: Principal;
  let ownerX: Principal;
  /** Version ids by name, in the order they are published. */
  const versions: Record<string, string> = {};

  /** Raw reads as the PGlite superuser, which bypasses RLS; only to inspect outcomes. */
  const look = async <T = Row>(text: string, params: unknown[] = []) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
  /** One data-role statement under the principal's verified context. */
  const sqlAs = (principal: Principal, statement: string) =>
    harness.dataDb().then((db) =>
      withDeadlinesAndSnapshot(db, async (tx: TeamTx, snapshot) => {
        await installTenantContext(tx, principal, snapshot);
        return (await tx.execute(sql.raw(statement))).rows as Row[];
      }),
    );
  /** The data role's call of the public helper with no tenant context. */
  const publicRead = async () =>
    (
      await (
        await harness.dataDb()
      ).execute<{ branding: Row | null }>(
        sql`select tenant_context.public_branding() as branding`,
      )
    ).rows[0].branding;
  /** Every config row and every config activity row. */
  const state = async () => ({
    objects: await look("SELECT * FROM app.config_objects ORDER BY id"),
    versions: await look("SELECT * FROM app.config_versions ORDER BY id"),
    activity: await look(
      "SELECT id FROM app.activity WHERE kind = 'config' ORDER BY id",
    ),
  });
  /** The call is refused with this status and code, and no row changes. */
  async function refused(
    call: () => Promise<unknown>,
    status: number,
    code: string,
  ) {
    const before = await state();
    await expect(call()).rejects.toMatchObject({ status, code });
    expect(await state()).toEqual(before);
  }
  /** The company's branding config activity rows, oldest first. */
  const audits = () =>
    look<{ action: string; metadata: Row }>(
      "SELECT action, metadata FROM app.activity WHERE kind = 'config' AND metadata->>'type' = 'branding' AND metadata->>'workspaceId' = $1 ORDER BY created_at, id",
      [COMPANY],
    );
  const draft = (p: Principal, body: unknown) =>
    createConfigDraft(p, { ...TYPE, key: BRANDING_KEY, body });
  async function draftAndPublish(p: Principal, body: unknown) {
    const { versionId } = await draft(p, body);
    const number = await publishConfigVersion(p, versionId, TYPE);
    return { versionId, number };
  }
  const current = async () =>
    (
      await look<{ id: string; number: number; body: Row }>(
        "SELECT v.id, v.number, v.body FROM app.config_objects o JOIN app.config_versions v ON v.id = o.current_version_id WHERE o.type = 'branding' AND o.workspace_id = $1",
        [COMPANY],
      )
    )[0];

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db: AppDb = await harness.asOwner();
    // The first seeded user is the initial administrator; their first team makes them company owner.
    owner = await seedIdentity(db, {
      userId: "brand-owner",
      teamId: "brand-team-a",
    });
    recruiter = await seedIdentity(db, {
      userId: "brand-recruiter",
      teamId: "brand-team-a",
      role: "recruiter",
    });
    teamOwnerB = await seedIdentity(db, {
      userId: "brand-owner-b",
      teamId: "brand-team-b",
    });
    brandingAdmin = await seedIdentity(db, {
      userId: "brand-admin",
      teamId: "brand-team-b",
      role: "recruiter",
    });
    fieldsAdmin = await seedIdentity(db, {
      userId: "brand-fields-admin",
      teamId: "brand-team-b",
      role: "admin",
    });
    ownerX = await seedIdentity(db, {
      userId: "brand-owner-x",
      teamId: "brand-team-x",
    });
    ownerToken = await seedApiToken(db, owner);
    // Company authority and the second workspace are owner-written; no team is created after this.
    await harness.client.exec(`
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES
        ('${COMPANY}','brand-admin','admin','{branding}'),
        ('${COMPANY}','brand-fields-admin','admin','{fields}');
      INSERT INTO app.workspaces(id,name) VALUES ('${OTHER}','Fictional Other Company');
      UPDATE app.workspace_teams SET workspace_id = '${OTHER}' WHERE team_id = 'brand-team-x';
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES
        ('${OTHER}','brand-owner-x','owner','{}');
    `);
  });
  afterAll(async () => harness?.close());

  it("returns SQL null from public_branding while nothing is published, and renders today's layout", async () => {
    expect(await publicRead()).toBeNull();
    const children = createElement("main", null, "Fictional page");
    const markup = await renderLayout(children);
    expect(markup).not.toContain("<style");
    expect(markup).toBe(todaysLayout(children));
  });

  it("refuses every schema failure at draft with 400 invalid_input and stores nothing", async () => {
    for (const body of [
      { ...branding(), customCss: "body{}" },
      { ...branding(), light: { ...TODAY.light, background: "#ffffff" } },
      ...[
        "red",
        "#fff",
        "rgb(0,0,0)",
        "var(--x)",
        "url(https://example.test/a.png)",
        "#4338ca; background:url(x)",
      ].map((value) => branding({ accent: value })),
      branding({ logoAssetId: "https://example.test/logo.png" }),
      branding({ signInMessage: "See https://example.test" }),
      branding({ signInMessage: "See www.example.test" }),
      branding({ emailHeader: "https://example.test" }),
      branding({ emailHeader: "www.example.test" }),
      branding({ palette: { ...brandingPalette("#4338ca"), "50": "#f0effc" } }),
    ])
      await refused(() => draft(owner, body), 400, "invalid_input");
    // And any key but company.
    await refused(
      () =>
        createConfigDraft(owner, {
          ...TYPE,
          key: "fictional",
          body: branding(),
        }),
      400,
      "invalid_input",
    );
  });

  it("saves a draft that fails contrast and refuses its publish with every failing pair", async () => {
    const failing = branding({
      light: { ...TODAY.light, primaryText: "#a5a5ff" },
      dark: { ...TODAY.dark, focus: "#2a2d3a" },
    });
    const { versionId } = await draft(owner, failing);
    const before = await state();
    const error = (await publishConfigVersion(owner, versionId, TYPE).catch(
      (caught: unknown) => caught,
    )) as ApiError;
    expect(error).toMatchObject({ status: 400, code: "branding_contrast" });
    for (const pair of [
      /light: Link text on surface \d+\.\d\d:1, needs 4\.5:1/,
      /light: Link text on page background \d+\.\d\d:1, needs 4\.5:1/,
      /light: Selected text on its tint \d+\.\d\d:1, needs 4\.5:1/,
      /dark: Focus ring on surface \d+\.\d\d:1, needs 3:1/,
      /dark: Focus ring on page background \d+\.\d\d:1, needs 3:1/,
    ])
      expect(error.message).toMatch(pair);
    expect(error.message).toContain("light: Link text on surface 2.22:1");
    expect(await state()).toEqual(before);
    expect(
      await look(
        "SELECT v.state, o.current_version_id FROM app.config_versions v JOIN app.config_objects o ON o.id = v.object_id WHERE v.id = $1",
        [versionId],
      ),
    ).toEqual([{ state: "draft", current_version_id: null }]);
    expect((await audits()).map((row) => row.action)).toEqual([
      "config.draft_created",
    ]);
    // A save that fixes it publishes as number 1.
    await updateConfigDraft(owner, versionId, { body: branding() }, TYPE);
    expect(await publishConfigVersion(owner, versionId, TYPE)).toBe(1);
    versions.first = versionId;
  });

  it("publishes, republishes and reverts through the store, with one audit row per step and never a body", async () => {
    const a = await draftAndPublish(owner, {
      ...TEAL,
      signInMessage: "Fictional teal welcome",
    });
    const b = await draftAndPublish(
      owner,
      branding({ emailHeader: "Fictional B" }),
    );
    expect([a.number, b.number]).toEqual([2, 3]);
    const { versionId } = await revertBranding(owner, a.versionId);
    const [reverted] = await look<{ body: Row; state: string }>(
      "SELECT body, state FROM app.config_versions WHERE id = $1",
      [versionId],
    );
    expect(reverted).toEqual({
      state: "draft",
      body: { ...TEAL, signInMessage: "Fictional teal welcome" },
    });
    // A second revert while the draft exists is refused.
    await refused(
      () => revertBranding(owner, b.versionId),
      409,
      "config_draft_exists",
    );
    expect(await publishConfigVersion(owner, versionId, TYPE)).toBe(4);
    expect(await current()).toEqual({
      id: versionId,
      number: 4,
      body: { ...TEAL, signInMessage: "Fictional teal welcome" },
    });
    const rows = await audits();
    expect(rows.map((row) => [row.action, row.metadata.versionId])).toEqual([
      ["config.draft_created", versions.first],
      ["config.published", versions.first],
      ["config.draft_created", a.versionId],
      ["config.published", a.versionId],
      ["config.draft_created", b.versionId],
      ["config.published", b.versionId],
      ["config.draft_created", versionId],
      ["config.published", versionId],
    ]);
    for (const row of rows) {
      expect(row.metadata).toMatchObject({
        type: "branding",
        key: BRANDING_KEY,
        workspaceId: COMPANY,
      });
      expect(Object.keys(row.metadata).sort()).toEqual([
        "fromVersionId",
        "key",
        "number",
        "objectId",
        "type",
        "versionId",
        "workspaceId",
      ]);
      expect(JSON.stringify(row.metadata)).not.toMatch(
        /Fictional|#[0-9a-f]{6}/,
      );
    }
    versions.a = a.versionId;
    versions.b = b.versionId;
    versions.reverted = versionId;
  });

  it("refuses to revert to a draft or another type's version with 404", async () => {
    const { versionId: pending } = await draft(owner, branding());
    await refused(() => revertBranding(owner, pending), 404, "not_found");
    const architecture = await createConfigDraft(owner, {
      type: "job-architecture",
      key: JOB_ARCHITECTURE_KEY,
      body: { families: [], grades: [], titles: [] },
    });
    await publishConfigVersion(owner, architecture.versionId);
    // Retire nothing; publish the pending branding draft so no draft blocks the next case.
    await publishConfigVersion(owner, pending, TYPE);
    await refused(
      () => revertBranding(owner, architecture.versionId),
      404,
      "not_found",
    );
    await refused(
      () => revertBranding(owner, "00000000-0000-4000-a000-0000000000ff"),
      404,
      "not_found",
    );
    versions.latest = pending;
  });

  it("lets a company admin with branding create, publish and revert", async () => {
    const { versionId, number } = await draftAndPublish(brandingAdmin, TEAL);
    expect(number).toBe(6);
    const reverted = await revertBranding(brandingAdmin, versions.b);
    expect(
      await publishConfigVersion(brandingAdmin, reverted.versionId, TYPE),
    ).toBe(7);
    expect((await current()).body).toEqual(
      branding({ emailHeader: "Fictional B" }),
    );
    versions.admin = versionId;
  });

  it("refuses everyone else with 403 config_forbidden and a direct insert with 42501", async () => {
    const { versionId: pending } = await draft(owner, TEAL);
    for (const p of [fieldsAdmin, teamOwnerB, recruiter, ownerToken]) {
      await refused(() => draft(p, branding()), 403, "config_forbidden");
      await refused(
        () => updateConfigDraft(p, pending, { body: branding() }, TYPE),
        403,
        "config_forbidden",
      );
      await refused(
        () => publishConfigVersion(p, pending, TYPE),
        403,
        "config_forbidden",
      );
      await refused(
        () => revertBranding(p, versions.a),
        403,
        "config_forbidden",
      );
    }
    for (const p of [fieldsAdmin, teamOwnerB, recruiter]) {
      const before = await state();
      await expect(
        sqlAs(
          p,
          `INSERT INTO app.config_objects(workspace_id, type, key) VALUES ('${COMPANY}', 'branding', 'company-two')`,
        ),
        p.userId,
      ).rejects.toMatchObject({ cause: { code: "42501" } });
      await expect(
        sqlAs(p, `SELECT tenant_context.publish_config_version('${pending}')`),
        p.userId,
      ).rejects.toMatchObject({ cause: { code: "42501" } });
      expect(
        await sqlAs(
          p,
          `UPDATE app.config_versions SET note = 'Denied' WHERE id = '${pending}' RETURNING id`,
        ),
        p.userId,
      ).toEqual([]);
      expect(await state()).toEqual(before);
    }
    // Every member context reads the published rows, as for the other non-people areas.
    expect(
      await sqlAs(
        recruiter,
        `SELECT v.id FROM app.config_versions v JOIN app.config_objects o ON o.id = v.object_id WHERE o.type = 'branding' AND v.state = 'published' ORDER BY v.number DESC LIMIT 1`,
      ),
    ).toHaveLength(1);
    await publishConfigVersion(owner, pending, TYPE);
  });

  it("returns only the published public set from public_branding, never the draft or another workspace", async () => {
    await draftAndPublish(owner, {
      ...TEAL,
      logoAssetId: LOGO,
      faviconAssetId: FAVICON,
      signInMessage: "Fictional published message",
      emailHeader: "Fictional private header",
    });
    const newer = await draft(owner, {
      ...TEAL,
      signInMessage: "Fictional newer draft",
    });
    // The second workspace's company owner publishes its own branding.
    await draftAndPublish(ownerX, {
      ...branding(),
      signInMessage: "Fictional other workspace",
    });
    const value = await publicRead();
    expect(value).toEqual({
      ...TEAL,
      logoAssetId: LOGO,
      faviconAssetId: FAVICON,
      signInMessage: "Fictional published message",
    });
    expect(
      Object.keys(value!).every((key) =>
        [
          "accent",
          "palette",
          "light",
          "dark",
          "logoAssetId",
          "faviconAssetId",
          "signInMessage",
        ].includes(key),
      ),
    ).toBe(true);
    const text = JSON.stringify(value);
    for (const leak of [
      "emailHeader",
      "Fictional private header",
      "Fictional newer draft",
      "Fictional other workspace",
      COMPANY,
      OTHER,
      ...Object.values(versions),
    ])
      expect(text, leak).not.toContain(leak);
    expect(text).not.toMatch(/\d{4}-\d\d-\d\dT/);
    // Optional keys the body lacks are left out.
    await updateConfigDraft(owner, newer.versionId, { body: TEAL }, TYPE);
    await publishConfigVersion(owner, newer.versionId, TYPE);
    expect(await publicRead()).toEqual(TEAL);
  });

  it("refuses the identity role EXECUTE and keeps the helper owner-run, definer and closed to PUBLIC", async () => {
    const identity = await harness.identityDb();
    await expect(
      identity.execute(sql`select tenant_context.public_branding()`),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
    expect(
      await look(
        `SELECT p.proowner = (SELECT nspowner FROM pg_namespace WHERE nspname = 'tenant_context') AS owned,
           p.prosecdef AS definer, p.provolatile AS volatility, p.proconfig AS config,
           has_function_privilege('public', p.oid, 'EXECUTE') AS public,
           has_function_privilege('recruitmentos_data', p.oid, 'EXECUTE') AS data,
           has_function_privilege('recruitmentos_identity', p.oid, 'EXECUTE') AS identity
         FROM pg_proc p WHERE p.oid = 'tenant_context.public_branding()'::regprocedure`,
      ),
    ).toEqual([
      {
        owned: true,
        definer: true,
        volatility: "s",
        config: ["search_path=pg_catalog, pg_temp"],
        public: false,
        data: true,
        identity: false,
      },
    ]);
    expect(dataRoleHelpers).toContain("tenant_context.public_branding()");
    expect(dataRoleHelpers).toHaveLength(51);
  });

  it("writes the published tokens as custom properties in one style element of the root layout", async () => {
    const markup = await renderLayout(createElement("main", null, "Fictional"));
    expect(markup.match(/<style/g)).toHaveLength(1);
    expect(markup).toContain(`<style>${brandingCss(TEAL)}</style>`);
    expect(markup).toMatch(/:root:root\{[^}]*--primary:#0f766e;/);
    expect(markup).toMatch(/:root:root\{[^}]*--accent-500:#0f766e;/);
    expect(markup).toMatch(
      /:root:root\[data-theme="dark"\]\{[^}]*--primary:#5eead4;/,
    );
  });

  it("renders today's markup and logs one safe line when the read fails", async () => {
    const children = createElement("main", null, "Fictional");
    const lines: string[] = [];
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation((line: string) => void lines.push(line));
    try {
      pools.data.mockRejectedValueOnce(new TypeError("Fictional pool failure"));
      expect(await renderLayout(children)).toBe(todaysLayout(children));
      await harness.asOwner();
      await harness.client.exec(
        "REVOKE EXECUTE ON FUNCTION tenant_context.public_branding() FROM recruitmentos_data",
      );
      expect(await renderLayout(children)).toBe(todaysLayout(children));
    } finally {
      await harness.asOwner();
      await harness.client.exec(
        "GRANT EXECUTE ON FUNCTION tenant_context.public_branding() TO recruitmentos_data",
      );
      logged.mockRestore();
    }
    expect(lines).toEqual([
      "branding_read_failed category=TypeError",
      "branding_read_failed category=DrizzleQueryError sqlstate=42501",
    ]);
  });

  it("renders the sign-in page from public_branding alone and leaks no configuration or record data", async () => {
    const canary = (name: string) => `Canary${name}7f3a`;
    const role = await createConfigDraft(owner, {
      type: "role",
      key: "canary-role",
      body: {
        ...structuredClone(RECRUITER_ROLE.body as RoleBody),
        name: canary("Role"),
      },
    });
    await publishConfigVersion(owner, role.versionId);
    const architecture = await createConfigDraft(owner, {
      type: "job-architecture",
      key: JOB_ARCHITECTURE_KEY,
      body: {
        families: [{ key: "canary", name: canary("Family") }],
        grades: [{ code: "G1", name: canary("Grade"), order: 1 }],
        titles: [
          {
            key: "canary-title",
            name: canary("Title"),
            familyKey: "canary",
            gradeCode: "G1",
          },
        ],
      },
    });
    await publishConfigVersion(owner, architecture.versionId);
    const candidate = await createRecord(owner, "candidates", {
      data: { name: canary("Candidate") },
    });
    const vacancy = await createRecord(owner, "vacancies", {
      data: { title: canary("Vacancy") },
    });
    const published = await draftAndPublish(owner, {
      ...TEAL,
      signInMessage: "Fictional public sign-in message",
      emailHeader: canary("EmailHeader"),
    });
    const newer = await draft(owner, {
      ...TEAL,
      signInMessage: canary("DraftMessage"),
    });
    const ids = (
      await look<{ id: string }>(
        'SELECT id::text FROM app.config_objects UNION ALL SELECT id::text FROM app.config_versions UNION ALL SELECT id::text FROM app.records UNION ALL SELECT id FROM auth."user" UNION ALL SELECT id FROM auth.organization UNION ALL SELECT id::text FROM app.workspaces',
      )
    ).map((row) => row.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        COMPANY,
        "brand-team-a",
        "brand-owner",
        published.versionId,
        newer.versionId,
        role.objectId,
        candidate.id,
        vacancy.id,
      ]),
    );

    // Every statement on either pool while rendering, after the pool's role is chosen.
    await harness.dataDb();
    pools.data.mockClear();
    pools.identity.mockClear();
    const statements: string[] = [];
    const run = harness.client.query.bind(harness.client);
    const query = vi
      .spyOn(harness.client, "query")
      .mockImplementation((...args: Parameters<typeof run>) => {
        statements.push(args[0]);
        return run(...args);
      });
    const transaction = vi
      .spyOn(harness.client, "transaction")
      .mockImplementation(() => {
        statements.push("transaction");
        throw new Error("No transaction is expected before sign-in.");
      });
    let markup: string;
    try {
      markup = await renderLayout(await signInPage());
    } finally {
      query.mockRestore();
      transaction.mockRestore();
    }
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements)
      expect(statement).toBe(
        "select tenant_context.public_branding() as branding",
      );
    expect(pools.identity).not.toHaveBeenCalled();
    expect(markup).toContain("<p>Fictional public sign-in message</p>");
    expect(markup).toContain(`<style>${brandingCss(TEAL)}</style>`);
    for (const leak of [
      ...[
        "Role",
        "Family",
        "Grade",
        "Title",
        "Candidate",
        "Vacancy",
        "EmailHeader",
        "DraftMessage",
      ].map(canary),
      ...ids,
      LOGO,
      FAVICON,
    ])
      expect(markup, leak).not.toContain(leak);
    // The newer draft is published only after the check, so nothing else reads it.
    await publishConfigVersion(owner, newer.versionId, TYPE);
  });

  it("renders the sign-in message as escaped plain text in one paragraph", async () => {
    const text = "<b>Fictional welcome</b> **bold** <script>x</script>";
    await draftAndPublish(owner, { ...TEAL, signInMessage: text });
    expect((await current()).body.signInMessage).toBe(text);
    const markup = await renderLayout(await signInPage());
    expect(markup).toContain(
      "<p>&lt;b&gt;Fictional welcome&lt;/b&gt; **bold** &lt;script&gt;x&lt;/script&gt;</p>",
    );
    expect(markup).not.toContain("<b>");
    expect(markup).not.toContain("<script");
    // The only strong element is the page's own setup notice, as without a message.
    await draftAndPublish(owner, TEAL);
    const plain = await renderLayout(await signInPage());
    expect(markup.match(/<strong/g)?.length ?? 0).toBe(
      plain.match(/<strong/g)?.length ?? 0,
    );
    expect(plain).not.toContain("Fictional welcome");
  });
});
