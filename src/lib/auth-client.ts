"use client";

import { createAuthClient } from "better-auth/react";
import {
  organizationClient,
  twoFactorClient,
} from "better-auth/client/plugins";
import { ac, roles } from "./auth-roles";

export const authClient = createAuthClient({
  // No twoFactorPage: the sign-in form navigates to the code screen itself.
  plugins: [organizationClient({ ac, roles }), twoFactorClient()],
});
