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

  for (const provider of ["blob", "vercel-blob", " Vercel-Blob "])
    it(`lists only the Blob upload path for ${JSON.stringify(provider)}`, async () => {
      const { connectSrc } = await csp(provider);
      expect(connectSrc).toBe("'self' https://vercel.com/api/blob/");
      expect(connectSrc).not.toContain("amazonaws.com");
    });

  it("lists no upload host for an unset, empty or unsupported provider", async () => {
    for (const provider of [undefined, "", " ", "other", "unexpected"])
      expect((await csp(provider)).connectSrc, String(provider)).toBe("'self'");
  });

  it("keeps every other directive identical across providers", async () => {
    const baseline = (await csp(undefined)).others;
    expect(Object.keys(baseline)).toContain("default-src");
    for (const provider of ["s3", "blob", " Vercel-Blob ", "other"])
      expect((await csp(provider)).others).toEqual(baseline);
  });

  it("sends HSTS without preload and an opener isolation policy on every path, for every provider", async () => {
    for (const provider of [undefined, "blob", "s3"]) {
      vi.stubEnv("CV_STORAGE_PROVIDER", provider);
      const [rule, ...others] = await config.headers!();
      expect(rule.source).toBe("/(.*)");
      const header = (key: string) =>
        rule.headers.find((item) => item.key === key)?.value;
      expect(header("Strict-Transport-Security")).toBe(
        "max-age=63072000; includeSubDomains",
      );
      expect(header("Cross-Origin-Opener-Policy")).toBe("same-origin");
      // Later rules only add X-App-Version to paths the first rule already covers.
      for (const other of others)
        expect(other.headers.map((item) => item.key)).toEqual([
          "X-App-Version",
        ]);
    }
  });
});
