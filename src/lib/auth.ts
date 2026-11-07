import { betterAuth, type AuthContext } from "better-auth";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  APIError,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { organization as organizationPlugin } from "better-auth/plugins";
import {
  getCurrentAdapter,
  runWithTransaction,
  tryGetCurrentAuthEndpointContext,
} from "@better-auth/core/context";
import type { BetterAuthRateLimitStorage } from "@better-auth/core";
import { and, eq, sql } from "drizzle-orm";
import { getIdentityDb, prepareDbPairTargets, type AppDb } from "@/db";
import { authTables, member, rateLimit, user } from "@/db/auth-schema";
import { purgeExpiredAuthRowsThrottled } from "./auth-purge";
import { ApiError } from "./errors";
import { ac, roles } from "./auth-roles";
import {
  canRegisterEmail,
  isUsableAuthSecret,
  validateInvitationRole,
} from "./auth-policy";
import { clientIpHeader, keyedRateLimitHash } from "./client-ip";
import { dispatchAuthMail, mailConfigured, type MailDelivery } from "./mail";

export type AuthOptions = {
  configured: boolean;
  google: boolean;
  microsoft: boolean;
  emailPassword: true;
  publicSignup: boolean;
  bootstrapConfigured: boolean;
};
export function getAuthOptions(): AuthOptions {
  const hosted =
    process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
  let validURL = false;
  try {
    const url = new URL(process.env.BETTER_AUTH_URL ?? "");
    validURL =
      url.origin === url.href.replace(/\/$/, "") &&
      (url.protocol === "https:" ||
        (!hosted &&
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname)));
  } catch {
    /* Public pages remain available before setup. */
  }
  let database = false;
  if (hosted) {
    try {
      // The same refusals createDbPair applies before any pool; connection-time checks still run at first use.
      prepareDbPairTargets();
      // Hosted sign-in runs only in the Vercel production runtime.
      database =
        process.env.NODE_ENV === "production" && process.env.VERCEL === "1";
    } catch {
      /* Report setup required without revealing which setting was refused. */
    }
  } else
    database =
      Boolean(process.env.DATABASE_URL) ||
      (process.env.DATABASE_MODE === "pglite" &&
        process.env.ALLOW_LOCAL_DB === "true");
  return {
    configured: Boolean(
      validURL &&
      database &&
      isUsableAuthSecret(process.env.BETTER_AUTH_SECRET) &&
      mailConfigured(),
    ),
    google: Boolean(
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
    ),
    microsoft: Boolean(
      process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET,
    ),
    emailPassword: true,
    publicSignup: process.env.ALLOW_PUBLIC_SIGNUP === "true",
    bootstrapConfigured: Boolean(
      process.env.BOOTSTRAP_OWNER_EMAIL?.trim() &&
      usableBootstrapToken(process.env.BOOTSTRAP_SETUP_TOKEN),
    ),
  };
}

type FactoryConfig = {
  baseURL: string;
  secret: string;
  publicSignup: boolean;
  bootstrapOwnerEmail?: string;
  bootstrapSetupToken?: string;
  deliver?: MailDelivery;
  google?: { clientId: string; clientSecret: string };
  microsoft?: { clientId: string; clientSecret: string; tenantId?: string };
};

/**
 * Better Auth's database limiter semantics in one atomic upsert on auth.rate_limit, but its
 * `<ip>|<path>` key is stored only as a keyed hash. Allowed while count < max within the window
 * since the last allowed request; a passed window restarts at 1. A refusal leaves the window as it
 * is (the count is capped at max + 1 to mark it) and reports the seconds until the window frees.
 */
