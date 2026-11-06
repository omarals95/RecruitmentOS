# Import the desktop recruitment workspace

The importer transfers the existing Excel-backed dashboard into a RecruitmentOS team. It is a one-way migration; Excel does not remain a second live database. The original workbooks, CVs and SQLite database are never edited. Run this script on the computer that holds the complete legacy folder, using Node 24 and this repository's installed dependencies.

No real candidate data is bundled with this project or used by its tests. Nothing is imported merely by deploying to Vercel.

## Prepare the source and destination

1. Make a private backup of the entire old Resume folder, including the old dashboard subfolder and recovered attachments. Keep a separate backup of the destination database before updating an existing team.
2. Save and close Excel. Stop the old dashboard cleanly so its SQLite state has no active WAL or rollback journal. Do not delete database sidecars to force an import.
3. Deploy/configure RecruitmentOS, including its database, verified sign-in and private versioned S3 bucket. Test those connections with fictional records first.
4. Create the destination team with an owner or administrator account. Prefer a new, empty team. Do **not** initialize its sample workflow/default buckets before migration: a bucket with the same name but a different identity creates a visible conflict rather than being silently merged.
5. Retain stable Candidate IDs, Source IDs, task IDs and all other source IDs. Two different candidates must not share a Candidate ID. Do not rename IDs to avoid a validation message: they preserve notes and relationships.

A Source ID identifies an immutable document version. Give a replacement CV its own new source row/Source ID and link it to the existing Candidate ID. Do not replace bytes behind a previously imported Source ID: a ready upload is reused when its identity and metadata match. File Inventory SHA-256 values are checked when local bytes are uploaded; a reused ready upload does not re-download S3 content for another comparison.

Expected source layout:

```text
Resume/
  Resume_Master.xlsx
  Recruitment_Tasks.xlsx
  Recruitment_Vacancies.xlsx
  Recruitment_Operations.xlsx
  Finance/...
  Other category folders/...
  Recruiter Dashboard/
    recruiter-state.sqlite3
    recovered.json
    Recovered Resumes/...
```

`Resume_Master.xlsx` is required. Missing optional operations, vacancies or tasks workbooks are reported with zero records for those resources. The master needs `Master` and `File Inventory`; `Review Log` and `Field Evidence` are imported when present. Headers may appear below title/metadata rows. If the old dashboard subfolder has another name, pass its path relative to the selected root with `--app-dir "Recruiter Dashboard"`.

## First run: reconcile locally

From the RecruitmentOS repository directory in PowerShell:

```powershell
npm run import:legacy -- --root "C:\Users\YourName\Desktop\Resume"
```

This is a **dry-run**. It reads the four named workbooks, the recovery mapping and a temporary read-only copy of SQLite. It checks referenced source-file paths, sizes and timestamps. It does **not** read CV bytes, contact the application, call AI services or upload anything.

The terminal prints counts without candidate details. The full private report is written to `.local/migration-report.json`, including source rows, issues, personal notes and provenance. This directory is gitignored; reports must stay within it. Treat the report like the original recruitment records. Never attach it to a public issue, commit it, or share it with people who should not see personal notes.

Use a different private report name to retain each reconciliation:

```powershell
npm run import:legacy -- --root "C:\Users\YourName\Desktop\Resume" --report .local/before-import.json
```

Review every error before applying. Errors block the entire apply operation before any API writes. Warnings remain visible and can allow a partial document migration: for example, a missing CV does not remove the candidate's factual record. Compare `candidateRecords`, `sourceRows`, `linkedVersions`, `uploadableSources`, `missingSources`, private state and each resource count. Multiple versions and duplicate files mean source-file counts can exceed the number of people.

The importer reads only files referenced by the master inventory/recovery mapping; it does not turn unlisted files into guessed candidate records. Reconcile any CVs missing from File Inventory in the legacy workspace first.

## Apply explicitly

Create a short-lived API token as the verified owner/administrator of the destination team. Select all the scopes used by the importer:

```text
candidates:read  candidates:write
recruitment:read recruitment:write
cvs:read cvs:write imports:write
```

Keep the token out of command arguments, scripts, screenshots and the report. PowerShell can prompt without putting its value into command history:

