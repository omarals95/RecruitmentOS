import { afterEach, describe, expect, it, vi } from "vitest";
import config from "../next.config";

async function csp(provider: string | undefined) {
  vi.stubEnv("CV_STORAGE_PROVIDER", provider);
  const [rule] = await config.headers!();
  const value = rule.headers.find(
    (header) => header.key === "Content-Security-Policy",
  )!.value;
  const directives = new Map(
    value.split(";").map((directive) => {
      const [name, ...sources] = directive.trim().split(/\s+/);
      return [name, sources.join(" ")] as const;
    }),
  );
  const connectSrc = directives.get("connect-src")!;
  directives.delete("connect-src");
  return { connectSrc, others: Object.fromEntries(directives) };
}

const s3Hosts = [
  "https://*.s3.amazonaws.com",
  "https://*.s3.*.amazonaws.com",
  "https://s3.*.amazonaws.com",
];

describe("Content-Security-Policy connect-src by configured CV storage provider", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("runs outside development", () => {
    expect(process.env.NODE_ENV).not.toBe("development");
  });

  for (const provider of ["s3", " S3 "])
    it(`lists only the S3 upload hosts for "${provider}"`, async () => {
      const { connectSrc } = await csp(provider);
      expect(connectSrc.split(" ")).toEqual(["'self'", ...s3Hosts]);
      expect(connectSrc).not.toContain("vercel.com");
    });

  for (const provider of [
    undefined,
    "",
    "blob",
    "vercel-blob",
    " Vercel-Blob ",
  ])
    it(`lists only the Blob upload path for ${JSON.stringify(provider) ?? "an unset provider"}`, async () => {
      const { connectSrc } = await csp(provider);
      expect(connectSrc).toBe("'self' https://vercel.com/api/blob/");
      expect(connectSrc).not.toContain("amazonaws.com");
    });

  it("lists no upload host for an unsupported provider", async () => {
    for (const provider of ["other", "unexpected"])
      expect((await csp(provider)).connectSrc).toBe("'self'");
  });

  it("keeps every other directive identical across providers", async () => {
    const baseline = (await csp(undefined)).others;
    expect(Object.keys(baseline)).toContain("default-src");
    for (const provider of ["s3", "blob", " Vercel-Blob ", "other"])
      expect((await csp(provider)).others).toEqual(baseline);
  });
});
