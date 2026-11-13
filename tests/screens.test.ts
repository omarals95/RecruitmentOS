import { describe, expect, it } from "vitest";
import {
  CONFIGURABLE_KINDS,
  kindSchemaBodySchema,
  type KindSchemaBody,
} from "@/domain/config";
import { DEFAULT_KIND_SCHEMAS } from "@/domain/config-defaults";
import { compileKindSchema } from "@/domain/field-types";
import {
  requiredOffCreate,
  requiredOffCreateText,
} from "@/domain/kind-schema-changes";
import { systemFieldKeys } from "@/domain/record-schemas";
import {
  mandatoryKeys,
  readOnlyKeys,
  screenFor,
  shownKeys,
  type Screen,
} from "@/domain/screens";

// R2b-07 (job 090): screens per kind, type and action. Fictional ids and labels only.
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TYPE = uuid(9001);
const OTHER_TYPE = uuid(9002);
const REQUIRED_CUSTOM = uuid(9101);
const ARCHIVED_CUSTOM = uuid(9102);
const CONTACT = ["phone", "email", "employer"];

type Entry = { key: string; hidden?: boolean; mandatory?: boolean };
type RawScreen = {
  type?: string;
  action: string;
  groups: { label?: string; fields: Entry[] }[];
};
type RawBody = Omit<KindSchemaBody, "screens" | "fields"> & {
  fields: Record<string, unknown>[];
  screens: RawScreen[];
};

const candidateKeys = systemFieldKeys("candidate");
const entries = (keys: readonly string[]) => keys.map((key) => ({ key }));
// Every key but the contact keys, then a "Fictional contact" group listing phone before email,
// with email mandatory and employer hidden.
const contactScreen = (action: string, type?: string): RawScreen => ({
  ...(type ? { type } : {}),
  action,
  groups: [
    {
      fields: entries(
        [...candidateKeys, REQUIRED_CUSTOM, ARCHIVED_CUSTOM].filter(
          (key) => !CONTACT.includes(key),
        ),
      ),
    },
    {
      label: "Fictional contact",
      fields: [
        { key: "phone" },
        { key: "email", mandatory: true },
        { key: "employer", hidden: true },
      ],
    },
  ],
});
/**
 * A fictional candidate body: a required and an archived required custom field, the default
 * create, edit and view screens, a typed edit screen hiding the required custom field and a typed
 * transition screen; with `fill`, typed view screens up to 40 screens in all.
 */
const configured = (fill = true): RawBody => {
  const body = structuredClone(DEFAULT_KIND_SCHEMAS.candidate.body) as RawBody;
  body.fields.push(
    {
      key: REQUIRED_CUSTOM,
      system: false,
      label: "Fictional required",
      type: "short-text",
      required: true,
    },
    {
      key: ARCHIVED_CUSTOM,
      system: false,
      label: "Fictional retired",
      type: "short-text",
      required: true,
      archived: true,
    },
  );
  body.screens = [
    contactScreen("create"),
    contactScreen("edit"),
    contactScreen("view"),
    {
      type: TYPE,
      action: "edit",
      groups: [
        {
          fields: [
            ...entries(candidateKeys),
            { key: REQUIRED_CUSTOM, hidden: true },
            { key: ARCHIVED_CUSTOM },
          ],
        },
      ],
    },
    {
      type: TYPE,
      action: "transition",
      groups: [
        {
          label: "Fictional review",
          fields: [
            { key: "reviewStatus" },
            { key: "sourceNotes", mandatory: true },
          ],
        },
      ],
    },
  ];
  if (fill)
    for (let n = 0; body.screens.length < 40; n++)
      body.screens.push({
        type: uuid(9200 + n),
        action: "view",
        groups: [{ fields: entries(candidateKeys) }],
      });
  return body;
};
const issuesOf = (body: unknown) => {
  const result = kindSchemaBodySchema.safeParse(body);
  return result.success ? [] : result.error.issues;
};
/** The body after `change` is refused, and every issue points into screens or fields. */
const refusedBy = (
  change: (body: RawBody) => void,
  base = configured(false),
) => {
  change(base);
  const issues = issuesOf(base);
  expect(issues.length).toBeGreaterThan(0);
  for (const issue of issues)
    expect(["screens", "fields"], JSON.stringify(issue)).toContain(
      issue.path[0],
    );
  return issues;
};
const screen = (body: RawBody, action: string, type?: string) =>
  body.screens.find((item) => item.action === action && item.type === type)!;
