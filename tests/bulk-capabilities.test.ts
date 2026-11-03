import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/principal", () => ({
  requirePrincipal: vi.fn(async () => ({
    scopes: ["candidates:write", "cvs:write"],
  })),
}));

describe("bulk CV capabilities", () => {
  it("remains disabled even if storage and AI environment settings are present", async () => {
    vi.stubEnv("CV_STORAGE_PROVIDER", "blob");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "synthetic");
    const { GET } = await import("@/app/api/v1/cvs/bulk-capabilities/route");
    const response = await GET(
      new Request("http://localhost:3000/api/v1/cvs/bulk-capabilities"),
    );
    expect(await response.json()).toEqual({
      data: { uploadsAvailable: false, aiAvailable: false },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    vi.unstubAllEnvs();
  });
});
