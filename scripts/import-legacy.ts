import { mkdir, lstat, realpath, writeFile, rename } from "node:fs/promises";
import {
  resolve,
  dirname,
  extname,
  relative,
  isAbsolute,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { loadLegacy, safeResolve } from "./legacy/files";
import { applyPlan, ImportError, type ApplyResult } from "./legacy/apply";

export async function main(args = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      root: { type: "string" },
      "app-dir": { type: "string", default: "Recruiter Dashboard" },
      apply: { type: "boolean", default: false },
      api: { type: "string" },
      team: { type: "string" },
      report: { type: "string", default: ".local/migration-report.json" },
      "update-existing": { type: "boolean", default: false },
      "upload-attempt": { type: "string", default: "1" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      'Usage: npm run import:legacy -- --root "C:\\path\\Resume" [--app-dir "Recruiter Dashboard"] [--report .local/migration-report.json]\nApply: add --apply --api https://your-app.vercel.app --team TEAM_ID; set API_TOKEN in your environment.\nOptional: --update-existing explicitly overwrites matching legacy records/private state; --upload-attempt 2 starts a fresh rejected/expired upload reservation.',
    );
    return 0;
  }
  if (!values.root)
    throw new Error(
      "--root is required. Select the legacy Resume directory explicitly.",
    );
  if (values["update-existing"] && !values.apply)
    throw new Error("--update-existing requires --apply.");
  const attempt = Number(values["upload-attempt"]);
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 1000)
    throw new Error("--upload-attempt must be an integer from 1 to 1000.");
  if (values.apply && (!values.api || !values.team || !process.env.API_TOKEN))
    throw new Error(
      "--apply requires --api, --team and API_TOKEN in the environment.",
    );
  const reportPath = resolve(values.report);
  if (extname(reportPath).toLowerCase() !== ".json")
    throw new Error("--report must use a .json filename.");
  // Reports contain personal data: constrain them to the repository's gitignored .local directory.
  const privateRoot = resolve(".local"),
    reportRelative = relative(privateRoot, reportPath);
  if (
    isAbsolute(reportRelative) ||
    reportRelative === ".." ||
    reportRelative.startsWith(`..${sep}`)
  )
    throw new Error(
      "--report must stay inside the gitignored .local directory.",
    );
  await safeResolve(process.cwd(), relative(process.cwd(), reportPath));
  await mkdir(dirname(reportPath), { recursive: true });
  let check = dirname(reportPath);
  while (check !== dirname(privateRoot)) {
    const info = await lstat(check);
    if (info.isSymbolicLink())
      throw new Error("Report directories cannot be links or junctions.");
    if (check === privateRoot) break;
    check = dirname(check);
  }
  try {
    if ((await lstat(reportPath)).isSymbolicLink())
      throw new Error("Report file cannot be a link.");
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error;
  }
  const plan = await loadLegacy(values.root, values["app-dir"]);
  const counts = {
    ...plan.stats,
    errors: plan.issues.filter((v) => v.severity === "error").length,
    warnings: plan.issues.filter((v) => v.severity === "warning").length,
  };
  console.log(
    JSON.stringify(
      { mode: values.apply ? "apply" : "dry-run", counts },
      null,
      2,
    ),
  );
  let result: ApplyResult | undefined;
  let applyFailure: string | undefined;
  if (values.apply && counts.errors === 0) {
    try {
      result = await applyPlan(plan, {
        apiUrl: values.api!,
        teamId: values.team!,
        token: process.env.API_TOKEN!,
        updateExisting: values["update-existing"],
        uploadAttempt: attempt,
        onProgress: (message) => console.log(message),
      });
    } catch (error) {
      applyFailure =
        error instanceof ImportError
          ? `${error.code}: ${error.message}`
          : "Apply stopped during target preflight. Check the API URL, token scopes, live team membership and API availability; rerun safely after correcting them.";
    }
  }
  const output = {
    createdAt: new Date().toISOString(),
    mode: values.apply ? "apply" : "dry-run",
    counts,
    plan,
    result,
    applyFailure,
  };
  const temp = `${reportPath}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(output, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temp, reportPath);
  console.log(
    `Private report saved to ${await realpath(reportPath)}. Do not commit or share it publicly.`,
  );
  if (result)
    console.log(
      JSON.stringify(
        {
          created: result.created,
          updated: result.updated,
          skipped: result.skipped,
          statesImported: result.statesImported,
          notificationsImported: result.notificationsImported,
          notificationsUnchangedOrStale: result.notificationsUnchangedOrStale,
          uploadsReady: result.uploadsReady,
          uploadsSkipped: result.uploadsSkipped,
          conflicts: result.conflicts.length,
          errors: result.errors.length,
          missing: result.missing.length,
          reconciliation: result.reconciliation,
        },
        null,
        2,
      ),
    );
  return counts.errors ||
    applyFailure ||
    result?.conflicts.length ||
    result?.errors.length
    ? 1
    : 0;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(
        error instanceof Error ? error.message : "Migration failed.",
      );
      process.exitCode = 1;
    });
