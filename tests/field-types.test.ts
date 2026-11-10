import { describe, expect, it, vi } from "vitest";
import { kindSchemaBodySchema, type KindSchemaBody } from "@/domain/config";
import { DEFAULT_KIND_SCHEMAS } from "@/domain/config-defaults";
import {
  FIELD_TYPES,
  KIND_SCHEMA_CACHE_SIZE,
  TASK_FIELD_TYPE_MAP,
  compileKindSchema,
  customFieldSchema,
  fieldValueSchema,
  patternIssue,
  type CompiledKindSchema,
  type CustomField,
  type CustomFieldType,
} from "@/domain/field-types";
import {
  TASK_FIELD_TYPES,
  customValuesSchema,
  daySchema,
} from "@/domain/record-schemas";

// Fictional ids only.
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const options = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `opt-${index}`,
    label: `Fictional option ${index}`,
  }));
// The attributes each type needs beyond the shared ones.
const needs: Partial<Record<CustomFieldType, Record<string, unknown>>> = {
  money: { currency: "AED" },
  dropdown: { options: options(3) },
  "multi-select": { options: options(3) },
  lookup: { target: "vacancy" },
};
const definition = (
  type: CustomFieldType,
  extra: Record<string, unknown> = {},
  key = uuid(1),
) => ({
  key,
  system: false,
  label: "Fictional field",
  type,
  required: false,
  ...needs[type],
  ...extra,
});
const parsed = (type: CustomFieldType, extra: Record<string, unknown> = {}) =>
  customFieldSchema.parse(definition(type, extra));
const refused = (type: CustomFieldType, extra: Record<string, unknown> = {}) =>
  !customFieldSchema.safeParse(definition(type, extra)).success;

