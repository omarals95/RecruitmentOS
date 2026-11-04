import { afterEach, describe, expect, it, vi } from "vitest";

// Every SDK export the script could reach is a spy; no case below passes every check.
vi.mock("@vercel/blob", () => ({
  issueSignedToken: vi.fn(),
  presignUrl: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
  list: vi.fn(),
}));

import * as sdk from "@vercel/blob";
import { main } from "../scripts/blob-live-verify";

const flag = "--confirm-live-preview-blob";
const store = ["--store", "store_fictional0001"];
const token = { BLOB_READ_WRITE_TOKEN: "fictional-preview-token" };

describe("blob-live-verify refusals", () => {
  afterEach(() => vi.restoreAllMocks());

  const cases: [string, string[], Record<string, string | undefined>][] = [
    ["no arguments", [], token],
    ["only the confirmation flag", [flag], token],
    ["no token", [flag, ...store], {}],
    ["production", [flag, ...store], { ...token, VERCEL_ENV: "production" }],
    ["an invalid store id", [flag, "--store", "store_bad/id"], token],
    ["a store id without the prefix", [flag, "--store", "fictional"], token],
    ["an unknown option", [flag, ...store, "--file", "cv.pdf"], token],
  ];
  for (const [label, args, env] of cases)
    it(`refuses ${label} before any SDK or network call`, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const logs = vi.spyOn(console, "log").mockImplementation(() => {});
      expect(await main(args, env)).not.toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      for (const call of [
        sdk.issueSignedToken,
        sdk.presignUrl,
        sdk.get,
        sdk.del,
        sdk.list,
      ])
        expect(vi.mocked(call)).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0][0])).toMatch(/^Refused:/);
      expect(String(errors.mock.calls[0][0])).not.toContain(
        token.BLOB_READ_WRITE_TOKEN,
      );
      expect(logs).not.toHaveBeenCalled();
    });

  it("states the Preview-only, fictional-only and owner-only rules in its help", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["--help"], {})).toBe(0);
    const help = String(logs.mock.calls[0][0]);
    expect(help).toMatch(/PREVIEW/);
    expect(help).toMatch(/fictional/);
    expect(help).toMatch(/Agents must never run it/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
