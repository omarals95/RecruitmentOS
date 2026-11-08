import { describe, expect, it } from "vitest";
import {
  tokenInputSchema,
  createTokenMaterial,
  hashToken,
  effectiveTokenScopes,
  parseBearerToken,
} from "../src/lib/api-token-policy";
import {
  API_TOKEN_SCOPES,
  MCP_SCOPES,
  SCOPES,
  roleScopes,
} from "../src/lib/permissions";

const added = [
  "directory:read",
  "directory:write",
  "plans:read",
  "plans:write",
] as const;
const recruiter = [
  "candidates:read",
  "candidates:write",
  "recruitment:read",
  "recruitment:write",
  "cvs:read",
  "cvs:write",
];
const viewer = ["candidates:read", "recruitment:read", "cvs:read"];

describe("personal API token policy", () => {
  it("creates a 256-bit secret and retains only its SHA256 digest for persistence", () => {
    const first = createTokenMaterial();
    const second = createTokenMaterial();
    expect(first.token).toMatch(/^ros_live_[A-Za-z0-9_-]{43}$/);
    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.tokenHash).toBe(hashToken(first.token));
    expect(first.prefix).not.toContain(first.token.slice(-10));
  });

  it("limits grants to explicit current role permissions", () => {
    expect(
      effectiveTokenScopes(
        ["candidates:read", "candidates:write", "imports:write"],
        "viewer",
      ),
    ).toEqual(["candidates:read"]);
    expect(
      effectiveTokenScopes(["candidates:read", "imports:write"], "recruiter"),
    ).toEqual(["candidates:read"]);
    expect(
      effectiveTokenScopes(["candidates:read", "imports:write"], "owner"),
    ).toEqual(["candidates:read", "imports:write"]);
    expect(effectiveTokenScopes(["candidates:read"], "unknown")).toEqual([]);
  });

  it("defaults expiry and rejects oversized, unknown or empty scope requests", () => {
    const valid = tokenInputSchema.parse({
      name: "My import",
      scopes: ["candidates:read"],
    });
    expect(valid.expiresInDays).toBe(30);
    expect(
      tokenInputSchema.safeParse({
        name: "Import",
        scopes: [],
        expiresInDays: 30,
      }).success,
    ).toBe(false);
    expect(
      tokenInputSchema.safeParse({ name: "Import", scopes: ["admin:all"] })
        .success,
    ).toBe(false);
    expect(
      tokenInputSchema.safeParse({
        name: "Import",
        scopes: ["candidates:read"],
        expiresInDays: 366,
      }).success,
    ).toBe(false);
    expect(
      tokenInputSchema.safeParse({
        name: "Import",
        scopes: ["candidates:read"],
        expiresInDays: 0,
      }).success,
    ).toBe(false);
  });

  it("appends the directory and plan scopes and caps them at owner and admin", () => {
    expect(SCOPES).toEqual([...recruiter, "imports:write", ...added]);
    expect(roleScopes("owner")).toEqual([...SCOPES]);
    expect(roleScopes("admin")).toEqual([...SCOPES]);
    expect(roleScopes("recruiter")).toEqual(recruiter);
    expect(roleScopes("viewer")).toEqual(viewer);
    expect(effectiveTokenScopes([...SCOPES], "recruiter")).toEqual(recruiter);
    expect(effectiveTokenScopes([...SCOPES], "viewer")).toEqual(viewer);
    for (const scope of added) {
      expect(
        tokenInputSchema.safeParse({ name: "Import", scopes: [scope] }).success,
        scope,
      ).toBe(false);
      expect(MCP_SCOPES as readonly string[], scope).not.toContain(scope);
      expect(API_TOKEN_SCOPES as readonly string[], scope).not.toContain(scope);
    }
  });

  it("accepts only one strict bearer credential", () => {
    const secret = createTokenMaterial().token;
    expect(parseBearerToken(`Bearer ${secret}`)).toBe(secret);
    expect(parseBearerToken(`bearer ${secret}`)).toBe(secret);
    expect(parseBearerToken(`Bearer ${secret}, another`)).toBeNull();
    expect(parseBearerToken(`Basic ${secret}`)).toBeNull();
    expect(parseBearerToken("Bearer malformed")).toBeNull();
  });
});
