import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import writeXlsx, { type Cell } from "write-excel-file/node";
import { buildPlan, type LegacyInputs } from "../scripts/legacy/plan";
import {
  loadLegacy,
  safeResolve,
  validateWorkbookZip,
} from "../scripts/legacy/files";
import {
  applyPlan,
  validateApiUrl,
  type ApplyResult,
} from "../scripts/legacy/apply";

const folders: string[] = [];
async function temp() {
  const path = await mkdtemp(join(tmpdir(), "ros-fictional-"));
  folders.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
function input(): LegacyInputs {
  return {
    workbooks: {
      "Resume_Master.xlsx": {
        Master: [
          ["Title"],
          [],
          ["As of", "2026-10-01"],
          [],
          [],
          [
            "Candidate ID",
            "Candidate Full Name",
            "Email",
            "Category fit (folder-derived)",
            "Years of experience",
            "Documented work years (estimate)",
            "All resume source IDs",
            "Male/Female (explicit only)",
            "Extra fact",
          ],
          [
            "c_1",
            "Fictional Example",
            "fiction@example.test",
            "Finance; Legal",
            "Not stated",
            3.5,
            "s_1; s_2",
            "",
            "Preserve this",
          ],
        ],
        "File Inventory": [
          [
            "Source ID",
            "Relative source path / attachment",
            "Candidate IDs",
            "Canonical source ID",
          ],
          ["s_1", "Finance/example.pdf", "c_1", ""],
          ["s_2", "Legal/example-v2.pdf", "c_1", ""],
        ],
        "Field Evidence": [
          ["Candidate ID", "Field", "Supporting source text"],
          ["c_1", "Degree", "Fictional degree evidence"],
        ],
        "Review Log": [
          ["Candidate ID", "Details"],
          ["c_1", "Different facts across versions"],
        ],
      },
      "Recruitment_Tasks.xlsx": {
        Buckets: [
          ["Bucket ID", "Name", "Color", "Order", "Active"],
          ["b_1", "Review", "#4338ca", 0, true],
        ],
        Fields: [
          [
            "Field ID",
            "Name",
            "Type",
            "Options",
            "Required",
            "Active",
            "Order",
          ],
          [
            "f_1",
            "Assessment",
            "select",
            '["Pending","Complete"]',
            false,
            true,
            0,
          ],
          [
            "f_sys_vacancy",
            "Vacancy reference ID",
            "text",
            "[]",
            false,
            false,
            1,
          ],
        ],
        Tasks: [
          [
            "Task ID",
            "Title",
            "Status",
            "Description",
            "Candidate / vacancy",
            "Assessment",
            "Vacancy reference ID",
            "Archived",
          ],
          [
            "t_1",
            "Review CV",
            "Review",
            "Candidate ID: c_1",
            "Fictional candidate context",
            "Pending",
            "v_1",
            false,
          ],
        ],
      },
      "Recruitment_Vacancies.xlsx": {
        "Job Roles": [
          ["Role ID", "Title"],
          ["r_1", "Accountant"],
        ],
        Vacancies: [
          [
            "Vacancy ID",
            "Requisition ID",
            "Title",
            "Role ID",
            "Openings",
            "Status",
          ],
          ["v_1", "REQ-1", "Accountant", "r_1", 1, "Open"],
        ],
      },
      "Recruitment_Operations.xlsx": {
        Applications: [
          [
            "Application ID",
            "Candidate ID",
            "Vacancy ID",
            "Stage",
            "Created at",
          ],
          ["a_1", "c_1", "v_1", "Interview", "2020-01-01T00:00:00Z"],
        ],
        Interviews: [
          [
            "Interview ID",
            "Application ID",
            "Title",
            "Start at",
            "Duration minutes",
            "Status",
          ],
          [
            "i_1",
            "a_1",
            "Screening",
            "2026-10-21T09:00:00+04:00",
            30,
            "Scheduled",
          ],
        ],
        Offers: [
          ["Offer ID", "Application ID", "Title", "Amount", "Status"],
          ["o_1", "a_1", "Offer", "15000.50", "Draft"],
        ],
        Onboarding: [
          ["Onboarding ID", "Application ID", "Status"],
          ["n_1", "a_1", "Planned"],
        ],
        Checklist: [
          ["Checklist ID", "Onboarding ID", "Title", "Status"],
          ["k_1", "n_1", "Orientation", "Pending"],
        ],
        Comments: [
          [
            "Comment ID",
            "Entity type",
            "Entity ID",
            "Body",
            "Author",
            "Created at",
          ],
          [
            "m_1",
            "candidate",
            "c_1",
            "Fictional shared comment",
            "Former recruiter",
            "2020-01-01T00:00:00Z",
          ],
        ],
        Activity: [
          [
            "Activity ID",
            "Entity type",
            "Entity ID",
            "Event",
            "From stage",
            "To stage",
            "Created at",
          ],
          [
            "e_1",
            "application",
            "a_1",
            "stage",
            "Sourced",
            "Interview",
            "2020-01-02T00:00:00Z",
          ],
        ],
        "Saved Views": [
          ["View ID", "Name", "Area", "Query"],
          [
            "q_1",
            "Finance",
            "directory",
            '{"search":"finance","dir":"desc","sort":"name","pageSize":25}',
          ],
        ],
        "Notification Reads": [
          ["Read ID", "Key", "Read at"],
          ["read_1", "interview:i_1:2026-10-21", "2020-01-01T00:00:00Z"],
        ],
      },
    },
    states: [
      {
        id: "c_1",
        shortlisted: true,
        status: "To contact",
        note: "Private fictional note",
        updated: "2020-01-01T00:00:00Z",
      },
    ],
    recovered: {},
    issues: [],
  };
}
function excelCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value instanceof Date
  )
    return { value };
  throw new Error("Unsupported fictional fixture cell.");
}

