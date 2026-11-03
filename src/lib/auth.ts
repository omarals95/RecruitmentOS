import { betterAuth } from "better-auth";
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
  tryGetCurrentAuthEndpointContext,
} from "@better-auth/core/context";
import { and, eq } from "drizzle-orm";
import { getDb, type AppDb } from "@/db";
import { authTables, member } from "@/db/auth-schema";
import { ApiError } from "./errors";
import { ac, roles } from "./auth-roles";
import {
  canRegisterEmail,
  isUsableAuthSecret,
  validateInvitationRole,
} from "./auth-policy";
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
  let validURL = false;
  try {
    const url = new URL(process.env.BETTER_AUTH_URL ?? "");
    validURL =
      url.origin === url.href.replace(/\/$/, "") &&
      (url.protocol === "https:" ||
        (process.env.NODE_ENV !== "production" &&
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname)));
  } catch {
    /* Public pages remain available before setup. */
  }
  const database =
    Boolean(process.env.DATABASE_URL) ||
    (process.env.NODE_ENV !== "production" &&
      process.env.DATABASE_MODE === "pglite" &&
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
    advanced: { database: { generateId: "uuid" } },
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
      storage: "database",
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
          ].includes(ctx.path)
        ) {
          const body = ctx.body as {
            role?: unknown;
            organizationId?: string;
            memberId?: string;
          };
          const role = validateRole(
            typeof body?.role === "string" ? body.role : "",
          );
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
          const target = body.memberId
            ? (
                await db
                  .select()
                  .from(member)
                  .where(
                    and(
                      eq(member.id, body.memberId),
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
  instance ??= getDb()
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
