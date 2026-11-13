"use client";

import { useId, useState, useSyncExternalStore } from "react";
import { appVersion } from "@/lib/app-version";
import type { BuildInfo } from "@/lib/build-info";
import type { DomainAddress } from "@/lib/domain-settings";
import { useApi, useWorkspace } from "@/components/workspace/client";

const LOCAL_HOSTS = ["localhost", "127.0.0.1"];
export const ADDRESS_CHECK_ERROR =
  "Enter a web address on https, such as https://recruitment.example.com. Only localhost and 127.0.0.1 may use http.";
/** The settings the deployment holds; the page names them and never reads or shows their values. */
export const DEPLOYMENT_SETTINGS = [
  ["Application address", "BETTER_AUTH_URL"],
  ["Resend key and sender", "RESEND_API_KEY, EMAIL_FROM"],
  ["Blob storage", "CV_STORAGE_PROVIDER, BLOB_STORE_ID"],
  ["Database", "DATABASE_URL, IDENTITY_DATABASE_URL"],
] as const;
export const IMPACT_ITEMS = [
  "DNS and the Vercel domain: the new address must point at this deployment.",
  "The Better Auth trusted origin: it follows BETTER_AUTH_URL, so sign-in accepts only the new address.",
  "OAuth and MCP redirect URIs, and the MCP server URL, which becomes the new address followed by /api/mcp: AI apps must reconnect.",
  "The Resend sending domain: emails keep coming from the domain verified in Resend.",
  "Links in emails already sent: they keep the old address.",
];

/**
 * The origin a typed address stands for, checked in the browser only: a bare host gets https://,
 * and only https, or http on localhost or 127.0.0.1, is accepted. Null for an empty entry.
 */
export function checkAddress(
  value: string,
): { origin: string } | { error: string } | null {
  const text = value.trim();
  if (!text) return null;
  // A scheme is a name and a colon not followed by a port number.
  const withScheme =
    text.includes("://") || /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text)
      ? text
      : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: ADDRESS_CHECK_ERROR };
  }
  const allowed =
    url.protocol === "https:" ||
    (url.protocol === "http:" && LOCAL_HOSTS.includes(url.hostname));
  return allowed && url.origin !== "null"
    ? { origin: url.origin }
    : { error: ADDRESS_CHECK_ERROR };
}

/** Vercel for a Production or Preview build, otherwise an env file (self-hosted mode is not built). */
export function deploymentMode(environment: string) {
  return environment === "Production" || environment === "Preview"
    ? { vercel: true, label: `Vercel, ${environment}` }
    : { vercel: false, label: "Local development (env file)" };
}

/** The origin the browser opened the page at; never sent to the server. */
export const currentOrigin = () => window.location.origin;

/** Company owners only: the route refuses everyone else, and the page table hides it from them. */
export function DomainTab() {
  const { team } = useWorkspace();
  const result = useApi<{ data: { address: DomainAddress } }>(
    team ? "/api/v1/admin/domain" : null,
  );
  // Read in the browser only (null on the server): the server never sees it or the Host header.
  const browserOrigin = useSyncExternalStore(
    () => () => {},
    currentOrigin,
    () => null,
  );
  const [entry, setEntry] = useState("");
  return (
    <DomainPanel
      address={result.data?.data.address ?? null}
      error={result.error}
      build={appVersion()}
      browserOrigin={browserOrigin}
      entry={entry}
      onEntry={setEntry}
    />
  );
}

