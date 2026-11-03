# Private CV storage on AWS S3 and Vercel

No bucket or IAM role is created by building/running this repository. Configure the following only when deployment access has been granted. Keep preview/test storage separate from production. Choose an approved AWS/Neon/Vercel region before moving actual candidate data.

## Required bucket settings

Create a general-purpose private S3 bucket with **Block Public Access enabled**, **Object Ownership: Bucket owner enforced**, default SSE-S3 encryption and **Versioning: Enabled**. Do not suspend versioning. The server verifies versioning before issuing an upload ticket and refuses a completed object without a non-null VersionId. Do not configure public ACLs.

Use the JSON files in `infrastructure/` as templates, replacing every `REPLACE_*` value. They are examples to review, not automatic infrastructure provisioning:

- `aws-s3-role-policy.json`: application role permissions to verify bucket versioning and put/read CV objects/versions within `teams/*`. No bucket listing, delete, policy administration or unrelated file access.
- `aws-vercel-oidc-trust.json`: trust only the exact Vercel owner/project/production environment. Create the corresponding Vercel OIDC provider in IAM with the documented issuer/audience. Preview needs its own role and isolated bucket or prefix; do not broaden the production subject with `*`.
- `aws-s3-bucket-policy.json`: TLS and explicit SSE-S3 on object uploads. Combine with existing policies carefully rather than replacing unrelated organization controls.
- `aws-s3-cors.json`: exact deployed application origin(s), never `*`. Add a local test origin only to a dedicated test bucket when testing direct browser uploads. S3 CORS controls browser behavior, not authorization.
- `aws-s3-lifecycle.json`: only aborts abandoned multipart uploads. RecruitmentOS currently uses one-part POST uploads, so this is defensive housekeeping rather than CV retention.

**Do not apply a blanket noncurrent-version expiration rule or expire the `teams/` prefix.** A replayed upload ticket can create a newer version, while a CV record deliberately points to the earlier validated version. Deleting all noncurrent versions would destroy valid CV references. Object deletion/retention needs a database-aware maintenance process that protects every `ready` row's exact bucket/key/version. No automatic S3 object deletion job ships with this slice. Rejected/expired upload objects can remain until reviewed maintenance removes unreferenced versions.

## Environment settings

Set server-only variables in Vercel:

```dotenv
AWS_REGION=me-central-1
S3_BUCKET_NAME=your-private-cv-bucket
AWS_ROLE_ARN=arn:aws:iam::123456789012:role/recruitment-production
```

The example region is illustrative. The application uses the official synchronous `getVercelOidcTokenSync` request-context helper and AWS `fromWebToken` to obtain short-lived AWS credentials. Vercel OIDC must be enabled for the project/environment. This mode requires `VERCEL=1` and a fresh hosted request token; AWS STS verifies its signature and the IAM trust policy. Missing, malformed or expired tokens fail closed. No asynchronous CLI refresh, Vercel global credential/cache lookup, token-file fallback or local CLI execution is used. No AWS secret access key is required with this mode.

For an explicit local test environment only, omit `AWS_ROLE_ARN` and set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and, when temporary, `AWS_SESSION_TOKEN`. OIDC role mode intentionally does not work through local Vercel CLI credentials. The code supplies IAM values explicitly; it does not search shared AWS profiles or use the default credential chain. Never prefix credentials with `NEXT_PUBLIC_`, put them in git, send them in chat or expose them to browser code. `storageConfigured()` returns false without the required environment values, and private upload/download flows return setup errors. It does not verify cloud credentials until an authorized request is made.

## API workflow for AI clients and migration

Use an expiring team-scoped token with `cvs:write`, plus `imports:write` only when submitting legacy source metadata. Read/download needs `cvs:read`. User/team permissions remain live even after a token is created. Never send the RecruitmentOS bearer token to S3.

