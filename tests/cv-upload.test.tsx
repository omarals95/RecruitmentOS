import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CvUpload, uploadCandidateCv } from "../src/components/cv-upload";
import type { UploadTicket } from "../src/components/cv-transfer";

const render = (storageConfigured: boolean) =>
  renderToStaticMarkup(
    <CvUpload
      candidateId="00000000-0000-4000-8000-000000000001"
      teamId="fictional-team"
      storageConfigured={storageConfigured}
    />,
  );

describe("CvUpload", () => {
  it("explains the setup-required state without upload controls or technical names", () => {
    const markup = render(false);
    expect(markup).toContain('aria-label="Upload candidate CV"');
    expect(markup).toContain("CV uploads are not set up yet.");
    expect(markup).toContain("administrator");
    expect(markup).not.toContain('type="file"');
    expect(markup).not.toContain("Upload CV");
    expect(markup).not.toMatch(
      /S3|AWS|Amazon|Blob|Vercel|_NAME|_ARN|environment/i,
    );
  });

  it("renders today's upload controls when storage is configured", () => {
    const markup = render(true);
    expect(markup).toContain("Attach a CV");
    expect(markup).toContain('type="file"');
    expect(markup).toContain("Upload CV");
    expect(markup).not.toContain("CV uploads are not set up yet.");
  });
});

describe("uploadCandidateCv", () => {
  // Fictional IDs, URLs and bytes only; no request leaves the fake fetch.
  const candidateId = "00000000-0000-4000-8000-000000000001";
  const uploadId = "00000000-0000-4000-8000-0000000000e1";
  const clientUploadId = "00000000-0000-4000-8000-0000000000f1";
  const file = new File(["%PDF-1.7\nfictional"], "fictional-cv.pdf", {
    type: "application/pdf",
  });
  const blobTicket: UploadTicket = {
    protocol: "blob-put-v1",
    method: "PUT",
    url: "https://vercel.com/api/blob/?pathname=teams%2Ft%2Fcvs%2Ffictional.pdf",
    headers: { "content-type": "application/pdf" },
    expiresAt: "2030-01-01T00:00:00.000Z",
    maxBytes: file.size,
  };
  const s3Ticket: UploadTicket = {
    protocol: "s3-form-v1",
    method: "POST",
    url: "https://bucket.s3.eu-west-1.amazonaws.com/",
    fields: { key: "teams/t/cvs/fictional.pdf" },
    expiresAt: "2030-01-01T00:00:00.000Z",
    maxBytes: file.size,
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  /** Answers the reservation with `upload`, storage with `stored` and completion with `completed`. */
  function fakeFetch(
    upload: UploadTicket | null,
    stored: number,
    completed: number,
  ) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/cvs/uploads"))
        return json(201, { data: { id: uploadId, status: "pending" }, upload });
      if (url.endsWith("/complete"))
        return completed === 200
          ? json(200, { data: { id: uploadId, status: "ready" } })
          : json(completed, {
              error: { message: "This upload is not available." },
            });
      return new Response(null, { status: stored });
    };
    const completions = () =>
      calls.filter((call) => call.url.endsWith("/complete")).length;
    const storage = () =>
      calls.filter((call) => !call.url.startsWith("/api/")).length;
    return { calls, fetchImpl, completions, storage };
  }
  const run = (fetchImpl: typeof fetch, phases: string[] = []) =>
    uploadCandidateCv({
      teamId: "fictional-team",
      candidateId,
      file,
      clientUploadId,
      onPhase: (phase) => phases.push(phase),
      fetchImpl,
    });

  it("(a) completes once after a Blob PUT that storage accepted", async () => {
    const fake = fakeFetch(blobTicket, 201, 200);
    const phases: string[] = [];
    await expect(run(fake.fetchImpl, phases)).resolves.toBeUndefined();
    expect(fake.storage()).toBe(1);
    expect(fake.completions()).toBe(1);
    expect(phases).toEqual([
      "Preparing secure upload…",
      "Uploading CV…",
      "Checking document format…",
    ]);
  });

  it("(b) still completes once after a refused Blob PUT, since an earlier PUT may have stored the bytes", async () => {
    const fake = fakeFetch(blobTicket, 409, 200);
    await expect(run(fake.fetchImpl)).resolves.toBeUndefined();
    expect(fake.storage()).toBe(1);
    expect(fake.completions()).toBe(1);
  });

  it("(c) reports the storage refusal when completion after a refused Blob PUT fails", async () => {
    const fake = fakeFetch(blobTicket, 409, 409);
    await expect(run(fake.fetchImpl)).rejects.toThrow(
      new Error("Private storage did not accept the CV (HTTP 409)."),
    );
    expect(fake.completions()).toBe(1);
  });

  it("(d) refuses a refused S3 POST without completing", async () => {
    const fake = fakeFetch(s3Ticket, 403, 200);
    await expect(run(fake.fetchImpl)).rejects.toThrow(
      new Error("Private storage did not accept the CV (HTTP 403)."),
    );
    expect(fake.storage()).toBe(1);
    expect(fake.completions()).toBe(0);
  });

  it("(e) sends nothing and does not complete for a ready replay", async () => {
    const fake = fakeFetch(null, 201, 200);
    await expect(run(fake.fetchImpl)).resolves.toBeUndefined();
    expect(fake.calls.map((call) => call.url)).toEqual([
      `/api/v1/candidates/${candidateId}/cvs/uploads`,
    ]);
  });

  it("(f) reserves under the given clientUploadId and sends the team header to the API only", async () => {
    const fake = fakeFetch(blobTicket, 201, 200);
    await run(fake.fetchImpl);
    const [reserve, store, complete] = fake.calls;
    expect(reserve.url).toBe(`/api/v1/candidates/${candidateId}/cvs/uploads`);
    expect(reserve.init?.method).toBe("POST");
    expect(JSON.parse(String(reserve.init?.body))).toEqual({
      originalName: "fictional-cv.pdf",
      mimeType: "application/pdf",
      sizeBytes: file.size,
      clientUploadId,
    });
    expect(complete.url).toBe(`/api/v1/cvs/uploads/${uploadId}/complete`);
    expect(complete.init?.method).toBe("POST");
    for (const call of [reserve, complete])
      expect(new Headers(call.init?.headers).get("x-team-id")).toBe(
        "fictional-team",
      );
    expect(new Headers(store.init?.headers).has("x-team-id")).toBe(false);
  });
});