const field = (body: RawBody, key: string) =>
  body.fields.find((item) => item.key === key)!;

describe("screens per kind, type and action (R2b-07)", () => {
  it("accepts typed, grouped and reordered screens with hidden and mandatory entries, unchanged", () => {
    const body = configured();
    expect(body.screens).toHaveLength(40);
    const result = kindSchemaBodySchema.safeParse(body);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    expect(result.data).toStrictEqual(body);
    // Phone before email, in a labelled group after an unlabelled one.
    const create = result.data!.screens[0];
    expect(create.groups.map((group) => group.label)).toEqual([
      undefined,
      "Fictional contact",
    ]);
    expect(create.groups[1].fields.map(({ key }) => key)).toEqual(CONTACT);
  });

  it("refuses unknown, repeated and duplicate-screen keys and missing default screens", () => {
    refusedBy((body) =>
      screen(body, "edit").groups[0].fields.push({ key: "suitability" }),
    );
    refusedBy((body) =>
      screen(body, "edit").groups[0].fields.push({ key: "name" }),
    );
    refusedBy((body) =>
      screen(body, "edit").groups[1].fields.push({ key: "name" }),
    );
    refusedBy((body) =>
      body.screens.push(structuredClone(screen(body, "edit"))),
    );
    refusedBy((body) =>
      body.screens.push(structuredClone(screen(body, "edit", TYPE))),
    );
    for (const action of ["create", "edit", "view"]) {
      const issues = refusedBy((body) =>
        body.screens.splice(body.screens.indexOf(screen(body, action)), 1),
      );
      expect(issues.map((issue) => issue.message)).toContain(
        `A default ${action} screen is required.`,
      );
    }
    // A default transition screen is optional, and a second typed one is refused.
    refusedBy((body) =>
      body.screens.push(structuredClone(screen(body, "transition", TYPE))),
    );
  });

  it("refuses a create screen that leaves out or hides a required system field", () => {
    const typedCreate = (body: RawBody) => {
      body.screens.push({ ...contactScreen("create"), type: OTHER_TYPE });
      return screen(body, "create", OTHER_TYPE);
    };
    expect(
      issuesOf(
        (() => {
          const body = configured(false);
          typedCreate(body);
          return body;
        })(),
      ),
    ).toEqual([]);
    for (const pick of [
      (body: RawBody) => screen(body, "create"),
      typedCreate,
    ]) {
      refusedBy((body) => {
        const group = pick(body).groups[0];
        group.fields = group.fields.filter(({ key }) => key !== "name");
      });
      refusedBy((body) => {
        pick(body).groups[0].fields.find(({ key }) => key === "name")!.hidden =
          true;
      });
    }
    // Email becomes required, so the create screen may not hide it.
    refusedBy((body) => {
      field(body, "email").required = true;
      screen(body, "create").groups[1].fields[1] = {
        key: "email",
        hidden: true,
      };
    });
    // Hidden and mandatory together are refused on any screen.
    refusedBy((body) => {
      screen(body, "view").groups[1].fields[0] = {
        key: "phone",
        hidden: true,
        mandatory: true,
      };
    });
  });

  it("lets configuration only tighten a system field", () => {
    refusedBy((body) => (field(body, "name").type = "textarea"));
    refusedBy((body) => (field(body, "name").required = false));
    refusedBy((body) => (field(body, "rawSource").readOnly = false));
    const offer = () =>
      structuredClone(DEFAULT_KIND_SCHEMAS.offer.body) as RawBody;
    for (const options of [
      ["Monthly", "Annual", "Hourly", "One-time", "Weekly"],
      ["Monthly", "Annual", "Hourly"],
      ["Annual", "Monthly", "Hourly", "One-time"],
    ])
      refusedBy(
        (body) => (field(body, "payPeriod").options = options),
        offer(),
      );
    // Relabelling, requiring an optional field and making an editable field read-only are fine.
    for (const change of [
      (body: RawBody) => (field(body, "name").label = "Fictional full name"),
      (body: RawBody) => (field(body, "email").required = true),
      (body: RawBody) => (field(body, "phone").readOnly = true),
    ]) {
      const body = configured();
      change(body);
      expect(issuesOf(body)).toEqual([]);
    }
  });

  it("refuses a bad type, unknown keys, and screens, groups or entries past their caps", () => {
    refusedBy((body) => (screen(body, "edit", TYPE).type = "fictional-type"));
    refusedBy(
      (body) => ((screen(body, "edit") as Record<string, unknown>).extra = 1),
    );
    refusedBy(
      (body) =>
        ((screen(body, "edit").groups[0] as Record<string, unknown>).extra = 1),
    );
    refusedBy(
      (body) =>
        ((
          screen(body, "edit").groups[0].fields[0] as Record<string, unknown>
        ).extra = 1),
    );
    refusedBy(
      (body) =>
        body.screens.push({
          type: uuid(9999),
          action: "view",
          groups: [{ fields: entries(candidateKeys) }],
        }),
      configured(),
    );
    refusedBy((body) => {
      screen(body, "view").groups = candidateKeys
        .slice(0, 21)
        .map((key) => ({ fields: [{ key }] }));
    });
    expect(
      issuesOf(
        (() => {
          const body = configured(false);
          screen(body, "view").groups = candidateKeys
            .slice(0, 20)
            .map((key) => ({ fields: [{ key }] }));
          return body;
        })(),
      ),
    ).toEqual([]);
    refusedBy((body) => screen(body, "view").groups.push({ fields: [] }));
    const issues = refusedBy((body) => {
      screen(body, "view").groups = [
        { fields: Array.from({ length: 100 }, () => ({ key: "name" })) },
        { fields: Array.from({ length: 51 }, () => ({ key: "name" })) },
      ];
    });
    expect(issues.map((issue) => issue.message)).toContain(
      "A screen lists at most 150 fields.",
    );
    refusedBy(
      (body) => (screen(body, "view").groups[1].label = "x".repeat(121)),
    );
    const longest = configured(false);
    screen(longest, "view").groups[1].label = "x".repeat(120);
    expect(issuesOf(longest)).toEqual([]);
  });

  it("gives every kind's default screen for each action and any type, and no default transition", () => {
    for (const kind of CONFIGURABLE_KINDS) {
      const body = DEFAULT_KIND_SCHEMAS[kind].body;
      for (const action of ["create", "edit", "view"] as const)
        for (const type of [null, uuid(9300)]) {
          const found = screenFor(body, type, action);
          expect(found, `${kind} ${action}`).toStrictEqual({
            action,
            groups: [{ fields: entries(systemFieldKeys(kind)) }],
          });
          expect(shownKeys(found)).toEqual(systemFieldKeys(kind));
        }
      expect(screenFor(body, null, "transition")).toBeUndefined();
      expect(screenFor(body, uuid(9300), "transition")).toBeUndefined();
    }
  });

  it("finds the typed screen for its type and the default screen for another type", () => {
    const body = kindSchemaBodySchema.parse(configured());
    const typedEdit = screenFor(body, TYPE, "edit");
    expect(typedEdit.type).toBe(TYPE);
    expect(screenFor(body, OTHER_TYPE, "edit")).toBe(
      screenFor(body, null, "edit"),
    );
    expect(screenFor(body, null, "edit").type).toBeUndefined();
    expect(screenFor(body, TYPE, "transition")?.groups[0].label).toBe(
      "Fictional review",
    );
    expect(screenFor(body, null, "transition")).toBeUndefined();
    expect(screenFor(body, OTHER_TYPE, "transition")).toBeUndefined();
    // Shown keys follow group and entry order and leave hidden entries out.
    const create = screenFor(body, null, "create");
    expect(shownKeys(create).slice(-3)).toEqual([
      ARCHIVED_CUSTOM,
      "phone",
      "email",
    ]);
    expect(shownKeys(create)).not.toContain("employer");
  });

  it("makes shown required and mandatory-flagged fields mandatory, never hidden or archived ones", () => {
    const body = kindSchemaBodySchema.parse(configured());
    const keysOf = (found: Screen | undefined) => mandatoryKeys(body, found!);
    expect(keysOf(screenFor(body, null, "create"))).toEqual([
      "name",
      REQUIRED_CUSTOM,
      "email",
    ]);
    // The typed edit screen hides the required custom field; the archived one is never mandatory.
    expect(keysOf(screenFor(body, TYPE, "edit"))).toEqual(["name"]);
    expect(keysOf(screenFor(body, TYPE, "transition"))).toEqual([
      "sourceNotes",
    ]);
    // The engine reads the same screens through the same fallback.
    const compiled = compileKindSchema({ versionId: uuid(9400), body });
    expect(compiled.mandatoryFor(null, "create")).toEqual([
      "name",
      REQUIRED_CUSTOM,
      "email",
    ]);
    expect(compiled.mandatoryFor(TYPE, "edit")).toEqual(["name"]);
    expect(compiled.mandatoryFor(OTHER_TYPE, "edit")).toEqual(
      compiled.mandatoryFor(null, "edit"),
    );
    expect(compiled.mandatoryFor(OTHER_TYPE, "transition")).toEqual([]);
    expect(compiled.mandatory[`${TYPE}/transition`]).toEqual(["sourceNotes"]);
    expect(Object.isFrozen(compiled.mandatory)).toBe(true);
  });

  it("compiles today's mandatory lists from the default bodies", () => {
    const today = (kind: (typeof CONFIGURABLE_KINDS)[number]) =>
      compileKindSchema(DEFAULT_KIND_SCHEMAS[kind]).mandatory;
    expect(today("candidate")).toEqual({
      create: ["name"],
      edit: ["name"],
      view: ["name"],
    });
    expect(today("interview")).toEqual({
      create: ["title", "startAt"],
      edit: ["title", "startAt"],
      view: ["title", "startAt"],
    });
    expect(today("onboarding")).toEqual({ create: [], edit: [], view: [] });
    for (const kind of CONFIGURABLE_KINDS) {
      const compiled = compileKindSchema(DEFAULT_KIND_SCHEMAS[kind]);
      expect(compiled.mandatoryFor(uuid(9300), "create")).toBe(
        compiled.mandatory.create,
      );
    }
  });
});

