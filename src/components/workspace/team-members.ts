"use client";

import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { humanError } from "./client";

export interface TeamMember {
  userId: string;
  name: string;
}

/**
 * The current team's members by name, from Better Auth, as the History tab names them. Shared by the
 * directory and the team task screens.
 */
export function useTeamMembers(teamId: string | null, enabled: boolean) {
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!teamId || !enabled) return;
    let active = true;
    authClient.organization
      .getFullOrganization({ query: { organizationId: teamId } })
      .then((result) => {
        if (result.error)
          throw new Error(
            result.error.message || "The team's members could not be loaded.",
          );
        const list = (result.data?.members ?? []) as {
          userId: string;
          user: { name: string };
        }[];
        if (active)
          setMembers(
            list.map((item) => ({ userId: item.userId, name: item.user.name })),
          );
      })
      .catch((e) => {
        if (active) setError(humanError(e));
      });
    return () => {
      active = false;
    };
  }, [teamId, enabled]);
  return { members, error };
}
