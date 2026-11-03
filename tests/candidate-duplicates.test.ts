import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));
vi.mock("@/lib/api-tokens", () => ({ authenticateApiToken: vi.fn() }));
import * as recordService from "@/lib/records";
import { getVerifiedSession } from "@/lib/auth-session";
import { authenticateApiToken } from "@/lib/api-tokens";
import { ApiError } from "@/lib/errors";
import { POST } from "@/app/api/v1/candidates/duplicates/route";
import type { Principal } from "@/lib/principal";
import { createTestDb, enforceTestRls, seedIdentity } from "./helpers/db";

describe("possible candidate duplicates", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let owner: Principal;
  let other: Principal;

  beforeAll(async () => {
    fixture = await createTestDb();
    owner = await seedIdentity(fixture.db);
    other = await seedIdentity(fixture.db, {
      userId: "duplicate-other",
      teamId: "duplicate-other-team",
    });
    await enforceTestRls(fixture.db);
  });
  afterAll(async () => fixture?.close());

  it("finds exact normalized contact matches only within the selected team", async () => {
    const local = await recordService.createRecord(owner, "candidates", {
      data: {
        name: "Synthetic Local",
        email: "person@example.test",
        phone: "+971 50 123 4567",
      },
    });
    await recordService.createRecord(other, "candidates", {
      data: { name: "Synthetic Other", email: "person@example.test" },
    });
    const matches = await recordService.findCandidateDuplicates(owner, {
      email: " PERSON@EXAMPLE.TEST ",
      phone: "+971-50-123-4567",
    });
    expect(matches).toEqual([
      {
        id: local.id,
        name: "Synthetic Local",
        email: "person@example.test",
        phone: "+971 50 123 4567",
        matches: ["email", "phone"],
      },
    ]);
  });

  it("rejects empty queries and requires candidate-read scope", async () => {
    await expect(
      recordService.findCandidateDuplicates(owner, {}),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      recordService.findCandidateDuplicates(
        { ...owner, scopes: [] },
        { email: "person@example.test" },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("enforces authentication, origin, token scope and token team at the route", async () => {
    const request = (headers: Record<string, string>) =>
      new Request("http://localhost:3000/api/v1/candidates/duplicates", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ email: "person@example.test" }),
      });
    vi.mocked(getVerifiedSession).mockRejectedValue(
      new ApiError(401, "unauthenticated", "Sign in required."),
    );
    expect(
      (await POST(request({ origin: "http://localhost:3000" }))).status,
    ).toBe(401);
    expect(
      (await POST(request({ origin: "https://other.example.test" }))).status,
    ).toBe(403);
    vi.mocked(authenticateApiToken).mockResolvedValue({
      ...owner,
      authType: "token",
      scopes: [],
    });
    expect(
      (await POST(request({ authorization: "Bearer synthetic" }))).status,
    ).toBe(403);
    vi.mocked(authenticateApiToken).mockResolvedValue({
      ...owner,
      authType: "token",
    });
    expect(
      (
        await POST(
          request({
            authorization: "Bearer synthetic",
            "x-team-id": other.teamId,
          }),
        )
      ).status,
    ).toBe(403);
    const result = await POST(request({ authorization: "Bearer synthetic" }));
    expect(result.status).toBe(200);
    expect(
      (await result.json()).data.map((row: { name: string }) => row.name),
    ).toEqual(["Synthetic Local"]);
  });
});