function hashedRateLimitStorage(
  db: AppDb,
  secret: string,
): BetterAuthRateLimitStorage {
  return {
    async consume(key, rule) {
      const now = Date.now();
      const windowMs = rule.window * 1000;
      const passed = sql`${now}::bigint - ${rateLimit.lastRequest} >= ${windowMs}::bigint`;
      const [row] = await db
        .insert(rateLimit)
        .values({
          key: `ba:${keyedRateLimitHash(key, secret)}`,
          count: 1,
          lastRequest: now,
        })
        .onConflictDoUpdate({
          target: rateLimit.key,
          set: {
            count: sql`CASE WHEN ${passed} THEN 1 ELSE LEAST(${rateLimit.count} + 1, ${rule.max + 1}::int) END`,
            lastRequest: sql`CASE WHEN ${passed} OR ${rateLimit.count} < ${rule.max}::int THEN ${now}::bigint ELSE ${rateLimit.lastRequest} END`,
          },
        })
        .returning({
          count: rateLimit.count,
          lastRequest: rateLimit.lastRequest,
        });
      await purgeExpiredAuthRowsThrottled(db);
      if (row.count <= rule.max) return { allowed: true, retryAfter: null };
      return {
        allowed: false,
        retryAfter: Math.ceil((row.lastRequest + windowMs - now) / 1000),
      };
    },
  };
}

