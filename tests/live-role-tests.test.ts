import { afterEach, describe, expect, it, vi } from "vitest";

// The live harness must refuse before it ever builds a database client, and a connection failure
// must print one generic line. No database is used: every client fails to connect.
const driver = vi.hoisted(() => ({ constructed: vi.fn() }));
vi.mock("pg", () => ({
  Client: class {
    constructor() {
      driver.constructed();
    }
    on() {}
    async connect() {
      throw new Error(
        "fictional driver failure for postgresql://recruitmentos_data:fictional-data-secret@127.0.0.1:55440/fictional_app",
      );
    }
    async end() {}
  },
  Pool: class {
    constructor() {
      driver.constructed();
    }
  },
}));

import { errorCategory, main } from "../scripts/live-role-tests";

const data =
  "postgresql://recruitmentos_data:fictional-data-secret@127.0.0.1:55440/fictional_app";
const identity =
  "postgresql://recruitmentos_identity:fictional-identity-secret@127.0.0.1:55440/fictional_app";
const migration =
  "postgresql://fictional_owner:fictional-owner-secret@127.0.0.1:55440/fictional_app";
const key = "FictionalTenantContextTestKeyOnly0123456789A";
const valid = {
  DATABASE_URL: data,
  IDENTITY_DATABASE_URL: identity,
  MIGRATION_DATABASE_URL: migration,
  LIVE_ROLE_TESTS_CONFIRM: "fictional_app",
  TENANT_CONTEXT_SIGNING_KEY: key,
};

/** Run the harness's main and check its output never carries a secret. */
async function run(env: Record<string, string | undefined>) {
  const output: string[] = [];
  const capture = (...args: unknown[]) => void output.push(args.join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  const code = await main(env);
  vi.restoreAllMocks();
  const text = output.join("\n");
  for (const secret of [
    "fictional-data-secret",
    "fictional-identity-secret",
    "fictional-owner-secret",
    "postgresql://",
    "127.0.0.1",
    "55440",
    "fictional driver failure",
    key,
  ])
    expect(text).not.toContain(secret);
  return { code, text };
}

describe("live role tests configuration refusals", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    driver.constructed.mockClear();
  });

  for (const [name, env] of [
    ["a missing DATABASE_URL", { ...valid, DATABASE_URL: undefined }],
    [
      "a missing IDENTITY_DATABASE_URL",
      { ...valid, IDENTITY_DATABASE_URL: undefined },
    ],
    [
      "a missing MIGRATION_DATABASE_URL",
      { ...valid, MIGRATION_DATABASE_URL: undefined },
    ],
    [
      "a missing LIVE_ROLE_TESTS_CONFIRM",
      { ...valid, LIVE_ROLE_TESTS_CONFIRM: undefined },
    ],
    [
      "a missing TENANT_CONTEXT_SIGNING_KEY",
      { ...valid, TENANT_CONTEXT_SIGNING_KEY: undefined },
    ],
    [
      "a signing key that is too short",
      { ...valid, TENANT_CONTEXT_SIGNING_KEY: "fictional-short-key" },
    ],
    [
      "data and identity on different endpoints",
      { ...valid, IDENTITY_DATABASE_URL: identity.replace("55440", "55441") },
    ],
    [
      "the migration URL on another database",
      {
        ...valid,
        MIGRATION_DATABASE_URL: migration.replace(
          "/fictional_app",
          "/fictional_other",
        ),
      },
    ],
    [
      "an unsupported URL parameter",
      {
        ...valid,
        MIGRATION_DATABASE_URL: `${migration}?channel_binding=require`,
      },
    ],
    ["a set PGOPTIONS", { ...valid, PGOPTIONS: "-c role=fictional_owner" }],
    [
      "the same role for data and identity",
      {
        ...valid,
        IDENTITY_DATABASE_URL: data.replace(
          "fictional-data-secret",
          "fictional-identity-secret",
        ),
      },
    ],
    [
      "the owner as the data role",
      {
        ...valid,
        DATABASE_URL: migration.replace(
          "fictional-owner-secret",
          "fictional-data-secret",
        ),
      },
    ],
    [
      "the same role for identity and migration",
      {
        ...valid,
        MIGRATION_DATABASE_URL: identity.replace(
          "fictional-identity-secret",
          "fictional-owner-secret",
        ),
      },
    ],
    [
      "a confirmation that is not the database name",
      { ...valid, LIVE_ROLE_TESTS_CONFIRM: "fictional_other" },
    ],
    [
      "a confirmation that differs only in case",
      { ...valid, LIVE_ROLE_TESTS_CONFIRM: "Fictional_App" },
    ],
  ] as const)
    it(`returns 2 without building a client for ${name}`, async () => {
      const { code, text } = await run(env);
      expect(code).toBe(2);
      expect(text.split("\n")).toEqual([
        expect.stringMatching(/^Refused: .* Nothing was contacted\.$/),
      ]);
      expect(driver.constructed).not.toHaveBeenCalled();
    });

  it("returns 1 with one generic line when a connection cannot be made", async () => {
    const { code, text } = await run(valid);
    expect(code).toBe(1);
    expect(driver.constructed).toHaveBeenCalled();
    expect(text.split("\n")).toEqual([
      expect.stringMatching(/^Live role tests could not connect\./),
    ]);
  });

  it("keeps the generic connection line in diagnostic mode", async () => {
    const { code, text } = await run({
      ...valid,
      LIVE_ROLE_TESTS_DIAGNOSE: "1",
    });
    expect(code).toBe(1);
    expect(text.split("\n")).toEqual([
      expect.stringMatching(/^Live role tests could not connect\./),
    ]);
  });

  it("leaves the process signing key as it was", async () => {
    const before = process.env.TENANT_CONTEXT_SIGNING_KEY;
    await run({ ...valid, LIVE_ROLE_TESTS_CONFIRM: "fictional_other" });
    expect(process.env.TENANT_CONTEXT_SIGNING_KEY).toBe(before);
  });
});