describe("legacy migration planning", () => {
  it("preserves facts, folder tags, evidence, versions, workflow references and private state", () => {
    const plan = buildPlan(input());
    expect(plan.issues.filter((v) => v.severity === "error")).toEqual([]);
    const candidate = plan.records.find((v) => v.resource === "candidates")!;
    expect(candidate.data).toMatchObject({
      folderCategories: ["Finance", "Legal"],
      yearsExperience: null,
      documentedYearsEstimate: 3.5,
      explicitGender: "",
      rawSource: { "Extra fact": "Preserve this" },
      evidence: [
        {
          "Candidate ID": "c_1",
          Field: "Degree",
          "Supporting source text": "Fictional degree evidence",
        },
      ],
    });
    expect(candidate.sources).toEqual(["s_1", "s_2"]);
    expect(JSON.stringify(candidate)).not.toContain("Private fictional note");
    expect(plan.states[0].note).toBe("Private fictional note");
    expect(plan.records.find((v) => v.resource === "tasks")).toMatchObject({
      refs: {
        bucketId: { resource: "buckets", legacyId: "b_1" },
        vacancyId: { resource: "vacancies", legacyId: "v_1" },
        candidateId: { resource: "candidates", legacyId: "c_1" },
      },
      customValues: { f_1: "Pending" },
    });
    expect(
      plan.records.filter((v) => v.resource === "task-fields"),
    ).toHaveLength(1);
    expect(
      plan.records.find((v) => v.resource === "applications")?.importMeta
        .activity,
    ).toHaveLength(1);
    expect(
      plan.records.find((v) => v.resource === "comments")?.data,
    ).toMatchObject({ legacyAuthorLabel: "Former recruiter" });
    expect(
      plan.records.find((v) => v.resource === "views")?.data,
    ).toMatchObject({ query: { direction: "desc" } });
    expect(plan.stats.candidateRecords).toBe(1);
    expect(plan.stats.sourceRows).toBe(2);
  });
  it("maps legacy review status text to the two controlled values and keeps the original", () => {
    const source = input();
    const master = source.workbooks["Resume_Master.xlsx"].Master;
    master[5].push("Source review status");
    master[6].push("Verified");
    master.push([
      "c_2",
      "Fictional Second Example",
      "second@example.test",
      "",
      "",
      "",
      "",
      "",
      "",
      "Pending HR",
    ]);
    source.workbooks["Recruitment_Operations.xlsx"]["Saved Views"].push(
      ["q_2", "Verified", "directory", '{"reviewStatus":"Verified"}'],
      ["q_3", "Pending", "directory", '{"reviewStatus":"Pending HR"}'],
    );
    const plan = buildPlan(source);
    expect(plan.issues.filter((v) => v.severity === "error")).toEqual([]);
    const candidates = plan.records.filter((v) => v.resource === "candidates");
    expect(candidates.map((v) => v.data)).toEqual([
      expect.objectContaining({
        reviewStatus: "Reviewed",
        rawSource: expect.objectContaining({
          "Source review status": "Verified",
        }),
      }),
      expect.objectContaining({
        reviewStatus: "Needs review",
        rawSource: expect.objectContaining({
          "Source review status": "Pending HR",
        }),
      }),
    ]);
    expect(
      plan.records
        .filter((v) => v.resource === "views")
        .map((v) => (v.data.query as { reviewStatus?: string }).reviewStatus),
    ).toEqual(["", "Reviewed", "Needs review"]);
  });
  it("blocks duplicate identities and missing parents rather than merging or guessing", () => {
    const source = input();
    source.workbooks["Resume_Master.xlsx"].Master.push(["c_1", "Duplicate"]);
    source.workbooks["Recruitment_Operations.xlsx"].Applications.push([
      "a_2",
      "missing",
      "v_1",
      "Sourced",
    ]);
    const plan = buildPlan(source);
    expect(plan.issues.map((v) => v.code)).toContain("DUPLICATE_ID");
    expect(plan.issues.map((v) => v.code)).toContain("MISSING_REFERENCE");
  });
  it("blocks invalid explicit values and preserves unmappable view fields as provenance", () => {
    const source = input();
    source.workbooks["Resume_Master.xlsx"].Master[6][2] = "invalid-email";
    source.workbooks["Recruitment_Operations.xlsx"]["Saved Views"][1][3] =
      '{"futureFilter":"keep"}';
    const plan = buildPlan(source);
    expect(plan.issues.map((v) => v.code)).toContain("INVALID_DATA");
    expect(plan.issues.map((v) => v.code)).toContain("VIEW_FILTERS_NOT_MAPPED");
    expect(
      plan.records.find((v) => v.resource === "views")?.importMeta.row,
    ).toMatchObject({ Query: '{"futureFilter":"keep"}' });
  });
  it("blocks active children of archived parents and invalid custom dropdown values before API writes", () => {
    const source = input();
    source.workbooks["Recruitment_Vacancies.xlsx"].Vacancies[0].push(
      "Archived",
    );
    source.workbooks["Recruitment_Vacancies.xlsx"].Vacancies[1].push(true);
    source.workbooks["Recruitment_Tasks.xlsx"].Tasks[1][5] =
      "Not a configured option";
    const plan = buildPlan(source);
    expect(plan.issues.map((v) => v.code)).toContain("ARCHIVED_PARENT");
    expect(plan.issues.map((v) => v.code)).toContain("INVALID_CUSTOM_VALUE");
  });
  it("blocks missing required task values and inconsistent offer dates", () => {
    const source = input();
    source.workbooks["Recruitment_Tasks.xlsx"].Fields[1][4] = true;
    source.workbooks["Recruitment_Tasks.xlsx"].Tasks[1][5] = "";
    source.workbooks["Recruitment_Operations.xlsx"].Offers[0].push(
      "Sent date",
      "Expiry date",
    );
    source.workbooks["Recruitment_Operations.xlsx"].Offers[1].push(
      "2026-11-02",
      "2026-10-01",
    );
    const plan = buildPlan(source);
    expect(plan.issues.map((v) => v.code)).toContain("INVALID_CUSTOM_VALUE");
    expect(plan.issues.map((v) => v.code)).toContain("INVALID_OFFER_DATES");
  });
  it("blocks multi-byte provenance that exceeds the HTTP byte limit without truncating source facts", () => {
    const source = input();
    source.workbooks["Resume_Master.xlsx"].Master[6][8] = "م".repeat(65000);
    const plan = buildPlan(source);
    expect(plan.issues.map((v) => v.code)).toContain(
      "IMPORT_PAYLOAD_TOO_LARGE",
    );
    expect(
      (plan.records[0].data.rawSource as Record<string, unknown>)["Extra fact"],
    ).toBe("م".repeat(65000));
  });
});

