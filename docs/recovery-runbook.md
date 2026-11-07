# Recovery runbook: failed migrations, rollback and restore

This runbook covers what to do when a migration fails, when a release has to be rolled back, and how to restore the database into an isolated copy. Only the owner or orchestrator runs these steps against a hosted database. Agents never run them against Neon, Vercel or Blob.

## Scope and status

- What exists is a **local PGlite rehearsal only**. The tests listed under [Local rehearsal](#local-rehearsal) prove what the application keeps across an upgrade and a restore of fictional data.
- These are **unknown and blocked**: the Neon backup or point-in-time restore (PITR) configuration, Blob object backup, how long a hosted restore takes, and the D-12 recovery targets.
- The SRS proposes a recovery point objective (RPO) of at most 24 hours and a recovery time objective (RTO) of at most 8 hours. Neither figure is approved. Do not quote them as commitments until D-12 is decided.
- A provider backup feature on its own does not prove recovery (BRD NFR-07). Only a timed restore into an isolated database, checked as described below, does.

## Before a release

1. Record the application revision you are about to deploy and the current contents of the `public.recruitment_migrations` ledger on the target database (`SELECT name, applied_at FROM public.recruitment_migrations ORDER BY name`).
2. Compare the ledger with the ordered files under `drizzle/` in that revision. Every file not yet in the ledger will run.
3. Take a backup the owner has configured for that database (a Neon backup or branch point), and write down its identifier and time. If no backup is configured, stop: the release is not recoverable.

## Failed migration

- `npm run db:migrate` applies each `drizzle/NNNN*.sql` file inside its own `DO` block, guarded by the ledger. A file either applies completely and adds its ledger row, or fails and leaves nothing behind. Files applied before the failing one stay applied.
- The ledger therefore shows exactly the last file that applied. The failing file has no row, and none of its tables, columns or data changes exist.
- When a migration fails:
  1. Stop. Do not rerun blindly and do not deploy the new code.
  2. Inspect the ledger and the actual schema. The command prints only a generic line, so reproduce the failure against a restored copy or a local database if the cause is unclear.
  3. Fix forward with a **new** migration file. Never edit a file that is already in any ledger, and never delete ledger rows: the next run would apply that file again on top of its earlier result.
  4. Rerun `npm run db:migrate` for a local database. For a hosted database, rerun the migration using the procedure in [neon-database-runbook.md](neon-database-runbook.md#run-the-migration-against-a-neon-database). Files already in the ledger are skipped, and the run continues from the first unapplied file.
- `tests/migration-upgrade.test.ts` rehearses this: a fictional failing file leaves no ledger row and no partial table, the existing data is unchanged, and the run continues once the file is removed.

## Release rollback

- Migrations are forward-only. There are no down migrations and no automatic rollback.
- Redeploy the previous release only if its code accepts the current schema. Check the files the new release added: a release whose code expects tables or columns that a later migration renamed or removed must not be redeployed.
- `assertStorageSchema` refuses to start the application when the database's storage-schema version differs from the one the code expects. An incompatible release then stays unavailable. It does not start and reinterpret CV references.
- If no compatible earlier release exists, fix forward with a new release, or restore the database into an isolated copy as described below and decide with the owner.

## Restore into an isolated database

1. Restore into a **new** database or Neon branch. Never restore over the live database.
2. Rerun the role template and the evidence script against the restored database, as in [neon-database-runbook.md](neon-database-runbook.md) §3: `infrastructure/postgres-split-runtime-roles.sql` as the migration owner, then `scripts/db-role-evidence.ts` with the restored copy's runtime connections. Role grants and passwords are not proof of anything until the evidence passes on the copy.
3. The restored copy keeps its source's `db_boundary.connection_marker` and its Preview approval mark (the comment on schema `db_boundary`).
   - A copy of Preview carries the mark. Remove it with `COMMENT ON SCHEMA db_boundary IS NULL;` as the copy's migration owner, unless the owner approves that copy as the Preview database.
   - Check that `SELECT obj_description('db_boundary'::regnamespace, 'pg_namespace');` returns NULL on any copy that may become Production. See [neon-database-runbook.md](neon-database-runbook.md) §3 item 4.
4. Reconcile CV references against Blob objects: every `ready` row in `app.uploads` must name an object that exists with the recorded size and checksum. This is **blocked** until Blob object backup exists. The local rehearsal keeps objects in memory and proves only that the reference and the object key survive a database restore.
5. Check the copy before any traffic: the ledger, the storage-schema check at startup, a fictional sign-in, and the sessions and tokens step below.

## Sessions and tokens after a restore

- A restore to a point **before** a sign-out, session revocation or token revocation brings that session or token back. `tests/backup-restore.test.ts` shows this with a dump taken before a revocation.
- Revocations made before the backup stay revoked after the restore. The same test shows that too.
- The post-restore policy is an **open owner decision**. It is not implemented, and no script for it exists.
- Proposal: before traffic resumes on a restored database, delete every `auth.session` and `auth.verification` row (everyone signs in again, and pending email links stop working), and set `revoked_at` on every row in `auth.api_tokens`, which covers API tokens and OAuth grants (every integration must be reconnected).

## Two-step sign-in recovery

Two-step sign-in (job 034) is required for owners and admins. When someone loses their authenticator:

1. **Backup codes first.** On **Enter your sign-in code**, choose **Use a backup code instead** and enter one of the 10 codes saved at setup; each works once. Once signed in, **Turn off** and **Turn on** again in My profile moves to a new authenticator, and **Create new backup codes** replaces the codes.
2. **Another owner resets them.** An owner who owns every team the member belongs to opens **Team & access** and chooses **Reset two-step sign-in** on that member's row. This removes the member's authenticator key and backup codes, signs them out everywhere and forgets their trusted devices; they set it up again at their next sign-in. It writes one `two_step.reset` row in that team's Activity. An owner cannot reset themselves here, and a member who also belongs to a team that owner does not own is refused (409 `member_in_other_team`); they use a backup code or step 3.
3. **The last owner, by the database owner only.** When the only owner has neither the authenticator nor a backup code, the RecruitmentOS owner runs, from a trusted machine with the owner (migration) connection of the affected database and never a runtime connection:

   ```
   MIGRATION_DATABASE_URL=<owner connection> npm run two-step:reset -- --email <address> --confirm
   ```

   It refuses without `--confirm`, connects with `sslmode=verify-full`, and in one owner transaction removes the account's authenticator key and backup codes, turns two-step sign-in off, deletes its sessions, trusted devices and pending challenges, and writes one `two_step.reset` Activity row per team of the account ("Two-step sign-in reset by the database owner", method `owner-script`). It prints "Two-step sign-in was reset for 1 account." or "No account matched." (exit 1), and never a secret. Verify the person's identity out of band first. The account must set up two-step sign-in again at its next sign-in. Locally (`DATABASE_MODE=pglite` and `ALLOW_LOCAL_DB=true`) the same command acts on the fictional PGlite database.

## Local rehearsal

Run these in a checkout under Node 24. They use fictional data, PGlite and fake storage only, and contact no remote service.

```
npx vitest run tests/migration-upgrade.test.ts tests/backup-restore.test.ts tests/legacy-import.test.ts tests/live-role-preview-mark.test.ts tests/db-scripts-exit.test.ts
```

- `tests/migration-upgrade.test.ts`: a populated fictional database at `0006` upgrades through every later file. The ledger lists every file, and records, parents, private owners, audit rows, private state, the offer amount, the CV identity and privacy through the application are unchanged. The failed-migration case is described [above](#failed-migration).
- `tests/backup-restore.test.ts`: a PGlite `dumpDataDir()` dump opened with `loadDataDir` keeps the ledger, records, audit rows, private state and CV reference. It passes the storage-schema check, keeps team and private boundaries, and keeps a revoked token and session revoked. A dump taken before a revocation brings the revoked token and session back.
- `tests/legacy-import.test.ts`: changed-plan reconciliation, `missing` records and balanced totals for the legacy importer (see [migration.md](migration.md#reconciliation-counts)).
- `tests/live-role-preview-mark.test.ts`: the live role harness refuses a database without the exact Preview approval mark, and only the schema owner can set it.
- `tests/db-scripts-exit.test.ts`: `npm run db:migrate`, `npm run db:seed` and `npm run two-step:reset` close the local database and exit on their own.