export function createAuth(db: AppDb, config: FactoryConfig) {
  const mail = (to: string, subject: string, text: string) =>
    dispatchAuthMail({ to, subject, text }, config.deliver);
  const plugin = organizationPlugin({
    ac,
    roles,
    creatorRole: "owner",
    organizationLimit: async (user) => {
      const ctx = tryGetCurrentAuthEndpointContext();
      if (!ctx) return true;
      const adapter = await getCurrentAdapter(ctx.context.adapter);
      return (
        (await adapter.count({
          model: "organization",
          where: [{ field: "createdBy", value: user.id }],
        })) >= 5
      );
    },
    requireEmailVerificationOnInvitation: true,
    schema: {
      organization: {
        additionalFields: {
          createdBy: { type: "string", required: false, input: false },
        },
      },
    },
    allowUserToCreateOrganization: (user) => user.emailVerified,
    sendInvitationEmail: async (data) => {
      await mail(
        data.email,
        `Invitation to ${data.organization.name} on RecruitmentOS`,
        `You have been invited to join ${data.organization.name}. Sign in using this email address, verify it, and accept the invitation:\n${config.baseURL}/accept-invitation?id=${encodeURIComponent(data.id)}\nThis invitation expires in 48 hours.`,
      );
    },
    organizationHooks: {
      beforeCreateOrganization: async ({ organization: draft, user }) => {
        if (!user.emailVerified)
          throw new APIError("FORBIDDEN", {
            message: "Verify your email before creating a team.",
          });
        return { data: { ...draft, createdBy: user.id } };
      },
      beforeCreateInvitation: async ({ invitation: draft }) => {
        validateRole(draft.role);
      },
      beforeAddMember: async ({ member: draft }) => {
        validateRole(draft.role);
      },
      beforeUpdateMemberRole: async ({ newRole }) => {
        validateRole(newRole);
      },
      beforeAcceptInvitation: async ({ invitation: invite, user }) => {
        if (
          !user.emailVerified ||
          user.email.toLowerCase() !== invite.email.toLowerCase()
        )
          throw new APIError("FORBIDDEN", {
            message: "Use the verified email address on this invitation.",
          });
        validateRole(invite.role ?? "");
      },
    },
  });
  // The plugin writes the team, its owner and the active team separately; commit them together.
  const createOrganization = plugin.endpoints.createOrganization;
  plugin.endpoints.createOrganization = Object.assign(
    (input: Parameters<typeof createOrganization>[0] & { context: object }) =>
      runWithTransaction((input.context as AuthContext).adapter, () =>
        createOrganization(input),
      ),
    { path: createOrganization.path, options: createOrganization.options },
  ) as unknown as typeof createOrganization;
  return betterAuth({
    appName: "RecruitmentOS",
    baseURL: config.baseURL,
    secret: config.secret,
    logger: {
      level: "error",
      log: () => {
        console.error("An authentication operation failed.");
      },
    },
    trustedOrigins: [config.baseURL],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: authTables,
      transaction: true,
    }),
    advanced: {
      database: { generateId: "uuid" },
      // Better Auth skips callback and redirect origin checks when NODE_ENV=test or TEST is set; keep them on everywhere.
      disableOriginCheck: false,
      // Auth rate limits and session addresses use the same single client-IP header as the API.
      ipAddress: { ipAddressHeaders: [clientIpHeader()] },
    },
    user: {
      deleteUser: { enabled: false },
      changeEmail: { enabled: false },
      additionalFields: {
        initialAdmin: {
          type: "boolean",
          input: false,
          required: false,
          defaultValue: false,
        },
      },
    },
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: false,
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      freshAge: 60 * 15,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      customStorage: hashedRateLimitStorage(db, config.secret),
      window: 60,
      max: 100,
      customRules: {
        "/sign-up/email": { window: 60, max: 5 },
        "/sign-in/email": { window: 60, max: 10 },
        "/request-password-reset": { window: 60, max: 3 },
        "/send-verification-email": { window: 60, max: 3 },
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await mail(
          user.email,
          "Reset your RecruitmentOS password",
          `Reset your password using this link:\n${url}\nIf you did not request this, ignore this email.`,
        );
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }) => {
        await mail(
          user.email,
          "Verify your RecruitmentOS email",
          `Verify your email address using this link:\n${url}\nOnly verify an account that you requested.`,
        );
      },
    },
    socialProviders: {
      ...(config.google
        ? { google: { ...config.google, requireEmailVerification: true } }
        : {}),
      // Microsoft does not attest email ownership. Require a local verification before any private action.
      ...(config.microsoft
        ? {
            microsoft: {
              ...config.microsoft,
              tenantId: config.microsoft.tenantId ?? "common",
              mapProfileToUser: () => ({ emailVerified: false, image: "" }),
            },
          }
        : {}),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            if (!ctx)
              throw new APIError("FORBIDDEN", {
                message:
                  "Registration requires an authenticated application request.",
              });
            const adapter = await getCurrentAdapter(ctx.context.adapter);
            const pending = await adapter.findMany({
              model: "invitation",
              where: [
                { field: "email", value: user.email.trim().toLowerCase() },
                { field: "status", value: "pending" },
                { field: "expiresAt", operator: "gt", value: new Date() },
              ],
              limit: 1,
            });
            const normalizedEmail = user.email.trim().toLowerCase();
            const bootstrapEmail = config.bootstrapOwnerEmail
              ?.trim()
              .toLowerCase();
            const initialAdmin = Boolean(
              bootstrapEmail &&
              normalizedEmail === bootstrapEmail &&
              ctx.path === "/sign-up/email" &&
              bootstrapTokenMatches(
                config.bootstrapSetupToken,
                ctx.request?.headers.get("x-bootstrap-token"),
              ),
            );
            if (initialAdmin)
              return {
                data: { ...user, email: normalizedEmail, initialAdmin: true },
              };
            // Initial setup must be explicitly claimed before public registration can begin.
            if (
              (await adapter.count({ model: "user" })) === 0 &&
              (await adapter.count({ model: "organization" })) === 0
            )
              throw new APIError("FORBIDDEN", {
                message: "Initial administrator setup is required.",
              });
            if (
              !canRegisterEmail(user.email, {
                publicSignup: config.publicSignup,
                hasPendingInvitation: pending.length > 0,
              })
            )
              throw new APIError("FORBIDDEN", {
                message:
                  "Registration is by invitation. Ask your team administrator for an invitation.",
              });
            return {
              data: { ...user, email: user.email.trim().toLowerCase() },
            };
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (
          ctx.request &&
          !["GET", "HEAD"].includes(ctx.request.method) &&
          !ctx.path.startsWith("/callback/")
        ) {
          if (
            ctx.request.headers.get("origin") !== new URL(config.baseURL).origin
          )
            throw new APIError("FORBIDDEN", {
              message:
                "Authentication requests must come from this application.",
            });
        }
        if (!ctx.path.startsWith("/organization/")) return;
        const identity = await getAuthoritativeSessionFromCtx(ctx);
        if (!identity?.user.emailVerified)
          throw new APIError("FORBIDDEN", {
            message: "Sign in with a verified email to manage teams.",
          });
        if (ctx.path === "/organization/add-member")
          throw new APIError("FORBIDDEN", {
            message: "Invite people using their email address.",
          });
        if (
          [
            "/organization/invite-member",
            "/organization/update-member-role",
            "/organization/remove-member",
          ].includes(ctx.path)
        ) {
          const body = ctx.body as {
            role?: unknown;
            organizationId?: string;
            memberId?: unknown;
            memberIdOrEmail?: unknown;
          };
          const role =
            ctx.path === "/organization/remove-member"
              ? undefined
              : validateRole(typeof body?.role === "string" ? body.role : "");
          const organizationId =
            body?.organizationId ?? identity.session.activeOrganizationId;
          if (!organizationId)
            throw new APIError("BAD_REQUEST", { message: "Select a team." });
          const actor = (
            await db
              .select()
              .from(member)
              .where(
                and(
                  eq(member.organizationId, organizationId),
                  eq(member.userId, identity.user.id),
                ),
              )
              .limit(1)
          )[0];
          // Removal names the member by id or email; resolve both so an owner cannot be removed by a non-owner.
          const targetKey = body?.memberId ?? body?.memberIdOrEmail;
          const target =
            typeof targetKey === "string"
              ? (
                  await db
                    .select({ role: member.role })
                    .from(member)
                    .innerJoin(user, eq(user.id, member.userId))
                    .where(
                      and(
                        targetKey.includes("@")
                          ? eq(user.email, targetKey.trim().toLowerCase())
                          : eq(member.id, targetKey),
                        eq(member.organizationId, organizationId),
                      ),
                    )
                    .limit(1)
                )[0]
              : undefined;
          if (
            (role === "owner" || target?.role === "owner") &&
            actor?.role !== "owner"
          )
            throw new APIError("FORBIDDEN", {
              message: "Only a team owner can change ownership.",
            });
        }
      }),
    },
    plugins: [plugin],
  });
}

