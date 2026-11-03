# Preview and production isolation

RecruitmentOS uses Vercel's built-in Preview and Production environments. A paid custom environment is not needed for this separation. Creating and linking the `recruitmentos` project does not deploy the application.

For the requested Vercel Blob testing option, **Blob CV storage is currently disabled**. Private Blob access alone does not establish the immutable version-pinned download guarantee used by the existing 10 MiB S3 flow. Do not create or connect Blob stores until an equivalent safe download design is implemented and verified. The S3 path remains available after its infrastructure is configured.

## Proposed resources

| Environment | Neon                                                   | Amazon S3                                     | Credentials and origin                                                                                       |
| ----------- | ------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Preview     | Separate, empty free-plan project/database for testing | Separate private, versioned preview bucket    | Preview-only runtime role, OIDC role, auth secret, first-admin setup configuration and stable preview origin |
| Production  | Separate free-plan project/database                    | Separate private, versioned production bucket | Production-only runtime role, OIDC role, auth secret, first-admin setup configuration and production origin  |

Choose globally unique bucket names and an AWS region only after checking the connected AWS account, free-tier eligibility and region pricing. Two buckets do not guarantee zero cost. Existing AWS account age, usage, object versions and requests affect eligibility and costs. Neon publishes current Free plan allowances per project; actual account and integration limits must be confirmed before creating resources.

Never create preview from a production branch containing candidate records. Neon integrations can create preview branches automatically; verify their source and either disable that behavior or configure it to use the empty preview project. Do not import real candidate records into preview for this test.

## Environment-specific server configuration

Set each value only for its matching Vercel environment; do not publish secrets or use `NEXT_PUBLIC_` for any of these values. Do not store owner/migration credentials in the application runtime.

| Variable                                         | Preview                                            | Production                                                   |
| ------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------ |
| `DATABASE_URL`                                   | Restricted runtime connection for preview database | Restricted runtime connection for production database        |
| `S3_BUCKET_NAME`                                 | Preview bucket                                     | Production bucket                                            |
| `AWS_REGION`                                     | Region of preview bucket                           | Region of production bucket                                  |
| `AWS_ROLE_ARN`                                   | Preview-only OIDC role and bucket permissions      | Production-only OIDC role and bucket permissions             |
| `BETTER_AUTH_URL`                                | Exact stable preview HTTPS origin                  | Exact production HTTPS origin                                |
| `BETTER_AUTH_SECRET`                             | Separate random server secret                      | Separate random server secret                                |
| `BOOTSTRAP_OWNER_EMAIL`, `BOOTSTRAP_SETUP_TOKEN` | Preview admin and a unique setup token             | Production admin and a different setup token                 |
| `RESEND_API_KEY`, `EMAIL_FROM`                   | Verified testing sender/provider configuration     | Verified production sender/provider configuration            |
| Optional OAuth IDs and secrets                   | Provider configuration and callbacks for preview   | Separate provider configuration and callbacks for production |

Use a separate migration-owner connection for each database, held by the operator outside the deployed application. Apply migrations independently; create a non-owner, non-BYPASSRLS runtime role for each database as described in [deployment.md](deployment.md). Test RLS with the actual runtime connection before importing any data.

The current authentication implementation accepts one exact origin per environment. Preview deployment URLs change across commits; select a stable branch-specific preview origin, set it as the preview `BETTER_AUTH_URL`, and use precisely that origin in the preview S3 CORS and OAuth callback settings. Other generated preview URLs are not automatically trusted. Production must use its own exact origin and CORS configuration.

Both S3 buckets require public-access blocking, versioning, narrowly scoped IAM and independent Vercel OIDC trust. The trust policy must match the specific Vercel account, project and environment; a production-only template cannot be reused unchanged for Preview. Do not set a blanket expiry on noncurrent versions because ready CV records can reference them. Database quotas are not hard AWS billing caps: configure appropriate monitoring and budget alerts after confirming account options.

## Planned verification

1. Confirm project, service plans, account access, region, final names and any cost implications before provisioning resources or credentials.
2. Provision independent resources and apply migrations using each environment's own owner connection.
3. Configure the matching server-only environment values and S3 CORS/OIDC policies without displaying secret values.
4. Initialize and verify the first administrator independently in each environment; the setup authorization is not a substitute for email verification.
5. With fictional test data, check that users, records, tokens and CVs in one environment cannot access the other, then test upload/download, invitations and reset links.
6. Review the legacy import dry-run separately; no candidate data is imported automatically.

Official references: [Vercel environments](https://vercel.com/docs/deployments/environments), [Vercel environment variables](https://vercel.com/docs/environment-variables), [Neon Free plan](https://neon.com/docs/introduction/plans), [Neon preview branch management](https://neon.com/docs/guides/vercel-branch-cleanup), and [AWS Free Tier](https://aws.amazon.com/free/).
