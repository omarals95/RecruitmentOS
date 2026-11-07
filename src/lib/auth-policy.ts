import { ApiError } from "./errors";

export function canRegisterEmail(
  email: string,
  policy: {
    publicSignup: boolean;
    hasPendingInvitation: boolean;
  },
): boolean {
  const normalized = email.trim().toLowerCase();
  return (
    normalized.length > 0 &&
    (policy.publicSignup || policy.hasPendingInvitation)
  );
}

export function requireVerifiedIdentity<
  T extends { user: { emailVerified: boolean } },
>(value: T | null): T {
  if (!value)
    throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
  if (!value.user.emailVerified)
    throw new ApiError(
      403,
      "EMAIL_UNVERIFIED",
      "Verify your email before accessing this workspace.",
    );
  return value;
}

export function validateInvitationRole(
  role: string,
): "owner" | "admin" | "recruiter" | "viewer" {
  if (
    role !== "owner" &&
    role !== "admin" &&
    role !== "recruiter" &&
    role !== "viewer"
  )
    throw new ApiError(400, "INVALID_ROLE", "Choose a supported team role.");
  return role;
}

/** Only the initial administrator and owners of an existing team may create a team. */
export function canCreateTeam(
  user: { emailVerified: boolean; initialAdmin?: boolean | null },
  roles: readonly string[],
): boolean {
  return (
    user.emailVerified === true &&
    (user.initialAdmin === true || roles.includes("owner"))
  );
}

export function isUsableAuthSecret(secret?: string): boolean {
  return Boolean(
    secret &&
    secret.length >= 32 &&
    !/\s/.test(secret) &&
    !/^(.)\1+$/.test(secret) &&
    !/(replace[-_ ]?with|change[-_ ]?me|your[-_ ]?(?:auth[-_ ]?)?secret|example[-_ ]?secret|placeholder)/i.test(
      secret,
    ),
  );
}

export async function boundedAuthRequest(request: Request): Promise<Request> {
  if (!request.body) return request;
  const limit = 65_536;
  if (Number(request.headers.get("content-length")) > limit)
    throw new ApiError(
      413,
      "BODY_TOO_LARGE",
      "Authentication request is too large.",
    );
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ApiError(
          413,
          "BODY_TOO_LARGE",
          "Authentication request is too large.",
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // Next.js wraps Request in a proxy; native Request(Request) reads inaccessible private state.
  return new Request(request.url, {
    method: request.method,
    headers: new Headers(request.headers),
    body,
  });
}