describe("live role tests error classification", () => {
  const categories = ["assertion", "connection", "harness-error"];
  const message = `fictional driver failure for ${data} at host 127.0.0.1 with password fictional-data-secret`;

  it("returns a valid SQLSTATE unchanged", () => {
    for (const code of ["42501", "23514", "RQ001", "57014", "08P01", "40P01"])
      expect(errorCategory(Object.assign(new Error(message), { code }))).toBe(
        code,
      );
  });

  it("returns connection for a Node network or system error", () => {
    expect(errorCategory({ code: "ECONNRESET" })).toBe("connection");
    expect(errorCategory({ code: "EPIPE" })).toBe("connection");
    expect(
      errorCategory(
        Object.assign(new Error(message), {
          code: "ECONNREFUSED",
          syscall: "connect",
          address: "127.0.0.1",
          port: 55440,
        }),
      ),
    ).toBe("connection");
  });

  it("returns harness-error for a non-SQLSTATE code, a missing code and a non-object", () => {
    for (const error of [
      { code: "ERR_INVALID_ARG_TYPE" },
      { code: "4250" },
      { code: "425011" },
      { code: "rq001" },
      { code: 42501 },
      { code: data },
      new Error(message),
      {},
      undefined,
      null,
      "42501",
      message,
      42501,
    ])
      expect(errorCategory(error)).toBe("harness-error");
  });

  it("never returns any part of the error message", () => {
    for (const error of [
      new Error(message),
      Object.assign(new Error(message), { code: "42501" }),
      Object.assign(new Error(message), { code: data }),
      Object.assign(new Error(message), { code: "ECONNREFUSED" }),
      { message, code: "fictional-data-secret" },
      message,
    ]) {
      const result = errorCategory(error);
      expect(categories.includes(result) || /^[0-9A-Z]{5}$/.test(result)).toBe(
        true,
      );
      for (const secret of [
        "fictional",
        "postgresql://",
        "127.0.0.1",
        "55440",
        "secret",
      ])
        expect(result).not.toContain(secret);
    }
  });
});
