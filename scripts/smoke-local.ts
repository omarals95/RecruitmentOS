import "./load-env";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { seedTotpCode } from "./totp";
type Row = { id: string; version: number; data: Record<string, unknown> };
async function main() {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.DATABASE_MODE !== "pglite" ||
    process.env.ALLOW_LOCAL_DB !== "true"
  )
    throw new Error(
      "This smoke test is restricted to the fictional local PGlite workspace.",
    );
  const origin = process.env.BETTER_AUTH_URL || "http://localhost:3000";
  const url = new URL(origin);
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.protocol !== "http:"
  )
    throw new Error("Only an HTTP loopback test server is allowed.");
  if (!process.env.DEV_SEED_TOTP_KEY)
    throw new Error(
      "Set DEV_SEED_TOTP_KEY to the key npm run db:seed printed; the seed owner signs in with a two-step code.",
    );
  const password = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({
      email: "recruiter@example.test",
      password: process.env.DEV_SEED_PASSWORD,
    }),
    redirect: "error",
  });
  assert.equal(password.status, 200, "fictional sign-in");
  assert.equal(
    ((await password.json()) as { twoFactorRedirect?: boolean })
      .twoFactorRedirect,
    true,
    "two-step challenge",
  );
  const cookieOf = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .filter((pair) => !pair.endsWith("="))
      .join("; ");
  const login = await fetch(`${origin}/api/auth/two-factor/verify-totp`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      cookie: cookieOf(password),
    },
    body: JSON.stringify({ code: seedTotpCode(process.env) }),
    redirect: "error",
  });
  assert.equal(login.status, 200, "fictional two-step code");
  const cookie = cookieOf(login);
  assert.ok(cookie, "session cookie");
  const authHeaders = { origin, cookie, "content-type": "application/json" };
  const teamsResponse = await fetch(`${origin}/api/auth/organization/list`, {
    headers: authHeaders,
    redirect: "error",
  });
  assert.equal(teamsResponse.status, 200, "team list");
  const teams = (await teamsResponse.json()) as { id: string; slug: string }[];
  const team = teams.find((t) => t.slug === "fictional-studio");
  assert.ok(team, "fictional team only");
  const headers = { ...authHeaders, "x-team-id": team.id };
  let checks = 2;
  const created: { resource: string; row: Row }[] = [];
  let tokenId: string | undefined;
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    extra?: HeadersInit,
    expected = 200,
  ) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { ...headers, ...extra },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
    });
    assert.equal(response.status, expected, `${method} ${path}`);
    checks++;
    return response;
  }
  async function create(
    resource: string,
    data: Record<string, unknown>,
    refs: Record<string, string> = {},
  ) {
    const response = await request(
      `/api/v1/${resource}`,
      "POST",
      { data, ...refs },
      { "idempotency-key": randomUUID() },
      201,
    );
    const { data: row } = (await response.json()) as { data: Row };
    created.push({ resource, row });
    return row;
  }
  try {
    const page = await request("/app");
    assert.match(
      await page.text(),
      /Fictional Studio/,
      "authenticated server-rendered workspace",
    );
    const initial = await request("/api/v1/candidates");
    assert.ok((await initial.json()).pagination.total >= 6);
    const unique = randomUUID().slice(0, 8);
    const candidate = await create("candidates", {
      name: `Fictional Smoke ${unique}`,
      email: `smoke-${unique}@example.test`,
      folderCategories: ["Smoke test"],
      skills: ["TypeScript"],
    });
    const role = await create("job-roles", {
      title: `Fictional role ${unique}`,
      department: "Test team",
    });
    const vacancy = await create(
      "vacancies",
      {
        title: `Fictional vacancy ${unique}`,
        requisitionId: `SMOKE-${unique}`,
        status: "Open",
      },
      { jobRoleId: role.id },
    );
    const application = await create(
      "applications",
      { stage: "Sourced" },
      { candidateId: candidate.id, vacancyId: vacancy.id },
    );
    const moved = await request(
      `/api/v1/applications/${application.id}`,
      "PATCH",
      { version: application.version, data: { stage: "Interview" } },
    );
    application.version = (await moved.json()).data.version;
    await request(
      `/api/v1/applications/${application.id}`,
      "PATCH",
      { version: 1, data: { stage: "Offer" } },
      undefined,
      409,
    );
    const bulk = await request("/api/v1/applications/bulk", "POST", {
      candidateIds: [candidate.id],
      vacancyId: vacancy.id,
    });
    assert.equal((await bulk.json()).skipped, 1);
    const bucketResponse = await request("/api/v1/buckets");
    const buckets = (await bucketResponse.json()).data as Row[];
    assert.ok(buckets.length >= 2);
    const field = await create("task-fields", {
      name: `Test checkbox ${unique}`,
      type: "Checkbox",
      required: false,
    });
    const task = await create(
      "tasks",
      {
        title: `Fictional hiring task ${unique}`,
        context: "Fictional workflow test",
        customValues: { [field.id]: false },
      },
      {
        candidateId: candidate.id,
        vacancyId: vacancy.id,
        bucketId: buckets[0].id,
      },
    );
    const taskMoved = await request(`/api/v1/tasks/${task.id}`, "PATCH", {
      version: task.version,
      bucketId: buckets[1].id,
    });
    task.version = (await taskMoved.json()).data.version;
    await create(
      "interviews",
      {
        title: "Fictional smoke interview",
        startAt: new Date(Date.now() + 3_600_000).toISOString(),
        minutes: 30,
      },
      { applicationId: application.id },
    );
    await create(
      "offers",
      {
        title: "Fictional smoke offer",
        amount: "10000",
        currency: "AED",
        status: "Draft",
      },
      { applicationId: application.id },
    );
    const onboarding = await create(
      "onboarding",
      { status: "In progress" },
      { applicationId: application.id },
    );
    await create(
      "checklist",
      {
        title: "Fictional orientation",
        category: "Orientation",
        status: "Complete",
      },
      { onboardingId: onboarding.id },
    );
    await create(
      "comments",
      { body: "Fictional shared discussion for the local smoke test." },
      { parentRecordId: candidate.id },
    );
    const state = await request(`/api/v1/candidates/${candidate.id}/state`);
    const version = (await state.json()).data.version;
    await request(`/api/v1/candidates/${candidate.id}/state`, "PATCH", {
      version,
      shortlisted: true,
      status: "To contact",
      note: "Fictional private note.",
    });
    const filtered = await request(
      "/api/v1/candidates?folderCategory=Smoke%20test",
    );
    assert.ok(
      (await filtered.json()).data.some((r: Row) => r.id === candidate.id),
    );
    for (const path of [
      "/api/v1/overview",
      "/api/v1/analytics",
      "/api/v1/notifications",
      "/api/v1/activity?page=1&pageSize=30&search=&kind=",
      "/api/v1/activity?search=Created&kind=candidate",
      "/api/v1/search?q=Fictional",
      "/api/openapi.json",
    ])
      await request(path);
    for (const section of [
      "candidates",
      "shortlist",
      "vacancies",
      "roles",
      "pipeline",
      "tasks",
      "interviews",
      "offers",
      "onboarding",
      "analytics",
      "activity",
      "notifications",
      "insights",
      "source-review",
      "settings/about",
      "settings/api-tokens",
      "settings/profile",
    ])
      await request(`/app/${section}`);
    await request(
      "/api/v1/analytics?to=bad-date",
      "GET",
      undefined,
      undefined,
      400,
    );
    const cv = await request(`/api/v1/candidates/${candidate.id}/cvs`);
    assert.equal((await cv.json()).data.length, 0);
    await request(
      `/api/v1/candidates/${candidate.id}/cvs/uploads`,
      "POST",
      {
        originalName: "fictional.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        clientUploadId: randomUUID(),
      },
      undefined,
      503,
    );
    await request(
      "/api/v1/candidates",
      "POST",
      { data: { name: "Rejected cross-origin request" } },
      { origin: "https://untrusted.example.test" },
      403,
    );
    const tokenResponse = await request(
      "/api/settings/tokens",
      "POST",
      {
        name: `Fictional smoke ${unique}`,
        scopes: ["candidates:read"],
        expiresInDays: 1,
      },
      undefined,
      201,
    );
    const material = (await tokenResponse.json()) as {
      token: string;
      data: { id: string };
    };
    tokenId = material.data.id;
    const tokenHeaders = {
      authorization: `Bearer ${material.token}`,
      "content-type": "application/json",
    };
    const read = await fetch(`${origin}/api/v1/candidates`, {
      headers: tokenHeaders,
      redirect: "error",
    });
    assert.equal(read.status, 200);
    checks++;
    const write = await fetch(`${origin}/api/v1/candidates`, {
      method: "POST",
      headers: tokenHeaders,
      body: JSON.stringify({ data: { name: "Not permitted" } }),
      redirect: "error",
    });
    assert.equal(write.status, 403);
    checks++;
    const wrongTeam = await fetch(`${origin}/api/v1/candidates`, {
      headers: { ...tokenHeaders, "x-team-id": "wrong-team" },
      redirect: "error",
    });
    assert.equal(wrongTeam.status, 403);
    checks++;
    await request(`/api/settings/tokens/${tokenId}`, "DELETE");
    tokenId = undefined;
    const revoked = await fetch(`${origin}/api/v1/candidates`, {
      headers: tokenHeaders,
      redirect: "error",
    });
    assert.equal(revoked.status, 401);
    checks++;
  } finally {
    if (tokenId)
      await request(`/api/settings/tokens/${tokenId}`, "DELETE").catch(
        () => {},
      );
    for (const { resource, row } of created.toReversed()) {
      if (resource === "comments") continue;
      await request(`/api/v1/${resource}/${row.id}`, "PATCH", {
        version: row.version,
        archived: true,
      }).catch(() => {});
    }
  }
  console.log(
    `Local HTTP smoke test passed: ${checks} assertions/requests; fictional records archived, test token revoked. Browser interaction and live cloud checks are separate.`,
  );
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Local smoke test failed.",
  );
  process.exitCode = 1;
});