1. POST `/api/v1/candidates/{candidateId}/cvs/uploads` with JSON:

   ```json
   {
     "originalName": "example.pdf",
     "mimeType": "application/pdf",
     "sizeBytes": 12345,
     "clientUploadId": "e1e0c5d6-198a-47ba-9795-a982ba6b3d1f"
   }
   ```

   Importers may also provide `legacySourceId` and an original **relative** `sourcePath`. Neither is used to read local/server files. No arbitrary key, bucket, URL or absolute source path is accepted.

2. Response is `{data:CvDto,upload:{url,fields,expiresAt}}`. Build multipart FormData from **all** returned fields, then append the CV file last, and POST it directly to `upload.url`. Let the HTTP client generate multipart Content-Type/boundary. The POST policy fixes the server-generated key, MIME, SSE-S3 fields and exact declared length (maximum 10 MiB), expiring in at most five minutes.

3. POST `/api/v1/cvs/uploads/{data.id}/complete`. The server verifies actual S3 length/type and bounded format bytes using the exact VersionId saved from HEAD. A successful response is `{data:CvDto}` with `status:ready`. PDFs/images receive signature checks; binary Word requires OLE/WordDocument structure; DOCX/Pages archives have entry/size/expansion/path bounds and recognized document structure. DOCX macro packages are rejected. These are format checks, **not malware scanning**. Attachments remain untrusted documents.

4. GET `/api/v1/candidates/{candidateId}/cvs` returns `{data:CvDto[]}`. GET `/api/v1/cvs/{id}/download` returns `{url,expiresAt}` for a 60-second attachment download pinned to the validated version. A signed URL is a bearer capability; do not log/store/share it. Revoking a user/token cannot invalidate an already issued URL before its brief expiry.

Keep the same `clientUploadId` while retrying an uncertain initial request; changed metadata with that ID conflicts. Ready retries return `upload:null` and the existing CV record. A matching ready `legacySourceId` also returns that existing record; conflicting source details return 409. Completion is idempotent and does not double-charge quota. Terminal rejected/expired uploads require a new selection/upload; rejected imported sources remain for review rather than silently replacing a legacy source.

Team storage starts at 10 GiB / 10,000 CVs. Pending reservations count toward both limits, expire after an hour, and are released in bounded batches during later upload initialization (or on attempted completion). Expiry cleanup commits independently of a following failed reservation. Simultaneous reservations/completions lock the team quota row in a consistent order. Database quotas do not bound AWS cost caused by replaying a still-valid signed ticket: each replay may create another S3 version. Short ticket expiry, rate limits, AWS budgets and DB-aware orphan maintenance address that separate operational risk.

CV types accepted: PDF, DOC, DOCX, JPG/JPEG/JFIF, PNG, and ZIP-based Pages. Legacy directory-based Pages packages are not uploaded as a file. MSG/XLSX/XLSB are supporting source files rather than CVs; the migration report lists them as unuploaded sources. No outbound AI extraction call is made by the CV workflow.

## Verification before actual candidate migration

Run `npm run test:storage`, the SQL-backed CV tests and normal project checks first. They use fictional in-memory documents and fake storage, not AWS. After deployment access is provided, use a separate test bucket and Neon branch to verify: exact IAM/OIDC audience/subject, Block Public Access/versioning/SSE, browser CORS, rejected key/MIME/size modifications, immutable-version replay protection, quota retry/concurrency behavior, wrong-team 404s, attachment download and expiry. Hosted S3/Neon/OIDC behavior has not been exercised merely by a local build.

Official references: [Vercel AWS OIDC](https://vercel.com/docs/oidc/aws), [AWS presigned POST SDK](https://github.com/aws/aws-sdk-js-v3/blob/main/packages/s3-presigned-post/README.md), [S3 POST policies](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sigv4-HTTPPOSTConstructPolicy.html), [S3 signed URL security](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html), [S3 GetObject versions/response overrides](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html).
