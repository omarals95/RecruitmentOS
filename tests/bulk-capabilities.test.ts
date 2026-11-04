import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/principal", () => ({
  requirePrincipal: vi.fn(async () => ({
    scopes: ["candidates:write", "cvs:write"],
  })),
}));

const storageKeys = [
  "CV_STORAGE_PROVIDER",
  "S3_BUCKET_NAME",
  "AWS_REGION",
  "AWS_ROLE_ARN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
];
async function capabilities() {
  const { GET } = await import("@/app/api/v1/cvs/bulk-capabilities/route");
  const response = await GET(
    new Request("http://localhost:3000/api/v1/cvs/bulk-capabilities"),
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response.json();
}

describe("bulk CV capabilities", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("remains disabled even if storage and AI environment settings are present", async () => {
    vi.stubEnv("CV_STORAGE_PROVIDER", "blob");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "synthetic");
    expect(await capabilities()).toEqual({
      data: {
        uploadsAvailable: false,
        aiAvailable: false,
        storageConfigured: false,
      },
    });
  });

  it("reports configured storage truthfully while uploads stay unavailable", async () => {
    for (const key of storageKeys) vi.stubEnv(key, undefined);
    vi.stubEnv("S3_BUCKET_NAME", "fictional-private-cvs");
    vi.stubEnv("AWS_REGION", "eu-west-2");
    vi.stubEnv("AWS_ROLE_ARN", "arn:aws:iam::000000000000:role/fictional");
    expect(await capabilities()).toEqual({
      data: {
        uploadsAvailable: false,
        aiAvailable: false,
        storageConfigured: true,
      },
    });
  });

  it("reports missing storage setup", async () => {
    for (const key of storageKeys) vi.stubEnv(key, undefined);
    expect(await capabilities()).toEqual({
      data: {
        uploadsAvailable: false,
        aiAvailable: false,
        storageConfigured: false,
      },
    });
  });
});