```powershell
$migrationToken = Read-Host "Migration API token" -AsSecureString
$migrationCredential = [pscredential]::new('migration', $migrationToken)
$env:API_TOKEN = $migrationCredential.GetNetworkCredential().Password
try {
  npm run import:legacy -- --root "C:\Users\YourName\Desktop\Resume" --apply --api https://your-app.vercel.app --team YOUR_TEAM_ID --report .local/applied-import.json
} finally {
  Remove-Item Env:\API_TOKEN -ErrorAction SilentlyContinue
  $migrationCredential = $null
  $migrationToken = $null
}
```

The API argument must be a clean HTTPS origin, without credentials, a path, query or fragment. HTTP is accepted only for local development at `localhost`, `127.0.0.1` or `[::1]`. Copy the exact team ID from the team settings/API examples; a token is restricted to its team and live role.

Applying first enumerates target records, then creates records in dependency order. Legacy IDs map to new server-generated UUIDs. The script stays below the API token's 60 requests/minute limit, so a large directory can take a substantial time. Keep the computer awake and do not change source files during the run.

CV bytes are read only in apply mode and only beneath the explicitly selected source root. The API issues a short-lived upload ticket tagged with its protocol, and the importer follows that tag, never the hostname: an `s3-form-v1` form POST to an HTTPS AWS S3 endpoint, or a `blob-put-v1` PUT to exactly `https://vercel.com/api/blob/` (Blob storage is currently disabled). Any other protocol is reported as `UNSUPPORTED_UPLOAD_PROTOCOL` and no bytes are sent. The RecruitmentOS API token is sent only to the chosen application origin. The server validates the stored bytes and pins an S3 version or a Blob SHA-256 before a CV becomes ready.

## What is preserved

| Source                                              | Destination behavior                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Master facts, original/extra columns                | Typed candidate fields plus lossless `rawSource`; missing facts remain empty/null                                                                                                                                                                                     |
| Folder categories                                   | All semicolon-separated folder-derived tags; no independent hiring-fit assessment                                                                                                                                                                                     |
| Experience                                          | CV-stated numeric years and documented estimate kept separately; original wording, basis and as-of metadata retained                                                                                                                                                  |
| Evidence, reviews, File Inventory                   | Candidate evidence/reviews and import provenance, including original source links and resolved relative paths                                                                                                                                                         |
| Multiple CV versions                                | Separate linked sources; identical physical paths for the same candidate reuse one uploaded file and keep aliases in the report                                                                                                                                       |
| SQLite shortlist/status/note                        | Personal state of the importing token's user; never converted to a team-visible candidate note                                                                                                                                                                        |
| Original personal note whitespace                   | Original text retained in private state metadata if the new note field normalizes whitespace                                                                                                                                                                          |
| Buckets, custom fields, tasks                       | Bucket Status names mapped to bucket IDs; custom values re-keyed to the new field IDs, including archived definitions                                                                                                                                                 |
| System vacancy task field                           | Converted to a real vacancy reference rather than a visible custom field                                                                                                                                                                                              |
| Candidate text on tasks                             | Remains context; a candidate link is created only from an explicit `Candidate ID:` line or exact known legacy ID                                                                                                                                                      |
| Roles/vacancies, applications and linked operations | IDs, facts, status values, ownership labels and relationship graph retained                                                                                                                                                                                           |
| Comments                                            | Historical author label retained; the current importer remains the real authenticated actor                                                                                                                                                                           |
| Legacy timestamps/activity                          | Original rows stored as import metadata; new server-created timestamps/audits reflect the migration itself                                                                                                                                                            |
| Source review status                                | Mapped to one of the two review values: "Verified", "Reviewed", "Complete" or "Completed" (any case, surrounding spaces ignored) become `Reviewed`; anything else, including a blank or unknown value, becomes `Needs review`. The original text stays in `rawSource` |
| Saved views                                         | Supported filters mapped; a non-empty review status filter is mapped the same way as the candidate value; unsupported query fields retained as provenance with a warning                                                                                              |
| Notification reads                                  | Recognized unchanged reminder keys remapped for the importing user; interview keys use their exact start instant. The server marks genuine current reminders only. Original read timestamps remain in the private report; new `readAt` is the actual import time      |

Legacy stage changes are **not** inserted as newly observed history. Consequently, historical funnel/conversion analytics cannot be recreated from the migration timestamps. Owner/recruiter labels are preserved as text; the importer does not guess which new account corresponds to a name.

Actual CV formats supported: PDF, DOC, DOCX, JPG, JPEG, PNG, JFIF and PAGES, up to 10MiB each. MSG, XLSX and XLSB supporting sources remain provenance and are reported as not uploaded. A file linked to multiple candidates is flagged and not uploaded until its ownership is resolved. Candidates are retained even when their CV cannot be uploaded. Format validation is not a malware scan.