// R2b-10 (job 102): a read-only flag per screen entry, and the publish check that every required
// field is on its create screens (FLD-032). Fictional ids and labels only.
describe("read-only entries and required fields off a create screen (R2b-10)", () => {
  type Flagged = Entry & { readOnly?: boolean };
  const candidate = () =>
    structuredClone(DEFAULT_KIND_SCHEMAS.candidate.body) as RawBody;
  const entryOf = (body: RawBody, action: string, key: string) =>
    screen(body, action).groups[0].fields.find(
      (entry) => entry.key === key,
    )! as Flagged;
  const typedCreate = (body: RawBody, type: string) => {
    body.screens.push({
      type,
      action: "create",
      groups: [{ fields: entries(candidateKeys) }],
    });
    return screen(body, "create", type);
  };

  it("accepts read-only entries unchanged, and refuses one also hidden or mandatory, or a read-only required field on a create screen", () => {
    const body = candidate();
    entryOf(body, "edit", "phone").readOnly = true;
    entryOf(body, "create", "email").readOnly = true;
    const result = kindSchemaBodySchema.safeParse(body);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    expect(result.data).toStrictEqual(body);
    const refusal = (change: (body: RawBody) => void, message: string) => {
      const issues = refusedBy(change, candidate());
      expect(issues.map((issue) => issue.message)).toEqual([message]);
      expect(issues[0].path.slice(0, 5)).toEqual([
        "screens",
        expect.any(Number),
        "groups",
        0,
        "fields",
      ]);
    };
    const both = "A read-only field cannot be hidden or mandatory.";
    refusal(
      (body) =>
        Object.assign(entryOf(body, "edit", "phone"), {
          readOnly: true,
          hidden: true,
        }),
      both,
    );
    refusal(
      (body) =>
        Object.assign(entryOf(body, "view", "phone"), {
          readOnly: true,
          mandatory: true,
        }),
      both,
    );
    const fill =
      "A create screen lets people fill every required system field.";
    refusal((body) => (entryOf(body, "create", "name").readOnly = true), fill);
    refusal((body) => {
      (
        typedCreate(body, TYPE).groups[0].fields.find(
          (entry) => entry.key === "name",
        ) as Flagged
      ).readOnly = true;
    }, fill);
    // Read only on an edit screen is fine for a required field: screens are layout, not permissions.
    const edit = candidate();
    entryOf(edit, "edit", "name").readOnly = true;
    expect(issuesOf(edit)).toEqual([]);
  });

  it("keeps every default body valid and unchanged, and gives the shown read-only keys in screen order", () => {
    for (const kind of CONFIGURABLE_KINDS) {
      const body = DEFAULT_KIND_SCHEMAS[kind].body;
      expect(kindSchemaBodySchema.parse(body), kind).toStrictEqual(body);
      for (const found of body.screens)
        expect(readOnlyKeys(found), kind).toEqual([]);
    }
    const body = configured(false);
    screen(body, "edit").groups[1].fields = [
      { key: "email", readOnly: true } as Flagged,
      { key: "employer", hidden: true },
      { key: "phone", readOnly: true } as Flagged,
    ];
    const parsed = kindSchemaBodySchema.parse(body);
    expect(readOnlyKeys(screenFor(parsed, null, "edit"))).toEqual([
      "email",
      "phone",
    ]);
    // A hidden entry is not shown, so it is never among them, even flagged.
    expect(
      readOnlyKeys({
        action: "edit",
        groups: [
          {
            fields: [
              { key: "phone", hidden: true, readOnly: true },
              { key: "email", readOnly: true },
            ],
          },
        ],
      }),
    ).toEqual(["email"]);
  });

  describe("requiredOffCreate (FLD-032)", () => {
    const REQUIRED = uuid(9501);
    /** The candidate default with a required custom field, listed on every screen but create. */
    const withRequired = (extra: Record<string, unknown> = {}) => {
      const body = candidate();
      body.fields.push({
        key: REQUIRED,
        system: false,
        label: "Fictional must have",
        type: "short-text",
        required: true,
        ...extra,
      });
      for (const item of body.screens)
        if (item.action !== "create")
          item.groups[0].fields.push({ key: REQUIRED });
      return body;
    };
    const off = (body: RawBody) =>
      requiredOffCreate(kindSchemaBodySchema.parse(body)).map((item) => [
        item.key,
        item.label,
        item.screen.type ?? "default",
      ]);
    const must = (type: string) => [REQUIRED, "Fictional must have", type];

    it("finds nothing in the default bodies or for an archived required field", () => {
      for (const kind of CONFIGURABLE_KINDS)
        expect(
          requiredOffCreate(DEFAULT_KIND_SCHEMAS[kind].body),
          kind,
        ).toEqual([]);
      expect(off(withRequired({ archived: true }))).toEqual([]);
    });

    it("finds a required field left off or hidden on the default create screen, and on each typed create screen without it", () => {
      expect(off(withRequired())).toEqual([must("default")]);
      const hidden = withRequired();
      screen(hidden, "create").groups[0].fields.push({
        key: REQUIRED,
        hidden: true,
      });
      expect(off(hidden)).toEqual([must("default")]);
      // Shown on the default create screen, left off two typed ones.
      const typed = withRequired();
      screen(typed, "create").groups[0].fields.push({ key: REQUIRED });
      typedCreate(typed, TYPE);
      typedCreate(typed, OTHER_TYPE);
      expect(off(typed)).toEqual([must(TYPE), must(OTHER_TYPE)]);
      screen(typed, "create", OTHER_TYPE).groups[0].fields.push({
        key: REQUIRED,
      });
      expect(off(typed)).toEqual([must(TYPE)]);
    });

    it("checks a type-limited field only on the create screens that serve its types", () => {
      // T's own create screen leaves it out; another type's create screen does not count.
      const limited = withRequired({ types: [TYPE] });
      typedCreate(limited, TYPE);
      typedCreate(limited, OTHER_TYPE);
      expect(off(limited)).toEqual([must(TYPE)]);
      screen(limited, "create", TYPE).groups[0].fields.push({ key: REQUIRED });
      expect(off(limited)).toEqual([]);
      // Without a create screen of its own, T is served by the default create screen.
      const fallback = withRequired({ types: [TYPE] });
      typedCreate(fallback, OTHER_TYPE);
      expect(off(fallback)).toEqual([must("default")]);
    });

    it("says what to do in one sentence per field and screen", () => {
      const body = withRequired();
      typedCreate(body, TYPE);
      const items = requiredOffCreate(kindSchemaBodySchema.parse(body));
      expect(items.map(requiredOffCreateText)).toEqual([
        `${REQUIRED}: Required but not on the create screen. Fictional must have is required, but the Create screen does not show it; show it there or make it optional.`,
        `${REQUIRED}: Required but not on the create screen. Fictional must have is required, but the Create screen (type ${TYPE}) does not show it; show it there or make it optional.`,
      ]);
    });
  });
});
