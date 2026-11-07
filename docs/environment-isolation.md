# Preview and production isolation

RecruitmentOS uses Vercel's built-in Preview and Production environments. A paid custom environment is not needed for this separation. Creating and linking the `recruitmentos` project does not deploy the application.

CVs are stored in private Vercel Blob (DEC-01, resolved by the owner on 7 November 2026): one private store per environment, reached only with the request's Vercel OIDC token. Downloads are verified against the SHA-256 recorded at completion ([blob-security-design.md](blob-security-design.md)). The S3 path is a dormant legacy option and is not used for Preview or Production ([s3-setup.md](s3-setup.md)).

## Proposed resources

| Environment | Neon                                                   | Vercel Blob                                                                     | Credentials and origin                                                                            |
| ----------- | ------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Preview     | Separate, empty free-plan project/database for testing | Separate private Preview store, connected to the project for Preview only       | Preview-only runtime role, auth secret, first-admin setup configuration and stable preview origin |
| Production  | Separate free-plan project/database                    | Separate private Production store, connected to the project for Production only | Production-only runtime role, auth secret, first-admin setup configuration and production origin  |

Two stores do not guarantee zero cost. The owner upgraded Vercel to Pro; keep the sum of the store-wide budgets in each database's `storage_ledger.budgets` below the account's remaining Blob allowance ([neon-database-runbook.md](neon-database-runbook.md#change-the-store-wide-cv-storage-budgets)). Neon publishes current Free plan allowances per project; actual account and integration limits must be confirmed before creating resources.

Never create preview from a production branch containing candidate records. Neon integrations can create preview branches automatically; verify their source and either disable that behavior or configure it to use the empty preview project. Do not import real candidate records into preview for this test.

## Environment-specific server configuration

Set each value only for its matching Vercel environment; do not publish secrets or use `NEXT_PUBLIC_` for any of these values. Do not store owner/migration credentials in the application runtime.

| Variable                                         | Preview                                            | Production                                                   |
| ------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------ |
| `DATABASE_URL`                                   | Restricted runtime connection for preview database | Restricted runtime connection for production database        |
| `CV_STORAGE_PROVIDER`                            | Unset or `blob`                                    | Unset or `blob`                                              |
| `BLOB_STORE_ID`                                  | Preview store id (`store_…`)                       | Production store id (`store_…`)                              |
| `BLOB_READ_WRITE_TOKEN`                          | Must not be set; remove the value Vercel adds      | Must not be set; remove the value Vercel adds                |
| `BETTER_AUTH_URL`                                | Exact stable preview HTTPS origin                  | Exact production HTTPS origin                                |
| `BETTER_AUTH_SECRET`                             | Separate random server secret                      | Separate random server secret                                |
| `BOOTSTRAP_OWNER_EMAIL`, `BOOTSTRAP_SETUP_TOKEN` | Preview admin and a unique setup token             | Production admin and a different setup token                 |
| `RESEND_API_KEY`, `EMAIL_FROM`                   | Verified testing sender/provider configuration     | Verified production sender/provider configuration            |
| Optional OAuth IDs and secrets                   | Provider configuration and callbacks for preview   | Separate provider configuration and callbacks for production |

Use a separate migration-owner connection for each database, held by the operator outside the deployed application. Apply migrations independently; create a non-owner, non-BYPASSRLS runtime role for each database as described in [deployment.md](deployment.md). Test RLS with the actual runtime connection before importing any data.

The current authentication implementation accepts one exact origin per environment. Preview deployment URLs change across commits; select a stable branch-specific preview origin, set it as the preview `BETTER_AUTH_URL`, and use precisely that origin in the preview OAuth callback settings. Other generated preview URLs are not automatically trusted. Production must use its own exact origin.

Both Blob stores must be private and connected only to their own environment. The server refuses Blob while `BLOB_READ_WRITE_TOKEN` is present, and names the store explicitly from `BLOB_STORE_ID` on every call with the request's OIDC token; the separation of Preview and Production stores under OIDC still needs hosted verification. Team limits and store budgets are application limits, not hard Blob or billing caps: configure usage monitoring and spend alerts after confirming account options.

## Planned verification

1. Confirm project, service plans, account access, region, final names and any cost implications before provisioning resources or credentials.
2. Provision independent resources and apply migrations using each environment's own owner connection.
3. Configure the matching server-only environment values and connect each Blob store to its own environment, without displaying secret values.
4. Initialize and verify the first administrator independently in each environment; the setup authorization is not a substitute for email verification.
5. With fictional test data, check that users, records, tokens and CVs in one environment cannot access the other, then test upload/download, invitations and reset links.
6. Review the legacy import dry-run separately; no candidate data is imported automatically.

Official references: [Vercel environments](https://vercel.com/docs/deployments/environments), [Vercel environment variables](https://vercel.com/docs/environment-variables), [Neon Free plan](https://neon.com/docs/introduction/plans), [Neon preview branch management](https://neon.com/docs/guides/vercel-branch-cleanup), and [Vercel Blob](https://vercel.com/docs/vercel-blob).
