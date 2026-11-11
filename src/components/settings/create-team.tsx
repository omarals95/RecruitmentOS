"use client";

import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { requestJson, useWorkspace } from "@/components/workspace/client";

/** Turns a Better Auth client error into a thrown Error with its plain message. */
export function ensure(result: { error?: { message?: string } | null }) {
  if (result.error)
    throw new Error(
      result.error.message || "The action could not be completed.",
    );
}
function slugFor(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70);
}
const BOOTSTRAP_FAILED =
  "Your team was created, but default task buckets could not be prepared. Open Admin portal > Teams > the team > Settings and use “Prepare task board” to retry.";

/**
 * Create a team, on Admin > Teams and in Team & access: only when canCreateTeam allows it, through
 * Better Auth's organization create, so allowUserToCreateOrganization and app.map_new_team() apply.
 */
export function CreateTeam({
  busy,
  onAction,
  onBootstrapFailed,
}: {
  busy: string;
  onAction: (
    key: string,
    work: () => Promise<void>,
    message: string,
  ) => Promise<void>;
  /** The team was created and selected, but its task buckets were not: show the message, reload. */
  onBootstrapFailed: (message: string) => Promise<void>;
}) {
  const { canCreateTeam } = useWorkspace();
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  async function createTeam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onAction(
      "create",
      async () => {
        const created = await authClient.organization.create({
          name: newName.trim(),
          slug: newSlug.trim(),
        });
        ensure(created);
        if (!created.data?.id)
          throw new Error(
            "The team response was incomplete. Refresh your teams before trying again.",
          );
        const selected = await authClient.organization.setActive({
          organizationId: created.data.id,
        });
        ensure(selected);
        // Bootstrap is idempotent. If it fails, retain the created team and give a retry path.
        try {
          await requestJson(created.data.id, "/api/v1/teams/bootstrap", {
            method: "POST",
          });
        } catch {
          await onBootstrapFailed(BOOTSTRAP_FAILED);
          return;
        }
        window.location.assign("/app");
      },
      "Team created.",
    );
  }
  if (!canCreateTeam) return null;
  return (
    <section className="panel">
      <h2>
        <Plus
          size={20}
          aria-hidden="true"
          style={{ verticalAlign: "middle" }}
        />{" "}
        Create a team
      </h2>
      <p className="muted">
        A separate team has its own candidate records, CVs, workflow and tokens.
        You can create up to five teams.
      </p>
      <form className="stack" onSubmit={createTeam}>
        <div className="form-grid">
          <label className="field">
            <span>Team name</span>
            <input
              required
              maxLength={100}
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value);
                if (!slugEdited) setNewSlug(slugFor(e.target.value));
              }}
              placeholder="e.g. Talent acquisition"
            />
          </label>
          <label className="field">
            <span>Team identifier</span>
            <input
              required
              minLength={2}
              maxLength={70}
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              value={newSlug}
              onChange={(e) => {
                setNewSlug(e.target.value);
                setSlugEdited(true);
              }}
              placeholder="talent-acquisition"
            />
            <small className="muted">
              Lowercase letters, numbers and hyphens.
            </small>
          </label>
        </div>
        <div>
          <button type="submit" className="button" disabled={!!busy}>
            {busy === "create" ? "Creating team…" : "Create team"}
          </button>
        </div>
      </form>
    </section>
  );
}