function validateRole(role: string) {
  try {
    return validateInvitationRole(role);
  } catch {
    throw new APIError("BAD_REQUEST", {
      message: "Choose owner, admin, recruiter, or viewer.",
    });
  }
}

export type AppAuth = ReturnType<typeof createAuth>;
let instance: Promise<AppAuth> | undefined;
export async function getAuth(): Promise<AppAuth> {
  if (!getAuthOptions().configured)
    throw new ApiError(
      503,
      "AUTH_NOT_CONFIGURED",
      "Sign-in is not configured. Ask your administrator to finish database, authentication, and email setup.",
    );
  instance ??= getIdentityDb()
    .then((db) =>
      createAuth(db, {
        baseURL: process.env.BETTER_AUTH_URL!.replace(/\/$/, ""),
        secret: process.env.BETTER_AUTH_SECRET!,
        publicSignup: process.env.ALLOW_PUBLIC_SIGNUP === "true",
        bootstrapOwnerEmail: process.env.BOOTSTRAP_OWNER_EMAIL,
        bootstrapSetupToken: process.env.BOOTSTRAP_SETUP_TOKEN,
        ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
          ? {
              google: {
                clientId: process.env.GOOGLE_CLIENT_ID,
                clientSecret: process.env.GOOGLE_CLIENT_SECRET,
              },
            }
          : {}),
        ...(process.env.MICROSOFT_CLIENT_ID &&
        process.env.MICROSOFT_CLIENT_SECRET
          ? {
              microsoft: {
                clientId: process.env.MICROSOFT_CLIENT_ID,
                clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
                tenantId: process.env.MICROSOFT_TENANT_ID,
              },
            }
          : {}),
      }),
    )
    .catch((error) => {
      instance = undefined;
      throw error;
    });
  return instance;
}

export { getSession, getVerifiedSession } from "./auth-session";

export function usableBootstrapToken(token?: string): boolean {
  return Boolean(
    token && /^[A-Za-z0-9_-]{43,128}$/.test(token) && isUsableAuthSecret(token),
  );
}
function bootstrapTokenMatches(
  expected?: string,
  supplied?: string | null,
): boolean {
  if (!usableBootstrapToken(expected) || !supplied || supplied.length > 128)
    return false;
  const digest = (value: string) =>
    createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(expected!), digest(supplied));
}