describe("field type engine (R2b-03)", () => {
  it("has exactly the 18 R2-02 types in R2-02 order", () => {
    expect(FIELD_TYPES).toEqual([
      "short-text",
      "long-text",
      "rich-text",
      "number",
      "money",
      "percentage",
      "date",
      "date-time",
      "dropdown",
      "multi-select",
      "checkbox",
      "person",
      "org-unit",
      "url",
      "email",
      "phone",
      "file",
      "lookup",
    ]);
    expect(FIELD_TYPES.length).toBe(18);
    // Every type has a definition schema, and nothing else does.
    for (const type of FIELD_TYPES) expect(refused(type), type).toBe(false);
    for (const type of ["text", "rich_text", "formula", "json", "tags"])
      expect(
        customFieldSchema.safeParse({ ...definition("number"), type }).success,
      ).toBe(false);
  });

  // Per type: the definition, values accepted and values refused (wrong type and out of bound).
  const cases: {
    type: CustomFieldType;
    extra?: Record<string, unknown>;
    valid: unknown[];
    invalid: unknown[];
  }[] = [
    {
      type: "short-text",
      valid: ["Fictional", "x".repeat(4000), "line one\nline two"],
      invalid: [5, true, [], {}, "x".repeat(4001)],
    },
    {
      type: "short-text",
      extra: { min: 2, max: 5 },
      valid: ["ab", "abcde"],
      invalid: ["a", "abcdef"],
    },
    {
      type: "short-text",
      extra: { pattern: "[A-Z]{2}-\\d{4}" },
      valid: ["AB-1234"],
      invalid: ["AB-12345", "xAB-1234", "ab-1234"],
    },
    {
      type: "long-text",
      valid: ["Fictional\nnotes", "x".repeat(4000)],
      invalid: [5, false, "x".repeat(4001)],
    },
    {
      type: "long-text",
      extra: { min: 3, max: 10 },
      valid: ["abc", "x".repeat(10)],
      invalid: ["ab", "x".repeat(11)],
    },
    {
      type: "rich-text",
      valid: ["<p>Fictional</p>", "x".repeat(4000)],
      invalid: [5, "x".repeat(4001)],
    },
    {
      type: "rich-text",
      extra: { min: 1, max: 20 },
      valid: ["x", "x".repeat(20)],
      invalid: ["x".repeat(21)],
    },
    {
      type: "number",
      valid: [0, -2.5, 42, 1e12],
      invalid: ["5", true, Number.NaN, Infinity, -Infinity],
    },
    {
      type: "number",
      extra: { min: 0, max: 10 },
      valid: [0, 10, 5.5],
      invalid: [-0.1, 10.01],
    },
    {
      type: "money",
      valid: ["1500.50", "0", "0.5", "1000000000"],
      invalid: [1500, "12.345", "-1", "01", "1,500", "1000000000.01"],
    },
    {
      type: "money",
      extra: { min: 100, max: 2000 },
      valid: ["100", "2000.00", "150.75"],
      invalid: ["99.99", "2000.01"],
    },
    {
      type: "percentage",
      valid: [0, 12.5, 100, 250],
      invalid: ["12%", Number.NaN],
    },
    {
      type: "percentage",
      extra: { min: 0, max: 100 },
      valid: [0, 100],
      invalid: [-1, 100.5],
    },
    {
      type: "date",
      valid: ["2026-02-28", "2028-02-29"],
      invalid: ["2026-02-30", "2026/02/28", "2026-02-28T00:00:00Z", 20260228],
    },
    {
      type: "date",
      extra: { min: "2026-01-01", max: "2026-12-31" },
      valid: ["2026-01-01", "2026-12-31"],
      invalid: ["2025-12-31", "2027-01-01"],
    },
    {
      type: "date-time",
      valid: ["2026-11-11T09:30:00+04:00", "2026-11-11T05:30:00Z"],
      invalid: ["2026-11-11T09:30:00", "2026-11-11", 1762840200000],
    },
    {
      type: "date-time",
      extra: {
        min: "2026-11-11T08:00:00+04:00",
        max: "2026-11-11T18:00:00+04:00",
      },
      valid: ["2026-11-11T04:00:00Z", "2026-11-11T18:00:00+04:00"],
      invalid: ["2026-11-11T03:59:59Z", "2026-11-11T14:00:01Z"],
    },
    {
      type: "dropdown",
      valid: ["opt-0", "opt-2"],
      invalid: ["Fictional option 0", "opt-3", 0, ["opt-0"]],
    },
    {
      type: "multi-select",
      valid: [["opt-0"], ["opt-2", "opt-0"], ["opt-0", "opt-1", "opt-2"], []],
      invalid: [
        "opt-0",
        ["opt-0", "opt-0"],
        ["opt-3"],
        ["Fictional option 0"],
        [1],
      ],
    },
    {
      type: "multi-select",
      extra: { min: 2, max: 2 },
      valid: [["opt-0", "opt-1"], []],
      invalid: [["opt-0"], ["opt-0", "opt-1", "opt-2"]],
    },
    {
      type: "checkbox",
      valid: [true, false],
      invalid: ["true", 1, 0, []],
    },
    {
      type: "person",
      valid: ["fictional-user-1", "x".repeat(128)],
      invalid: [5, ["fictional-user-1"], "x".repeat(129)],
    },
    {
      type: "org-unit",
      valid: [uuid(7)],
      invalid: ["fictional-unit", 7, `${uuid(7)}0`],
    },
    {
      type: "file",
      valid: [uuid(8)],
      invalid: ["fictional.pdf", 8, uuid(8).slice(1)],
    },
    {
      type: "lookup",
      valid: [uuid(9)],
      invalid: ["fictional-record", 9, `{${uuid(9)}}`],
    },
    {
      type: "url",
      valid: ["https://example.test/path?q=1", "http://example.test"],
      invalid: [
        "ftp://example.test",
        "example.test",
        5,
        `https://example.test/${"x".repeat(2000)}`,
      ],
    },
    {
      type: "email",
      valid: ["fictional.person@example.test"],
      invalid: [
        "not-an-email",
        5,
        `${"x".repeat(64)}@${"d".repeat(63)}.${"e".repeat(63)}.${"f".repeat(63)}.${"g".repeat(63)}.test`,
      ],
    },
    {
      type: "phone",
      valid: ["+971 50 123 4567", "(04) 123-4567", "123", "1.2.3"],
      invalid: ["call me", "12", "++971", "+1-2", "1".repeat(41), 971501234567],
    },
  ];

  it("accepts every type's valid and empty values unchanged and refuses wrong types and bounds", () => {
    const covered = new Set<CustomFieldType>();
    for (const { type, extra, valid, invalid } of cases) {
      covered.add(type);
      const schema = fieldValueSchema(parsed(type, extra));
      const label = `${type} ${JSON.stringify(extra ?? {})}`;
      for (const value of [...valid, null, ""]) {
        expect(schema.safeParse(value).success, `${label} ${value}`).toBe(true);
        // No transform: the output is the input.
        expect(schema.parse(value), label).toStrictEqual(value);
        // Every type but multi-select stays inside today's stored union.
        if (type !== "multi-select")
          expect(
            customValuesSchema.safeParse({ [uuid(1)]: value }).success,
            label,
          ).toBe(true);
      }
      for (const value of invalid)
        expect(
          schema.safeParse(value).success,
          `${label} ${JSON.stringify(value)}`,
        ).toBe(false);
      expect(schema.safeParse(undefined).success, label).toBe(false);
    }
    expect([...covered].sort()).toEqual([...FIELD_TYPES].sort());
    // The bounds the requirements name.
    expect(daySchema.safeParse("2026-02-30").success).toBe(false);
  });

  it("refuses inapplicable attributes, over-long text, duplicate options and bad defaults", () => {
    // Attributes a type does not list.
    expect(refused("number", { pattern: "\\d+" })).toBe(true);
    expect(refused("short-text", { options: options(2) })).toBe(true);
    for (const type of ["lookup", "file", "person", "org-unit"] as const) {
      expect(refused(type, { default: uuid(5) }), type).toBe(true);
      expect(refused(type, { default: null }), type).toBe(true);
    }
    expect(refused("checkbox", { min: 0 })).toBe(true);
    expect(refused("long-text", { pattern: "a" })).toBe(true);
    expect(refused("rich-text", { pattern: "a" })).toBe(true);
    expect(refused("number", { currency: "AED" })).toBe(true);
    expect(refused("dropdown", { target: "candidate" })).toBe(true);
    expect(refused("dropdown", { min: 1 })).toBe(true);
    expect(refused("url", { max: 10 })).toBe(true);
    for (const key of ["readOnly", "sensitive", "hidden", "value", "id"])
      expect(refused("short-text", { [key]: false }), key).toBe(true);
    // Shared attributes.
    expect(refused("short-text", { key: "fictional" })).toBe(true);
    expect(refused("short-text", { system: true })).toBe(true);
    expect(refused("short-text", { required: undefined })).toBe(true);
    // Bounded, cleaned text.
    expect(refused("short-text", { label: "x".repeat(121) })).toBe(true);
    expect(refused("short-text", { label: "x".repeat(120) })).toBe(false);
    expect(refused("short-text", { label: " ​ " })).toBe(true);
    expect(refused("short-text", { help: "x".repeat(501) })).toBe(true);
    expect(refused("short-text", { help: "x".repeat(500) })).toBe(false);
    const option = (label: string, id = "opt-x") => ({
      options: [{ id, label }],
    });
    expect(refused("dropdown", option("x".repeat(201)))).toBe(true);
    expect(refused("dropdown", option("x".repeat(200)))).toBe(false);
    expect(refused("dropdown", option("Fictional", "x".repeat(201)))).toBe(
      true,
    );
    expect(refused("dropdown", option("Fictional", ""))).toBe(true);
    expect(refused("dropdown", { options: [] })).toBe(true);
    expect(refused("dropdown", { options: options(101) })).toBe(true);
    expect(refused("dropdown", { options: options(100) })).toBe(false);
    expect(refused("dropdown", { options: ["Fictional"] })).toBe(true);
    const cleaned = parsed("dropdown", {
      label: "  Fictional​ field ‮ ",
      help: " Fictional  help‍ ",
      options: [{ id: " opt-a​ ", label: "⁦Alpha⁩  one " }],
    });
    expect(cleaned.label).toBe("Fictional field");
    expect(cleaned.help).toBe("Fictional help");
    expect(cleaned.type === "dropdown" && cleaned.options).toEqual([
      { id: "opt-a", label: "Alpha one" },
    ]);
    // Option ids and labels are unique.
    for (const type of ["dropdown", "multi-select"] as const) {
      expect(
        refused(type, {
          options: [
            { id: "opt-a", label: "Alpha" },
            { id: "opt-a", label: "Beta" },
          ],
        }),
      ).toBe(true);
      expect(
        refused(type, {
          options: [
            { id: "opt-a", label: "Alpha" },
            { id: "opt-b", label: "Alpha" },
          ],
        }),
      ).toBe(true);
    }
    // min at most max.
    expect(refused("short-text", { min: 5, max: 4 })).toBe(true);
    expect(refused("short-text", { min: 4, max: 4 })).toBe(false);
    expect(refused("short-text", { max: 4001 })).toBe(true);
    expect(refused("short-text", { min: -1 })).toBe(true);
    expect(refused("short-text", { min: 1.5 })).toBe(true);
    expect(refused("number", { min: 1, max: 0 })).toBe(true);
    expect(refused("number", { min: -Infinity })).toBe(true);
    expect(refused("money", { min: 10, max: 5 })).toBe(true);
    expect(refused("money", { max: 1000000001 })).toBe(true);
    expect(refused("money", { min: -1 })).toBe(true);
    expect(refused("percentage", { min: 50, max: 10 })).toBe(true);
    expect(refused("date", { min: "2026-02-01", max: "2026-01-31" })).toBe(
      true,
    );
    expect(refused("date", { min: "2026-02-30" })).toBe(true);
    expect(
      refused("date-time", {
        min: "2026-11-11T10:00:00+04:00",
        max: "2026-11-11T05:59:00Z",
      }),
    ).toBe(true);
    expect(
      refused("date-time", {
        min: "2026-11-11T10:00:00+04:00",
        max: "2026-11-11T06:00:00Z",
      }),
    ).toBe(false);
    expect(refused("date-time", { min: "2026-11-11T10:00:00" })).toBe(true);
    expect(refused("multi-select", { min: 3, max: 2 })).toBe(true);
    expect(refused("multi-select", { max: 101 })).toBe(true);
    // Defaults pass the field's own value schema.
    expect(refused("short-text", { pattern: "[A-Z]{3}", default: "abc" })).toBe(
      true,
    );
    expect(refused("short-text", { pattern: "[A-Z]{3}", default: "ABC" })).toBe(
      false,
    );
    expect(refused("dropdown", { default: "Fictional option 0" })).toBe(true);
    expect(refused("dropdown", { default: "opt-1" })).toBe(false);
    expect(refused("multi-select", { default: ["opt-1", "opt-1"] })).toBe(true);
    expect(refused("multi-select", { default: ["opt-1"] })).toBe(false);
    expect(refused("number", { min: 0, max: 10, default: 11 })).toBe(true);
    expect(refused("money", { default: "12.345" })).toBe(true);
    expect(refused("money", { default: "100.00" })).toBe(false);
    expect(refused("checkbox", { default: "yes" })).toBe(true);
    expect(refused("checkbox", { default: true })).toBe(false);
    expect(refused("date", { default: "2026-02-30" })).toBe(true);
    expect(refused("email", { default: "not-an-email" })).toBe(true);
    // Money needs an ISO currency code.
    expect(customFieldSchema.safeParse(definition("number")).success).toBe(
      true,
    );
    expect(refused("money", { currency: undefined })).toBe(true);
    expect(refused("money", { currency: "aed" })).toBe(true);
    expect(refused("money", { currency: "AEDX" })).toBe(true);
    expect(refused("money", { currency: "USD" })).toBe(false);
    // Lookups name one of the nine configurable kinds.
    expect(refused("lookup", { target: undefined })).toBe(true);
    expect(refused("lookup", { target: "bucket" })).toBe(true);
    expect(refused("lookup", { target: "candidate" })).toBe(false);
  });

  it("refuses patterns that could backtrack catastrophically, before they ever run", () => {
    const unsafe = [
      "(a+)+",
      "(a|a)*",
      "(a|aa)+",
      "(\\w+\\s?)*",
      "(.*a){20}",
      "([a-z]+)*@x",
      "(a)\\1",
      "(?=a)a",
      "(?<!a)b",
      "(",
      "a".repeat(201),
      // More of the same rules.
      "",
      "(?<n>a)\\k<n>",
      "(?!a)b",
      "(?<=a)b",
      "((a)+)+",
      "(?:a+){2,}",
      "(?:a|b){1,3}",
      "(?<n>a?)+",
      "(?:(?:ab)*c)+",
      "a)|(?:b",
      "[a-z",
      "\\p{Nope}",
      // More than one choice point (a quantifier of varying count, or |) in the whole pattern.
      "a*a*a*b",
      `${".?".repeat(60)}!`,
      `${"\\w?\\d?".repeat(30)}!`,
      `${"(?:a|aa)".repeat(24)}!`,
      "a*a*b",
      `.*.*${".".repeat(190)}!`,
      "(?:a+)?",
      "[A-Z]{2,3}-\\d+",
      "\\p{L}{2,}(?:-\\p{L}+)?",
      "a|b|c",
      "(?:ab|cd)+",
      "x?y?",
    ];
    for (const pattern of unsafe)
      expect(patternIssue(pattern), pattern).toEqual(expect.any(String));
    const safe = [
      "[A-Z]{2}-\\d{4}",
      "[(+)*]+",
      "\\(\\d+\\)",
      "(?:ab|cd)",
      "(ab){2}",
      "[A-Z]".repeat(40),
      // More of the same rules.
      "(?:a|b){1}",
      "(?<code>[A-Z]{3})-\\d+",
      "(?:\\u{1F600}){3}",
      "[\\]+*|]+",
      "a|b",
      "\\d+\\.\\d{2}",
      "\\d+?-x",
      "(ab)+?",
      "x{2,2}y?",
      "[A-Z]{2,}",
      ".*.{3000}!",
    ];
    for (const pattern of safe)
      expect(patternIssue(pattern), pattern).toBe(null);
    expect("[A-Z]".repeat(40).length).toBe(200);
    // An accepted worst case stays cheap on the longest value it can be given.
    const worst = fieldValueSchema(
      parsed("short-text", { pattern: ".*.{3000}!" }),
    );
    const times = [0, 1, 2].map(() => {
      const start = performance.now();
      expect(worst.safeParse("a".repeat(4000)).success).toBe(false);
      return performance.now() - start;
    });
    expect(Math.min(...times)).toBeLessThanOrEqual(50);
    // A failed length check stops the parse before the pattern runs.
    const long = JSON.stringify(
      worst.safeParse("a".repeat(40000)).error?.issues,
    );
    expect(long).toContain('"too_big"');
    expect(long).not.toContain('"invalid_format"');
    const bounded = fieldValueSchema(
      parsed("short-text", { pattern: "[a-z]+!", min: 5 }),
    );
    const short = JSON.stringify(bounded.safeParse("ab").error?.issues);
    expect(short).toContain('"too_small"');
    expect(short).not.toContain('"invalid_format"');
    expect(JSON.stringify(bounded.safeParse("abcde").error?.issues)).toContain(
      '"invalid_format"',
    );
    // A refused pattern is never compiled or run against the definition's default.
    for (const pattern of ["(a+)+", "("]) {
      const result = customFieldSchema.safeParse(
        definition("short-text", { pattern, default: `${"a".repeat(30)}!` }),
      );
      expect(result.error?.issues.map((issue) => issue.path)).toEqual([
        ["pattern"],
      ]);
    }
    // Inside a kind schema body, publish validation refuses the field at its pattern.
    const body = structuredClone(DEFAULT_KIND_SCHEMAS.candidate.body) as {
      fields: unknown[];
    };
    const index = body.fields.length;
    body.fields.push(definition("short-text", { pattern: "(a+)+" }));
    const result = kindSchemaBodySchema.safeParse(body);
    expect(result.success).toBe(false);
    expect(result.error!.issues.map((issue) => issue.path)).toContainEqual([
      "fields",
      index,
      "pattern",
    ]);
  });

  it("maps today's five task field types and accepts what validCustomValue accepts", () => {
    expect(TASK_FIELD_TYPE_MAP).toEqual({
      Text: "short-text",
      Number: "number",
      Date: "date",
      Dropdown: "dropdown",
      Checkbox: "checkbox",
    });
    expect(Object.keys(TASK_FIELD_TYPE_MAP)).toEqual([...TASK_FIELD_TYPES]);
    const taskOptions = ["Alpha", "Beta gamma"];
    // validCustomValue from src/lib/records.ts at e0eb9dc, for an optional field.
    const validCustomValue = (type: string, value: unknown) => {
      if (value === "" || value === null || value === undefined) return true;
      switch (type) {
        case "Text":
          return typeof value === "string" && value.length <= 4000;
        case "Number":
          return typeof value === "number" && Number.isFinite(value);
        case "Date":
          return (
            typeof value === "string" && daySchema.safeParse(value).success
          );
        case "Dropdown":
          return typeof value === "string" && taskOptions.includes(value);
        case "Checkbox":
          return typeof value === "boolean";
        default:
          return false;
      }
    };
    const values = [
      undefined,
      null,
      "",
      "Fictional note",
      `${"x".repeat(3990)}\nline two`,
      "x".repeat(4000),
      "x".repeat(4001),
      0,
      -3.25,
      1e15,
      Number.NaN,
      Infinity,
      "5",
      "2026-02-28",
      "2026-02-30",
      "Alpha",
      "Beta gamma",
      "alpha",
      true,
      false,
      "true",
      [],
      {},
    ];
    for (const taskType of TASK_FIELD_TYPES) {
      const { customValues } = compileKindSchema({
        versionId: uuid(900 + TASK_FIELD_TYPES.indexOf(taskType)),
        body: {
          ...structuredClone(DEFAULT_KIND_SCHEMAS.task.body),
          fields: [
            customFieldSchema.parse(
              definition(TASK_FIELD_TYPE_MAP[taskType], {
                ...(taskType === "Dropdown"
                  ? {
                      options: taskOptions.map((text) => ({
                        id: text,
                        label: text,
                      })),
                    }
                  : {}),
              }),
            ),
          ],
        },
      });
      let accepted = 0;
      for (const value of values) {
        const expected = validCustomValue(taskType, value);
        if (expected) accepted++;
        expect(
          customValues.safeParse({ [uuid(1)]: value }).success,
          `${taskType} ${String(value).slice(0, 20)}`,
        ).toBe(expected);
      }
      expect(accepted, taskType).toBeGreaterThan(3);
    }
  });

  // A candidate body: the default system fields plus the given custom fields, on every screen.
  const withCustom = (custom: unknown[], screens?: string[][]) => {
    const body = structuredClone(DEFAULT_KIND_SCHEMAS.candidate.body) as {
      fields: unknown[];
      screens: { action: string; fields: string[] }[];
    };
    body.fields.push(...custom);
    const keys = (custom as { key: string }[]).map((field) => field.key);
    body.screens.forEach((screen, index) =>
      screen.fields.push(...(screens?.[index] ?? keys)),
    );
    return body;
  };

  it("accepts a body with system and custom fields of every type, and refuses bad keys", () => {
    const custom = FIELD_TYPES.map((type, index) =>
      definition(type, {}, uuid(100 + index)),
    );
    const body = withCustom(custom);
    const result = kindSchemaBodySchema.safeParse(body);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    expect(result.data!.fields).toHaveLength(30 + 18);
    // A custom key repeated, or a screen naming an unknown uuid, is refused.
    const repeated = withCustom(
      [...custom, definition("number", {}, uuid(100))],
      [custom.map((field) => field.key), [], []],
    );
    expect(kindSchemaBodySchema.safeParse(repeated).success).toBe(false);
    const unknown = withCustom(custom, [[uuid(999)], [], []]);
    expect(kindSchemaBodySchema.safeParse(unknown).success).toBe(false);
    // A custom key that repeats a system key, or a system field keyed by a uuid, is refused.
    expect(
      kindSchemaBodySchema.safeParse(
        withCustom([definition("number", {}, "name")], [[], [], []]),
      ).success,
    ).toBe(false);
    const system = withCustom([], [[], [], []]) as {
      fields: Record<string, unknown>[];
    };
    system.fields[0].key = uuid(5);
    expect(kindSchemaBodySchema.safeParse(system).success).toBe(false);
  });

  it("compiles a default body and a custom body into customValues and the mandatory rules", () => {
    const fallback = compileKindSchema(DEFAULT_KIND_SCHEMAS.candidate);
    expect(fallback.versionId).toBe(DEFAULT_KIND_SCHEMAS.candidate.versionId);
    expect(fallback.mandatory).toEqual({
      create: ["name"],
      edit: ["name"],
      view: ["name"],
    });
    expect(fallback.customValues.safeParse({}).success).toBe(true);
    expect(fallback.customValues.safeParse({ [uuid(1)]: "x" }).success).toBe(
      false,
    );
    expect(Object.isFrozen(fallback)).toBe(true);
    expect(Object.isFrozen(fallback.mandatory)).toBe(true);
    expect(Object.isFrozen(fallback.mandatory.create)).toBe(true);

    const onCreate = uuid(201);
    const onEditOnly = uuid(202);
    const optional = uuid(203);
    const body = kindSchemaBodySchema.parse(
      withCustom(
        [
          definition("short-text", { required: true }, onCreate),
          definition("number", { required: true, max: 10 }, onEditOnly),
          definition("dropdown", {}, optional),
        ],
        [[onCreate, optional], [onEditOnly, onCreate], [optional]],
      ),
    );
    const compiled = compileKindSchema({ versionId: uuid(300), body });
    expect(compiled.mandatory).toEqual({
      create: ["name", onCreate],
      edit: ["name", onEditOnly, onCreate],
      view: ["name"],
    });
    const values = {
      [onCreate]: "Fictional",
      [onEditOnly]: 7,
      [optional]: "opt-1",
    };
    expect(compiled.customValues.parse(values)).toStrictEqual(values);
    expect(compiled.customValues.safeParse({}).success).toBe(true);
    expect(
      compiled.customValues.safeParse({ ...values, [onEditOnly]: 11 }).success,
    ).toBe(false);
    expect(
      compiled.customValues.safeParse({ ...values, [optional]: "opt-9" })
        .success,
    ).toBe(false);
    expect(
      compiled.customValues.safeParse({ ...values, [uuid(299)]: "x" }).success,
    ).toBe(false);
    expect(
      compiled.customValues.safeParse({ ...values, name: "x" }).success,
    ).toBe(false);
    expect(Object.isFrozen(compiled)).toBe(true);
  });

  it("caches by version id, bounded with least recently used eviction", () => {
    const body = kindSchemaBodySchema.parse(
      withCustom([definition("checkbox", {}, uuid(401))]),
    );
    const first = compileKindSchema({ versionId: uuid(400), body });
    // The same id returns the same object without compiling, whatever body comes with it.
    const again = compileKindSchema({
      versionId: uuid(400),
      body: DEFAULT_KIND_SCHEMAS.offer.body,
    });
    expect(again).toBe(first);
    expect(again.customValues.safeParse({ [uuid(401)]: true }).success).toBe(
      true,
    );
    // A new id gives a new object.
    const other = compileKindSchema({ versionId: uuid(402), body });
    expect(other).not.toBe(first);
    // Used again, so it outlives an id compiled before it.
    expect(KIND_SCHEMA_CACHE_SIZE).toBe(512);
    const evicted = compileKindSchema({ versionId: uuid(403), body });
    compileKindSchema({ versionId: uuid(400), body });
    for (let n = 0; n < KIND_SCHEMA_CACHE_SIZE - 1; n++)
      compileKindSchema({ versionId: uuid(10000 + n), body });
    expect(compileKindSchema({ versionId: uuid(400), body })).toBe(first);
    expect(compileKindSchema({ versionId: uuid(403), body })).not.toBe(evicted);
    // After 512 other ids are compiled, the first id is compiled again.
    for (let n = 0; n < KIND_SCHEMA_CACHE_SIZE; n++)
      compileKindSchema({ versionId: uuid(20000 + n), body });
    const recompiled = compileKindSchema({ versionId: uuid(400), body });
    expect(recompiled).not.toBe(first);
    expect(recompiled.mandatory).toEqual(first.mandatory);
  });

  it("compiles the largest configuration within 20 ms", () => {
    // 40 screens and 30 types per kind cannot be expressed until R2b-07 and R2b-11: the body has
    // one screen per action, so this is the largest body it can hold today.
    const valueOf = (type: CustomFieldType, n: number): unknown => {
      switch (type) {
        case "short-text":
          return "A".repeat(40);
        case "long-text":
        case "rich-text":
          return `Fictional value ${n}`;
        case "number":
        case "percentage":
          return n;
        case "money":
          return `${n}.50`;
        case "date":
          return "2026-11-11";
        case "date-time":
          return "2026-11-11T09:30:00+04:00";
        case "dropdown":
          return `opt-${n % 100}`;
        case "multi-select":
          return ["opt-0", `opt-${1 + (n % 99)}`];
        case "checkbox":
          return n % 2 === 0;
        case "person":
          return `fictional-user-${n}`;
        case "org-unit":
        case "file":
        case "lookup":
          return uuid(50000 + n);
        case "url":
          return `https://example.test/${n}`;
        case "email":
          return `fictional.${n}@example.test`;
        case "phone":
          return `+971 50 000 ${String(n).padStart(4, "0")}`;
      }
    };
    const custom = Array.from({ length: 120 }, (_, n) => {
      const type = FIELD_TYPES[n % FIELD_TYPES.length];
      return definition(
        type,
        {
          label: `Fictional field ${n} `.padEnd(120, "x"),
          help: `Fictional help ${n} `.padEnd(500, "h"),
          required: n % 3 === 0,
          ...(type === "short-text" ? { pattern: "[A-Z]".repeat(40) } : {}),
          ...(type === "dropdown" || type === "multi-select"
            ? { options: options(100) }
            : {}),
        },
        uuid(1000 + n),
      );
    });
    const raw = withCustom(custom);
    expect(raw.fields).toHaveLength(150);
    for (const screen of raw.screens) expect(screen.fields).toHaveLength(150);
    expect(
      new TextEncoder().encode(JSON.stringify(raw)).byteLength,
    ).toBeLessThanOrEqual(524288);
    const result = kindSchemaBodySchema.safeParse(raw);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    const body: KindSchemaBody = result.data!;

    // One warm-up compile, then 5 cold compiles under fresh version ids.
    compileKindSchema({ versionId: uuid(600), body });
    const times: number[] = [];
    let compiled!: CompiledKindSchema;
    for (let n = 0; n < 5; n++) {
      const start = performance.now();
      compiled = compileKindSchema({ versionId: uuid(610 + n), body });
      times.push(performance.now() - start);
    }
    const median = times.sort((a, b) => a - b)[2];
    expect(median).toBeLessThanOrEqual(20);

    const values = Object.fromEntries(
      (body.fields.filter((field) => !field.system) as CustomField[]).map(
        (field, n) => [field.key, valueOf(field.type, n)],
      ),
    );
    expect(Object.keys(values)).toHaveLength(120);
    expect(compiled.customValues.parse(values)).toStrictEqual(values);
    expect(compiled.mandatory.create).toHaveLength(1 + 40);
  });

  it("loads with field-types.ts imported first", async () => {
    vi.resetModules();
    const engine = await import("@/domain/field-types");
    const config = await import("@/domain/config");
    const defaults = await import("@/domain/config-defaults");
    expect(engine.FIELD_TYPES).toHaveLength(18);
    expect(config.configLabel).toBe(engine.configLabel);
    expect(config.CONFIGURABLE_KINDS).toBe(engine.CONFIGURABLE_KINDS);
    const body = defaults.DEFAULT_KIND_SCHEMAS.task.body;
    expect(config.kindSchemaBodySchema.parse(body)).toStrictEqual(body);
    expect(
      engine.compileKindSchema(defaults.DEFAULT_KIND_SCHEMAS.task).mandatory
        .create,
    ).toEqual(["title"]);
  });
});
