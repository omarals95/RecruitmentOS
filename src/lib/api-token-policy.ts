import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { SCOPES, roleScopes, type Role, type Scope } from "./permissions";

export const tokenInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    scopes: z
      .array(z.enum(SCOPES))
      .min(1)
      .max(SCOPES.length)
      .transform((scopes) => [...new Set(scopes)]),
    expiresInDays: z.number().int().min(1).max(365).default(30),
  })
  .strict();
export type TokenInput = z.input<typeof tokenInputSchema>;

export function hashToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createTokenMaterial() {
  const token = `ros_live_${randomBytes(32).toString("base64url")}`;
  return { token, tokenHash: hashToken(token), prefix: token.slice(0, 17) };
}

export function effectiveTokenScopes(
  scopes: readonly string[],
  role: string,
): Scope[] {
  if (!["owner", "admin", "recruiter", "viewer"].includes(role)) return [];
  const allowed = roleScopes(role as Role);
  return [...new Set(scopes)].filter((scope): scope is Scope =>
    allowed.includes(scope as Scope),
  );
}

export function parseBearerToken(authorization: string | null): string | null {
  if (!authorization || !/^Bearer /i.test(authorization)) return null;
  const token = authorization.slice(7);
  return /^ros_live_[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