describe("legacy file boundary", () => {
  it("rejects traversal, drive paths, UNC and imported URLs", async () => {
    const root = await temp();
    for (const path of [
      "../secret.pdf",
      "C:\\secret.pdf",
      "\\\\server\\share.pdf",
      "https://example.test/cv.pdf",
    ])
      await expect(safeResolve(root, path)).rejects.toThrow();
  });
  it("rejects a filesystem junction outside the explicit root", async (context) => {
    const root = await temp(),
      outside = await temp();
    await writeFile(join(outside, "secret.pdf"), "fictional");
    try {
      await symlink(outside, join(root, "linked"), "junction");
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EPERM"
      )
        context.skip("The Windows sandbox denies creating test junctions.");
      throw error;
    }
    await expect(safeResolve(root, "linked/secret.pdf")).rejects.toThrow(
      /link|junction/i,
    );
  });
  it("reads only selected synthetic workbooks/SQLite and resolves recovered versions without reading CV bytes", async () => {
    const root = await temp(),
      source = input();
    for (const [file, sheets] of Object.entries(source.workbooks)) {
      const fixtureSheets = Object.entries(sheets).map(([sheet, data]) => ({
        sheet,
        data: data.map((row) => row.map(excelCell)),
      }));
      await writeXlsx(fixtureSheets).toFile(join(root, file));
    }
    await mkdir(join(root, "Recruiter Dashboard", "Recovered Resumes"), {
      recursive: true,
    });
    await mkdir(join(root, "Finance"));
    await mkdir(join(root, "Legal"));
    await writeFile(join(root, "Finance", "example.pdf"), "%PDF-fictional");
    await writeFile(
      join(root, "Recruiter Dashboard", "Recovered Resumes", "recovered.pdf"),
      "%PDF-fictional",
    );
    await writeFile(
      join(root, "Recruiter Dashboard", "recovered.json"),
      JSON.stringify({ s_2: "Recovered Resumes/recovered.pdf" }),
    );
    const db = new DatabaseSync(
      join(root, "Recruiter Dashboard", "recruiter-state.sqlite3"),
    );
    db.exec(
      "CREATE TABLE candidates(id TEXT PRIMARY KEY,shortlisted INTEGER,status TEXT,note TEXT,updated TEXT)",
    );
    db.prepare("INSERT INTO candidates VALUES(?,?,?,?,?)").run(
      "c_1",
      1,
      "To contact",
      "Private fictional note",
      "2020-01-01T00:00:00Z",
    );
    db.close();
    const loaded = await loadLegacy(root);
    expect(loaded.sources).toHaveLength(2);
    expect(loaded.sources[1]).toMatchObject({
      relativePath: "Recruiter Dashboard/Recovered Resumes/recovered.pdf",
      exists: true,
      uploadable: true,
    });
    expect(loaded.states[0].note).toBe("Private fictional note");
    expect(loaded.issues.filter((v) => v.severity === "error")).toEqual([]);
  });
  it("blocks a live SQLite journal rather than touching or losing private notes", async () => {
    const root = await temp();
    await mkdir(join(root, "Recruiter Dashboard"));
    await writeFile(
      join(root, "Recruiter Dashboard", "recruiter-state.sqlite3"),
      "fictional db",
    );
    await writeFile(
      join(root, "Recruiter Dashboard", "recruiter-state.sqlite3-wal"),
      "live fictional WAL",
    );
    const loaded = await loadLegacy(root);
    expect(
      loaded.issues.find((v) => v.code === "PRIVATE_STATE_UNREADABLE")?.message,
    ).toMatch(/live WAL/);
    expect(loaded.states).toEqual([]);
  });
  it("rejects archive bombs before expanding a workbook", () => {
    const bytes = Buffer.alloc(68);
    bytes.writeUInt32LE(0x02014b50, 0);
    bytes.writeUInt32LE(1, 20);
    bytes.writeUInt32LE(2000000000, 24);
    bytes.writeUInt32LE(0x06054b50, 46);
    bytes.writeUInt16LE(1, 56);
    bytes.writeUInt32LE(46, 58);
    bytes.writeUInt32LE(0, 62);
    expect(() => validateWorkbookZip(bytes)).toThrow(/oversized/);
  });
});

