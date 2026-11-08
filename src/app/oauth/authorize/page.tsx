import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { OAuthConsent } from "@/components/auth/oauth-consent";
import { getAuthOptions } from "@/lib/auth";
import { canCreateTeam, twoStepSetupRequired } from "@/lib/auth-policy";
import { getSession } from "@/lib/auth-session";
import { checkAuthorizeRequest, consentTeams } from "@/lib/oauth";

function Card({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <main className="auth-shell">
      <div className="auth-card">
        <Link href="/" className="auth-brand">
          <span aria-hidden="true">
            <ShieldCheck size={24} />
          </span>
          RecruitmentOS
        </Link>
        <header className="auth-header">
          <p className="eyebrow">CONNECT AN APP</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </header>
        {children}
      </div>
    </main>
  );
}

/** OAuth consent: nothing is granted until a verified team member approves here. */
export default async function Authorize({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  if (!getAuthOptions().configured)
    return (
      <Card
        title="Connect an app"
        description="Sign-in is needed before an app can be connected."
      >
        <div className="auth-notice" role="status">
          <strong>Setup required</strong>
          <p>
            Your administrator needs to configure the database, authentication
            secret, app URL, and email delivery before sign-in is available.
          </p>
        </div>
      </Card>
    );
  const check = await checkAuthorizeRequest(params);
  if (check.kind === "fatal")
    return (
      <Card title="This connection cannot continue" description={check.message}>
        <p className="muted">
          Error code: <code>{check.error}</code>
        </p>
        <Link className="button secondary" href="/app">
          Go to your workspace
        </Link>
      </Card>
    );
  const identity = await getSession(await headers());
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    for (const item of [value].flat())
      if (item !== undefined) query.append(key, item);
  const here = encodeURIComponent(`/oauth/authorize?${query}`);
  if (!identity) redirect(`/sign-in?next=${here}`);
  if (!identity.user.emailVerified) redirect("/verify-email");
  const teams = await consentTeams(identity.user.id);
  const { request } = check;
  if (!teams.length)
    return canCreateTeam(
      identity.user,
      teams.map((team) => team.role),
    ) ? (
      <Card
        title="Create or join a team first"
        description={`${request.client.name} can only be connected to a team you belong to.`}
      >
        <Link className="button" href="/app/settings/team">
          Create or join a team
        </Link>
      </Card>
    ) : (
      <Card
        title="Join a team first"
        description={`${request.client.name} can only be connected to a team you belong to. Accept the email invitation from your team owner, then try again.`}
      >
        <Link className="button secondary" href="/app">
          Go to your workspace
        </Link>
      </Card>
    );
  if (!identity.user.twoFactorEnabled) {
    // Owners and admins set it up before anything else; anyone else needs it to connect an app.
    if (
      twoStepSetupRequired(
        false,
        teams.map((team) => team.role),
      )
    )
      redirect(`/two-step-setup?next=${here}`);
    return (
      <Card
        title="Turn on two-step sign-in first"
        description={`${request.client.name} can only be connected from an account that uses two-step sign-in.`}
      >
        <p>
          Two-step sign-in asks for a code from your authenticator app when you
          sign in. Turn it on, then you return here to review the connection.
        </p>
        <Link className="button" href={`/two-step-setup?next=${here}`}>
          Turn on two-step sign-in
        </Link>
      </Card>
    );
  }
  const active =
    teams.find((team) => team.id === identity.session.activeOrganizationId) ??
    teams[0];
  return (
    <Card
      title="Connect an app"
      description="Review exactly what this app can do before you approve it."
    >
      <OAuthConsent
        client={{
          name: request.client.name,
          redirectHost: request.redirectHost,
        }}
        teams={teams}
        defaultTeamId={active.id}
        requested={request.scopes}
        params={request.params}
      />
    </Card>
  );
}