## Conflicts, resuming and verification

Rerun the same command after a network interruption. Deterministic idempotency keys, legacy-ID uniqueness and existing-target reconciliation prevent duplicate record creation. Ready uploads are reused; pending reservations can receive a fresh ticket. A retry does not require an entirely new token unless the old one expired or was revoked.

Existing rows are skipped when their imported data and provenance match. Different existing rows become conflicts: the default preserves corrections made in RecruitmentOS. Comments are append-only; conflicting immutable relationships require manual review even when updates are requested.

`notificationsImported` counts read markers actually created by the server; `notificationsUnchangedOrStale` counts markers already read, outside the current reminder set, or incompatible with the new key. It does not claim that every legacy read marker became an active cloud reminder. A rescheduled interview keeps its new reminder unread. Unsupported original keys remain in the private report.

Only after reviewing the report and backing up the destination, add `--update-existing` if you deliberately want source values to overwrite matching legacy records and your own personal state. This flag does not remove records absent from the source. It does not merge differently identified buckets/candidates or bypass optimistic version checks.

### Reconciliation counts

After an apply the summary also prints `missing` and a `reconciliation` block. Each planned item gets exactly one outcome, so in every category `planned` equals the sum of the other counts:

- `records`: `planned` (records in this plan) = `created` + `updated` + `skipped` + `conflicts` + `failed`. `missing` is reported beside them and is not part of that sum.
- `states` (private shortlist/status/note): `planned` = `imported` + `unchanged` + `conflicts` + `failed`.
- `files` (CV sources): `planned` = `ready` + `skipped` (not uploadable, or the same physical file as another source of that candidate) + `failed`.

`missing` counts target records that carry a legacy ID but are no longer in this plan, for example a row deleted from a workbook after an earlier import. The private report lists them as `resource:legacyId` keys. The importer never deletes, archives or changes a missing record, with or without `--update-existing`, and a missing record does not change the exit code. Decide about each one in RecruitmentOS yourself.

When the source changes after an earlier import (a changed plan):

1. Rerun the dry run on the changed source and resolve every error.
2. Back up the destination, then apply without `--update-existing`. Records you did not change are skipped and new ones are created. Changed ones become conflicts, so corrections made in RecruitmentOS are kept.
3. Review every conflict and every `missing` key in the private report.
4. Only if the source values should replace the target's on purpose, apply again with `--update-existing`. The conflicts then become `updated`; `missing` records stay as they are.

If a CV reservation is expired or rejected, resolve the reported file/format issue, rerun reconciliation, then use `--upload-attempt 2` to request a new stable upload-attempt ID. Increase this number only when starting another replacement attempt. The source ID still identifies the same logical CV; no arbitrary upload URL is accepted.

After an apply, inspect its private report:

- Reconcile created/updated/skipped counts against the input counts and review every conflict/error.
- Compare candidate IDs, categories, evidence, experience facts and CV version links on a representative sample, including reviewed/ambiguous records.
- Check private notes while signed in as the importer and confirm another team member cannot see them.
- Check tasks, custom values, archived items, role/vacancy links and an application through interview/offer/onboarding/checklist.
- Open several imported CVs and confirm filename/version associations. Resolve all missing/unsupported documents before treating the document migration as complete.
- Re-run the same source without `--update-existing`; unchanged records should be skipped. Revoke the migration token when finished.

Writes across PostgreSQL, HTTP and S3 are not one global transaction. An error can leave earlier records successfully imported. The report records ID mappings and partial progress. There is no automatic destructive rollback: use your database/S3 backup for a full restore, or review the created IDs and archive records in reverse dependency order. Do not delete source originals or blindly delete a destination team that already contains live recruiting work.

The loader rejects traversal, drive-qualified/UNC paths, imported URLs, symbolic links/junctions, unsupported/oversized XLSX ZIP archives and changing files. It refuses a live SQLite WAL/journal instead of dropping pending notes. Keep the selected source folder private and stable during import; concurrent hostile filesystem modification is outside this migration workflow.

Automated verification uses fictional workbooks, SQLite and CV bytes only. No live Neon/S3/Vercel deployment, production token or real-candidate migration has been exercised while building this project. On Windows sandboxes that prohibit creating synthetic junctions, that one junction test is explicitly skipped; lexical path-boundary tests still run.