export function DomainPanel({
  address,
  error,
  build,
  browserOrigin,
  entry,
  onEntry = () => {},
}: {
  address: DomainAddress | null;
  error: string;
  build: Pick<BuildInfo, "version" | "build" | "commit" | "environment">;
  /** window.location.origin in the browser, null on the server. */
  browserOrigin: string | null;
  entry: string;
  onEntry?: (value: string) => void;
}) {
  const mode = deploymentMode(build.environment);
  const local =
    !!address?.origin &&
    !address.https &&
    LOCAL_HOSTS.includes(new URL(address.origin).hostname);
  const passed = (ok: boolean) => (ok ? "Passed" : "Failed");
  return (
    <>
      {error ? (
        <p className="notice error" role="alert">
          Could not load the web address. {error}
        </p>
      ) : !address ? (
        <p role="status">Loading the web address…</p>
      ) : !address.origin ? (
        <p className="notice" role="status">
          The application address (BETTER_AUTH_URL) is not set or not a valid
          web address. Sign-in, emails and AI connections need it; set it in the
          deployment.
        </p>
      ) : (
        browserOrigin !== null &&
        browserOrigin !== address.origin && (
          <p className="notice" role="status">
            You opened this page at {browserOrigin}, but the web address set in
            the deployment is {address.origin}. Links, emails and AI connections
            use {address.origin}.
          </p>
        )
      )}
      <section className="panel stack">
        <h2>Current address</h2>
        <p className="muted">
          The web address set in the deployment. Links in emails, sign-in and AI
          connections always use it, never the address a request came in on.
        </p>
        {/* The record screens' phone layout: one labelled card per row at 720 px and below. */}
        {address && (
          <div className="records-panel">
            <div className="table-wrap">
              <table className="data-table">
                <caption className="sr-only">
                  The web address and its checks
                </caption>
                <thead>
                  <tr>
                    <th>Check</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td data-label="Check">Web address</td>
                    <td data-label="Result">
                      {address.origin ?? "Not set or not a valid web address"}
                    </td>
                  </tr>
                  <tr>
                    <td data-label="Check">Uses https</td>
                    <td data-label="Result">{passed(address.https)}</td>
                  </tr>
                  <tr>
                    <td data-label="Check">No trailing slash or path</td>
                    <td data-label="Result">{passed(address.originOnly)}</td>
                  </tr>
                  <tr>
                    <td data-label="Check">Sign-in accepts it</td>
                    <td data-label="Result">
                      {!address.valid
                        ? "No"
                        : local
                          ? "Yes, allowed for local development only"
                          : "Yes"}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
      <section className="panel stack">
        <h2>Deployment</h2>
        <div className="records-panel">
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">This deployment</caption>
              <thead>
                <tr>
                  <th>Fact</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td data-label="Fact">Deployment mode</td>
                  <td data-label="Value">{mode.label}</td>
                </tr>
                <tr>
                  <td data-label="Fact">Version</td>
                  <td data-label="Value">{build.version}</td>
                </tr>
                <tr>
                  <td data-label="Fact">Build</td>
                  <td data-label="Value">{build.build}</td>
                </tr>
                <tr>
                  <td data-label="Fact">Commit</td>
                  <td data-label="Value">{build.commit}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>
      <section className="panel stack">
        <h2>Set in deployment</h2>
        <p className="muted">
          These settings live in the deployment, not in the app. Nothing on this
          page shows or changes their values.
        </p>
        <div className="records-panel">
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">
                Settings set in the deployment
              </caption>
              <thead>
                <tr>
                  <th>Setting</th>
                  <th>Variables</th>
                  <th>Where</th>
                </tr>
              </thead>
              <tbody>
                {DEPLOYMENT_SETTINGS.map(([setting, variables]) => (
                  <tr key={setting}>
                    <td data-label="Setting">{setting}</td>
                    <td data-label="Variables">{variables}</td>
                    <td data-label="Where">Set in deployment</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
      <AddressCheck build={build} entry={entry} onEntry={onEntry} />
      <section className="panel stack">
        <h2>How to change the address</h2>
        {mode.vercel ? (
          <ol>
            <li>Add the domain to the Vercel project and to your DNS.</li>
            <li>
              Set BETTER_AUTH_URL to the new https address in the project&apos;s
              environment variables.
            </li>
            <li>Redeploy.</li>
          </ol>
        ) : (
          <ol>
            <li>Set BETTER_AUTH_URL to the new address in the env file.</li>
            <li>Restart the app.</li>
          </ol>
        )}
        <p className="muted">
          The app records the change the next time a company owner opens this
          page.
        </p>
      </section>
      <section className="panel stack">
        <h2>What a new address affects</h2>
        <ul>
          {IMPACT_ITEMS.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>
    </>
  );
}

/** The browser opens the link; this page makes no request to the entered address. */
function AddressCheck({
  build,
  entry,
  onEntry,
}: {
  build: Pick<BuildInfo, "build" | "commit">;
  entry: string;
  onEntry: (value: string) => void;
}) {
  const help = useId();
  const outcome = useId();
  const result = checkAddress(entry);
  const failed = result !== null && "error" in result;
  return (
    <section className="panel stack">
      <h2>Check an address</h2>
      <p className="muted" id={help}>
        Optional. Enter a new address to open its version page in a new tab. The
        address serves this deployment when the build and commit shown there are{" "}
        {build.build} and {build.commit}.
      </p>
      <label className="field">
        <span>New address</span>
        <input
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={entry}
          onChange={(event) => onEntry(event.target.value)}
          aria-describedby={result ? `${help} ${outcome}` : help}
          aria-invalid={failed || undefined}
          placeholder="recruitment.example.com"
        />
      </label>
      {result &&
        ("error" in result ? (
          <p id={outcome} className="field-error">
            {result.error}
          </p>
        ) : (
          <p id={outcome}>
            <a
              href={`${result.origin}/api/version`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open {result.origin}/api/version
            </a>{" "}
            (opens in a new tab)
          </p>
        ))}
    </section>
  );
}
