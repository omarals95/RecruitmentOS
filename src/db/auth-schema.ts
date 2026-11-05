import {
  boolean,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  bigint,
  index,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const authSchema = pgSchema("auth");
const date = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });
const id = () =>
  text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()::text`);

export const user = authSchema.table(
  "user",
  {
    id: id(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    initialAdmin: boolean("initial_admin").notNull().default(false),
    image: text("image"),
    createdAt: date("created_at").notNull().defaultNow(),
    updatedAt: date("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("auth_user_email_unique").on(t.email)],
);

export const organization = authSchema.table(
  "organization",
  {
    id: id(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    logo: text("logo"),
    metadata: text("metadata"),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "restrict",
    }),
    createdAt: date("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("auth_organization_slug_unique").on(t.slug),
    index("auth_organization_creator_idx").on(t.createdBy),
  ],
);

export const session = authSchema.table(
  "session",
  {
    id: id(),
    expiresAt: date("expires_at").notNull(),
    token: text("token").notNull(),
    createdAt: date("created_at").notNull().defaultNow(),
    updatedAt: date("updated_at").notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activeOrganizationId: text("active_organization_id"),
  },
  (t) => [
    uniqueIndex("auth_session_token_unique").on(t.token),
    index("auth_session_user_idx").on(t.userId),
  ],
);

export const account = authSchema.table(
  "account",
  {
    id: id(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: date("access_token_expires_at"),
    refreshTokenExpiresAt: date("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: date("created_at").notNull().defaultNow(),
    updatedAt: date("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("auth_account_user_idx").on(t.userId),
    uniqueIndex("auth_account_provider_identity_unique").on(
      t.providerId,
      t.accountId,
    ),
  ],
);

export const verification = authSchema.table(
  "verification",
  {
    id: id(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: date("expires_at").notNull(),
    createdAt: date("created_at").notNull().defaultNow(),
    updatedAt: date("updated_at").notNull().defaultNow(),
  },
  (t) => [index("auth_verification_identifier_idx").on(t.identifier)],
);

export const member = authSchema.table(
  "member",
  {
    id: id(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("viewer"),
    createdAt: date("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("auth_member_organization_user_unique").on(
      t.organizationId,
      t.userId,
    ),
    index("auth_member_user_idx").on(t.userId),
  ],
);

export const invitation = authSchema.table(
  "invitation",
  {
    id: id(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull().default("pending"),
    expiresAt: date("expires_at").notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: date("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("auth_invitation_email_idx").on(t.email),
    index("auth_invitation_organization_idx").on(t.organizationId),
  ],
);

export const rateLimit = authSchema.table(
  "rate_limit",
  {
    id: id(),
    key: text("key").notNull(),
    count: integer("count").notNull(),
    lastRequest: bigint("last_request", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("auth_rate_limit_key_unique").on(t.key)],
);

export const oauthClients = authSchema.table("oauth_clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
  createdAt: date("created_at").notNull().defaultNow(),
});

export const apiTokens = authSchema.table(
  "api_tokens",
  {
    id: id(),
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    prefix: text("prefix").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    expiresAt: date("expires_at").notNull(),
    revokedAt: date("revoked_at"),
    lastUsedAt: date("last_used_at"),
    createdAt: date("created_at").notNull().defaultNow(),
    oauthClientId: text("oauth_client_id").references(() => oauthClients.id),
  },
  (t) => [
    uniqueIndex("auth_api_tokens_hash_unique").on(t.tokenHash),
    index("auth_api_tokens_team_user_idx").on(t.teamId, t.userId),
  ],
);

export const oauthCodes = authSchema.table(
  "oauth_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    grantId: text("grant_id")
      .notNull()
      .references(() => apiTokens.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    expiresAt: date("expires_at").notNull(),
    usedAt: date("used_at"),
    createdAt: date("created_at").notNull().defaultNow(),
  },
  (t) => [index("auth_oauth_codes_grant_idx").on(t.grantId)],
);

export const oauthTokens = authSchema.table(
  "oauth_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    grantId: text("grant_id")
      .notNull()
      .references(() => apiTokens.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"access" | "refresh">().notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    audience: text("audience").notNull(),
    expiresAt: date("expires_at").notNull(),
    usedAt: date("used_at"),
    createdAt: date("created_at").notNull().defaultNow(),
  },
  (t) => [index("auth_oauth_tokens_grant_idx").on(t.grantId)],
);

export const apiRateLimits = authSchema.table("api_rate_limits", {
  key: text("key").primaryKey(),
  windowStart: date("window_start").notNull(),
  count: integer("count").notNull(),
});

export const initialAdminClaim = authSchema.table("initial_admin_claim", {
  id: boolean("id").primaryKey().default(true),
  claimedAt: date("claimed_at").notNull().defaultNow(),
  userId: text("user_id"),
  completedAt: date("completed_at"),
});

export const authTables = {
  user,
  session,
  account,
  verification,
  organization,
  member,
  invitation,
  rateLimit,
  apiTokens,
  apiRateLimits,
};