describe("legacy API apply", () => {
  it("requires HTTPS except loopback and rejects credential/query API URLs", () => {
    expect(validateApiUrl("https://recruit.example.test")).toBe(
      "https://recruit.example.test",
    );
    expect(validateApiUrl("http://127.0.0.1:3000")).toBe(
      "http://127.0.0.1:3000",
    );
    for (const url of [
      "http://public.example.test",
      "https://user:pass@example.test",
      "https://example.test?key=secret",
    ])
      expect(() => validateApiUrl(url)).toThrow();
  });
  /**
   * An in-memory target API that lists, creates and patches records and already holds the fictional
   * private state. `fail` answers a matching write with HTTP 500 and stores nothing.
   */
  function fakeTarget(
    fail?: (resource: string, body: Record<string, unknown>) => boolean,
  ) {
    const store: Record<string, Record<string, unknown>[]> = {},
      requests: { path: string; body: Record<string, unknown> }[] = [];
    let sequence = 0;
    const fakeFetch: typeof fetch = async (request, options) => {
      const url = new URL(String(request)),
        path = url.pathname.split("/").filter(Boolean),
        resource = path[2],
        id = path[3];
      if (resource === "candidates" && path[4] === "state")
        return Response.json({
          data: {
            version: 1,
            shortlisted: true,
            status: "To contact",
            note: "Private fictional note",
            importMeta: {
              legacyUpdatedAt: "2020-01-01T00:00:00Z",
              legacyCandidateId: "c_1",
            },
          },
        });
      if (resource === "notifications") {
        requests.push({
          path: url.pathname,
          body: JSON.parse(String(options?.body)),
        });
        return Response.json({ updated: 0 });
      }
      store[resource] ||= [];
      if (!options?.method || options.method === "GET")
        return Response.json({
          data: store[resource],
          pagination: { page: 1, totalPages: 1 },
        });
      const body = JSON.parse(String(options.body));
      requests.push({ path: url.pathname, body });
      if (fail?.(resource, body))
        return Response.json({ code: "fictional_failure" }, { status: 500 });
      if (options.method === "PATCH") {
        const row = store[resource].find((v) => v.id === id)!;
        Object.assign(row, body);
        return Response.json({ data: row });
      }
      const row = {
        ...body,
        id: `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
        version: 1,
        archivedAt: body.archived ? "2026-11-02T00:00:00Z" : null,
      };
      store[resource].push(row);
      return Response.json({ data: row });
    };
    return { fakeFetch, store, requests };
  }
  const targetOptions = (fetchImpl: typeof fetch) => ({
    apiUrl: "https://recruit.example.test",
    teamId: "team",
    token: "fictional-token",
    fetchImpl,
  });
  /** Every planned item has exactly one outcome in its category. */
  function expectBalanced({ reconciliation }: ApplyResult) {
    const { records, states, files } = reconciliation;
    expect(
      records.created +
        records.updated +
        records.skipped +
        records.conflicts +
        records.failed,
    ).toBe(records.planned);
    expect(
      states.imported + states.unchanged + states.conflicts + states.failed,
    ).toBe(states.planned);
    expect(files.ready + files.skipped + files.failed).toBe(files.planned);
  }
  /** Plan B: c_1 renamed, checklist k_1 (no dependants) dropped, candidate c_2 added. */
  function changedInput(): LegacyInputs {
    const changed = input();
    const master = changed.workbooks["Resume_Master.xlsx"].Master;
    master[6][1] = "Fictional Example Revised";
    master.push([
      "c_2",
      "Fictional Newcomer",
      "newcomer@example.test",
      "Finance",
      "Not stated",
      1,
      "",
      "",
      "",
    ]);
    changed.workbooks["Recruitment_Operations.xlsx"].Checklist.splice(1, 1);
    return changed;
  }

  it("applies references topologically and reruns without duplicating or overwriting user edits", async () => {
    const plan = buildPlan(input());
    const { fakeFetch, store, requests } = fakeTarget();
    const opts = {
      apiUrl: "https://recruit.example.test",
      teamId: "team",
      token: "fictional-token",
      fetchImpl: fakeFetch,
    };
    const first = await applyPlan(plan, opts);
    expect(first.errors).toEqual([]);
    expect(first.created).toBe(plan.records.length);
    expect(first.notificationsImported).toBe(0);
    const notificationRequest = requests.find((v) =>
      v.path.endsWith("/notifications"),
    )!.body;
    expect((notificationRequest.keys as string[])[0]).toMatch(
      /:2026-10-21T05:00:00\.000Z$/,
    );
    const task = requests.find((v) => v.path.endsWith("/tasks"))!.body;
    expect(task.bucketId).toMatch(/^00000000/);
    expect(
      Object.keys((task.data as { customValues: object }).customValues)[0],
    ).toMatch(/^00000000/);
    const second = await applyPlan(plan, opts);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(plan.records.length);
    (store.candidates[0].data as { name: string }).name = "Manually corrected";
    const third = await applyPlan(plan, opts);
    expect(third.conflicts).toContain("candidates:c_1");
    expect((store.candidates[0].data as { name: string }).name).toBe(
      "Manually corrected",
    );
  });
  it("accounts for a changed plan without overwriting or deleting target records", async () => {
    const planA = buildPlan(input()),
      planB = buildPlan(changedInput());
    expect(planB.issues.filter((v) => v.severity === "error")).toEqual([]);
    const { fakeFetch, store } = fakeTarget();
    const first = await applyPlan(planA, targetOptions(fakeFetch));
    expect(first.missing).toEqual([]);
    expectBalanced(first);
    const result = await applyPlan(planB, targetOptions(fakeFetch));
    expect(result.errors).toEqual([]);
    expect(result.conflicts).toEqual(["candidates:c_1"]);
    expect(result.missing).toEqual(["checklist:k_1"]);
    expect(result.reconciliation.records).toEqual({
      planned: planB.records.length,
      created: 1,
      updated: 0,
      skipped: planB.records.length - 2,
      conflicts: 1,
      failed: 0,
      missing: 1,
    });
    expect(result.reconciliation.states).toEqual({
      planned: 1,
      imported: 0,
      unchanged: 1,
      conflicts: 0,
      failed: 0,
    });
    expect(result.reconciliation.files).toEqual({
      planned: planB.sources.length,
      ready: 0,
      skipped: planB.sources.length,
      failed: 0,
    });
    expectBalanced(result);
    expect(store.checklist.map((row) => row.legacyId)).toEqual(["k_1"]);
    expect(
      store.candidates.map((row) => [
        row.legacyId,
        (row.data as { name: string }).name,
      ]),
    ).toEqual([
      ["c_1", "Fictional Example"],
      ["c_2", "Fictional Newcomer"],
    ]);
  });
  it("updates the changed record only with updateExisting and still reports the missing one", async () => {
    const planB = buildPlan(changedInput());
    const { fakeFetch, store } = fakeTarget();
    await applyPlan(buildPlan(input()), targetOptions(fakeFetch));
    const result = await applyPlan(planB, {
      ...targetOptions(fakeFetch),
      updateExisting: true,
    });
    expect(result.errors).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.missing).toEqual(["checklist:k_1"]);
    expect(result.reconciliation.records).toEqual({
      planned: planB.records.length,
      created: 1,
      updated: 1,
      skipped: planB.records.length - 2,
      conflicts: 0,
      failed: 0,
      missing: 1,
    });
    expectBalanced(result);
    expect(store.checklist.map((row) => row.legacyId)).toEqual(["k_1"]);
    expect((store.candidates[0].data as { name: string }).name).toBe(
      "Fictional Example Revised",
    );
  });
  it("counts a record the API refuses as failed and keeps the totals balanced", async () => {
    const plan = buildPlan(input());
    const { fakeFetch, store } = fakeTarget(
      (resource) => resource === "comments",
    );
    const result = await applyPlan(plan, targetOptions(fakeFetch));
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        location: "comments:m_1",
        code: "fictional_failure",
      }),
    );
    expect(result.reconciliation.records).toMatchObject({
      planned: plan.records.length,
      created: plan.records.length - 1,
      failed: 1,
      missing: 0,
    });
    expectBalanced(result);
    expect(store.comments).toEqual([]);
  });
  it("stops before mutation when target permissions are denied", async () => {
    let writes = 0;
    const fakeFetch: typeof fetch = async (_url, options) => {
      if (options?.method !== "GET") writes++;
      return Response.json({ code: "FORBIDDEN" }, { status: 403 });
    };
    await expect(
      applyPlan(buildPlan(input()), {
        apiUrl: "https://recruit.example.test",
        teamId: "team",
        token: "fictional",
        fetchImpl: fakeFetch,
      }),
    ).rejects.toThrow(/403/);
    expect(writes).toBe(0);
  });
  it("preserves original personal-note whitespace privately and sends the normalized note only to its owner", async () => {
    const plan = buildPlan(input());
    plan.records = plan.records.filter((r) => r.resource === "candidates");
    plan.sources = [];
    plan.notificationReads = [];
    plan.states[0].note = "  Private note with original whitespace  ";
    let stateBody: Record<string, unknown> | undefined;
    const fakeFetch: typeof fetch = async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/state")) {
        if (options?.method === "PATCH") {
          stateBody = JSON.parse(String(options.body));
          return Response.json({ data: { ...stateBody, version: 1 } });
        }
        return Response.json({
          data: {
            version: 0,
            shortlisted: false,
            status: "New",
            note: "",
            importMeta: {},
          },
        });
      }
      if (options?.method === "POST")
        return Response.json({
          data: { id: "00000000-0000-4000-8000-000000000001" },
        });
      return Response.json({ data: [], pagination: { totalPages: 1 } });
    };
    const result = await applyPlan(plan, {
      apiUrl: "https://recruit.example.test",
      teamId: "team",
      token: "fictional",
      fetchImpl: fakeFetch,
    });
    expect(result.errors).toEqual([]);
    expect(result.reconciliation.states).toEqual({
      planned: 1,
      imported: 1,
      unchanged: 0,
      conflicts: 0,
      failed: 0,
    });
    expect(stateBody).toMatchObject({
      note: "Private note with original whitespace",
      importMeta: {
        originalNote: "  Private note with original whitespace  ",
        legacyUpdatedAt: "2020-01-01T00:00:00Z",
      },
    });
    expect(JSON.stringify(plan.records[0])).not.toContain(
      "Private note with original whitespace",
    );
  });
  it("uploads fictional CV bytes only to the issued S3 ticket without forwarding the API token", async () => {
    const root = await temp();
    await writeFile(join(root, "fictional.pdf"), "%PDF-1.7\nfictional");
    const { stat } = await import("node:fs/promises");
    const info = await stat(join(root, "fictional.pdf"));
    const plan = buildPlan(input());
    plan.root = root;
    plan.records = plan.records.filter((r) => r.resource === "candidates");
    plan.states = [];
    plan.notificationReads = [];
    plan.sources = [
      {
        id: "s_1",
        row: {},
        candidateIds: ["c_1"],
        relativePath: "fictional.pdf",
        sizeBytes: info.size,
        mtimeMs: info.mtimeMs,
        uploadable: true,
        mimeType: "application/pdf",
      },
    ];
    const candidateId = "00000000-0000-4000-8000-000000000001",
      cvId = "00000000-0000-4000-8000-000000000002";
    let storageCalls = 0,
      completeCalls = 0;
    const fakeFetch: typeof fetch = async (url, options) => {
      const parsed = new URL(String(url));
      if (parsed.hostname === "bucket.s3.eu-west-1.amazonaws.com") {
        storageCalls++;
        expect(new Headers(options?.headers).has("Authorization")).toBe(false);
        expect(options?.redirect).toBe("error");
        const form = options!.body as FormData;
        expect(form.get("policy")).toBe("fictional-policy");
        const blob = form.get("file") as Blob;
        expect(await blob.text()).toBe("%PDF-1.7\nfictional");
        return new Response(null, { status: 204 });
      }
      if (parsed.pathname.endsWith("/complete")) {
        completeCalls++;
        return Response.json({ data: { id: cvId, status: "ready" } });
      }
      if (parsed.pathname.endsWith("/cvs/uploads"))
        return Response.json({
          data: {
            id: cvId,
            candidateId,
            ...JSON.parse(String(options?.body)),
            status: "pending",
          },
          upload: {
            protocol: "s3-form-v1",
            method: "POST",
            url: "https://bucket.s3.eu-west-1.amazonaws.com/",
            fields: { policy: "fictional-policy" },
            expiresAt: "2030-01-01",
            maxBytes: info.size,
          },
        });
      if (options?.method === "POST")
        return Response.json({ data: { id: candidateId } });
      return Response.json({ data: [], pagination: { totalPages: 1 } });
    };
    const result = await applyPlan(plan, {
      apiUrl: "https://recruit.example.test",
      teamId: "team",
      token: "never-send-this-to-s3",
      fetchImpl: fakeFetch,
    });
    expect(result.errors).toEqual([]);
    expect(storageCalls).toBe(1);
    expect(completeCalls).toBe(1);
    expect(result.uploadsReady).toBe(1);
    expect(result.reconciliation.files).toEqual({
      planned: 1,
      ready: 1,
      skipped: 0,
      failed: 0,
    });
    expect(result.reconciliation.states.planned).toBe(0);
    expectBalanced(result);
  });
  it("rejects an offsite upload ticket before opening any local CV", async () => {
    const plan = buildPlan(input());
    plan.records = plan.records.filter((r) => r.resource === "candidates");
    plan.states = [];
    plan.notificationReads = [];
    plan.sources = [
      {
        id: "s_1",
        row: {},
        candidateIds: ["c_1"],
        relativePath: "must-not-read.pdf",
        sizeBytes: 100,
        mtimeMs: 0,
        uploadable: true,
        mimeType: "application/pdf",
      },
    ];
    const candidateId = "00000000-0000-4000-8000-000000000001",
      cvId = "00000000-0000-4000-8000-000000000002";
    let offsiteCalls = 0;
    const fakeFetch: typeof fetch = async (url, options) => {
      const parsed = new URL(String(url));
      if (parsed.hostname !== "recruit.example.test") {
        offsiteCalls++;
        throw new Error("No offsite access allowed");
      }
      if (parsed.pathname.endsWith("/cvs/uploads"))
        return Response.json({
          data: {
            id: cvId,
            candidateId,
            ...JSON.parse(String(options?.body)),
            status: "pending",
          },
          upload: {
            protocol: "s3-form-v1",
            method: "POST",
            url: "https://untrusted.example.test/",
            fields: {},
          },
        });
      if (options?.method === "POST")
        return Response.json({ data: { id: candidateId } });
      return Response.json({ data: [], pagination: { totalPages: 1 } });
    };
    const result = await applyPlan(plan, {
      apiUrl: "https://recruit.example.test",
      teamId: "team",
      token: "fictional",
      fetchImpl: fakeFetch,
    });
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "INVALID_UPLOAD_TICKET" }),
    );
    expect(offsiteCalls).toBe(0);
  });

  /** One fictional CV source and an API that answers its reservation with the given ticket. */
  async function importWithTicket(upload: (size: number) => unknown) {
    const root = await temp();
    await writeFile(join(root, "fictional.pdf"), "%PDF-1.7\nfictional blob");
    const { stat } = await import("node:fs/promises");
    const info = await stat(join(root, "fictional.pdf"));
    const plan = buildPlan(input());
    plan.root = root;
    plan.records = plan.records.filter((r) => r.resource === "candidates");
    plan.states = [];
    plan.notificationReads = [];
    plan.sources = [
      {
        id: "s_1",
        row: {},
        candidateIds: ["c_1"],
        relativePath: "fictional.pdf",
        sizeBytes: info.size,
        mtimeMs: info.mtimeMs,
        uploadable: true,
        mimeType: "application/pdf",
      },
    ];
    const candidateId = "00000000-0000-4000-8000-000000000001",
      cvId = "00000000-0000-4000-8000-000000000002";
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch: typeof fetch = async (url, options) => {
      const parsed = new URL(String(url));
      calls.push({ url: String(url), init: options });
      if (parsed.hostname !== "recruit.example.test")
        return new Response(null, { status: 200 });
      if (parsed.pathname.endsWith("/complete"))
        return Response.json({ data: { id: cvId, status: "ready" } });
      if (parsed.pathname.endsWith("/cvs/uploads"))
        return Response.json({
          data: {
            id: cvId,
            candidateId,
            ...JSON.parse(String(options?.body)),
            status: "pending",
          },
          upload: upload(info.size),
        });
      if (options?.method === "POST")
        return Response.json({ data: { id: candidateId } });
      return Response.json({ data: [], pagination: { totalPages: 1 } });
    };
    const result = await applyPlan(plan, {
      apiUrl: "https://recruit.example.test",
      teamId: "team",
      token: "never-send-this-to-blob",
      fetchImpl: fakeFetch,
    });
    const offsite = calls.filter(
      (call) => new URL(call.url).hostname !== "recruit.example.test",
    );
    const completions = calls.filter((call) => call.url.endsWith("/complete"));
    return { result, offsite, completions, calls };
  }
  const blobUrl =
    "https://vercel.com/api/blob/?pathname=teams%2Ft%2Fcvs%2Fc%2Fu%2Ffictional.pdf&vercel-blob-signature=fictional_signature_0001";
  const blobUpload = (size: number, extra: Record<string, unknown> = {}) => ({
    protocol: "blob-put-v1",
    method: "PUT",
    url: blobUrl,
    headers: { "content-type": "application/pdf" },
    expiresAt: "2030-01-01T00:00:00.000Z",
    maxBytes: size,
    ...extra,
  });

  it("PUTs fictional CV bytes to a tagged Blob ticket without the API token, then completes", async () => {
    const { result, offsite, completions, calls } = await importWithTicket(
      (size) => blobUpload(size),
    );
    expect(result.errors).toEqual([]);
    expect(result.uploadsReady).toBe(1);
    expect(offsite).toHaveLength(1);
    const [put] = offsite;
    expect(put.url).toBe(blobUrl);
    expect(put.url.startsWith("https://vercel.com/api/blob/?")).toBe(true);
    expect(put.init?.method).toBe("PUT");
    expect(put.init?.redirect).toBe("error");
    expect(put.init?.credentials).toBe("omit");
    const headers = new Headers(put.init?.headers);
    expect([...headers.keys()]).toEqual(["content-type"]);
    expect(headers.get("content-type")).toBe("application/pdf");
    expect(new TextDecoder().decode(put.init?.body as Uint8Array)).toBe(
      "%PDF-1.7\nfictional blob",
    );
    expect(completions).toHaveLength(1);
    expect(calls.indexOf(completions[0])).toBeGreaterThan(calls.indexOf(put));
  });

  it("records an error and sends no CV bytes for an unsupported or unsafe upload ticket", async () => {
    const cases: [string, (size: number) => unknown][] = [
      [
        "UNSUPPORTED_UPLOAD_PROTOCOL",
        (size) => blobUpload(size, { protocol: "ftp-v1" }),
      ],
      [
        "UNSUPPORTED_UPLOAD_PROTOCOL",
        () => ({
          url: "https://bucket.s3.eu-west-1.amazonaws.com/",
          fields: { policy: "fictional-policy" },
        }),
      ],
      [
        "INVALID_UPLOAD_TICKET",
        (size) =>
          blobUpload(size, {
            url: blobUrl.replace("vercel.com", "blob.example.test"),
          }),
      ],
      [
        "INVALID_UPLOAD_TICKET",
        (size) => blobUpload(size, { maxBytes: size + 1 }),
      ],
      [
        "INVALID_UPLOAD_TICKET",
        (size) =>
          blobUpload(size, {
            url: "https://bucket.s3.eu-west-1.amazonaws.com/",
          }),
      ],
      ["INVALID_UPLOAD_TICKET", (size) => blobUpload(size, { method: "POST" })],
      [
        "INVALID_UPLOAD_TICKET",
        (size) =>
          blobUpload(size, {
            headers: {
              "content-type": "application/pdf",
              authorization: "Bearer fictional",
            },
          }),
      ],
      [
        "INVALID_UPLOAD_TICKET",
        (size) => ({
          ...blobUpload(size),
          protocol: "s3-form-v1",
          method: "PUT",
          url: "https://bucket.s3.eu-west-1.amazonaws.com/",
          fields: {},
        }),
      ],
    ];
    for (const [code, upload] of cases) {
      const { result, offsite, completions } = await importWithTicket(upload);
      expect(result.errors, code).toEqual([
        expect.objectContaining({ location: "CV:s_1", code }),
      ]);
      expect(result.uploadsReady).toBe(0);
      expect(result.reconciliation.files).toEqual({
        planned: 1,
        ready: 0,
        skipped: 0,
        failed: 1,
      });
      expectBalanced(result);
      expect(offsite).toHaveLength(0);
      expect(completions).toHaveLength(0);
    }
  });
});
