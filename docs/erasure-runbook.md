# Candidate and employee erasure runbook

How a team owner handles a request to permanently erase a candidate's data (P1-21, owner decision DEC-08), how a company owner handles one for an employee of the company directory ([Erase an employee](#erase-an-employee), R2a-15), and how a company owner anonymises a person's user account ([Anonymise a user account](#anonymise-a-user-account), ADM-10). It describes what RecruitmentOS does and does not remove. It makes no claim that following it meets any law or regulation; the owner decides that.

## When to use it

Use permanent erasure only for data-protection requests under DEC-08, for example a candidate asking for their data to be deleted. For routine hiding, such as a candidate who withdrew or a duplicate you want out of the lists, archive the record instead: archiving keeps the history and can be undone, and it is never presented as erasure.

Only a team owner can erase, and only while signed in (the app or the owner-run script). Admins, recruiters, viewers, API tokens, OAuth grants and the MCP endpoint cannot.

## Before erasing

1. **Verify the requester** outside the app, through a channel you already trust (for example a reply to the email address the candidate applied with). The app does not verify identity for you.
2. **Find every matching record.** One person can have several candidate records, for example from a bulk CV import.
   - Search the candidate directory by name, by email and by phone number.
   - Open each match and check the possible-duplicates lookup in its editor.
   - Note each candidate id from the URL (`/app/candidates/<id>`). Erase each record separately.
3. **Check for a legal hold.** None is implemented in the app, so the owner decides whether any reason requires keeping the data, and records that decision outside the app.
4. **Search free text the app does not edit.** Erasure removes comments on the candidate and its applications, interviews, offers and onboarding, replaces the name in tasks linked to the candidate and clears saved-view searches that contain the email or phone, or the name as a whole word or phrase in any case (no letter or digit directly before or after it; names of at least 3 characters only, so a search for "Al" or "Annabel" stays when erasing "Al" or "Ann"). It does not edit:
   - comments on other records (vacancies, other candidates, tasks);
   - vacancy and job-role notes;
   - tasks that mention the candidate but are not linked to them.

   Search the workspace for the name, email and phone and edit those mentions by hand before or after erasing.

5. **List the exports.** Open Activity and filter or search for `records.exported` events since the candidate was created. Each shows who exported which list and when. Ask each of those people to delete their downloaded copies; the app cannot reach downloaded files.

## Erase in the app

1. Sign in as a team owner and select the candidate's team.
2. Open the candidate and choose **Full profile**.
3. Under the record details, find **Permanently erase candidate** and choose **Permanently erase candidate**.
4. Read what is removed, kept and not covered.
5. Type the candidate's name exactly as shown (case matters; spaces at either end are ignored). **Permanently erase** stays disabled until it matches.
6. Choose **Permanently erase**. The page shows "Candidate permanently erased." and, when the candidate had CV files, whether they were deleted from storage or when the next CV storage cleanup can delete them.
7. Record the erasure in the owner's request log (below). The erasure id is in the response of `POST /api/v1/candidates/{id}/erasure` and in the script output; the Activity row "Permanently erased a candidate" shows the time.

A second erasure of the same candidate is safe: it returns the earlier erasure (`alreadyErased: true`) and repeats the CV deletion.

**Files of file fields (R2b-06).** The files stored in file fields of the erased records (the candidate, its applications, interviews, offers, onboarding, checklist items and the comments on any of them) are removed with them: each `app.record_files` row becomes rejected, nameless and unlinked from its record, and its Blob object is deleted, confirmed missing and its charge released by the same cleanup as CV files. The counts show them as `recordFiles`, next to `cvFiles`, and `cvStorage` (deleted, waiting, deleteAfter) counts CV files and record files together. Files on tasks linked to the candidate stay, as the tasks do.

## Erase with the script

For requests received outside the app, or when the owner prefers a terminal:

```bash
npm run erase:candidate -- --team <team id or slug> --candidate <candidate id> --owner <owner email> --confirm-name "<candidate name>"
```

- **Environment.** It needs the same runtime database URLs (`DATABASE_URL`, `IDENTITY_DATABASE_URL`) and the same `TENANT_CONTEXT_SIGNING_KEY` as the deployment it targets. Set them in the shell of a trusted machine for the one command; never write them into the repository, a shared file or the shell history.
- **Roles.** It runs through the restricted runtime connections (`recruitmentos_data` and `recruitmentos_identity`), installs the same signed session context as the app and calls the same owner-run helper `tenant_context.erase_candidate`. It never uses the migration owner's credentials. The audit row records `source: "script"`.
- **Stop conditions.** It exits with code 1 and one fixed line, changing nothing, when:
  - an argument is missing, repeated, unknown or empty (it prints the usage);
  - the email does not belong to a user with a verified email who is an `owner` of that team;
  - the candidate is not in that team ("Candidate not found in this team. Nothing was changed.");
  - the name does not match ("The confirmation name does not match the candidate's name. Nothing was changed.");
  - the team's CV storage records cannot settle a CV file's charge ("Candidate erasure stopped: the team's CV storage records need checking. Nothing was changed."); the app answers 500 `erasure_storage_settlement_failed` with a correlation id for the same case;
  - the database connections or signing key are not usable.
- **Output.** Only the erasure id, whether it was already erased, the counts and the CV storage figures; never a name, email, phone or file name. Outside Vercel no Blob gateway is built, so CV files are reported as waiting; the next CV storage cleanup deletes them.

## Verify

1. Open `/app/candidates/<id>`: it shows "Record not found in this team." Search the directory for the name, email and phone: nothing is found.
2. Activity shows "Permanently erased a candidate" by the erasing owner, and the earlier entries about the candidate read "Details removed by candidate erasure".
3. Wait until `cvStorage.waiting` reaches 0.
   - Each CV file can be deleted only after `deleteAfter` (its last upload ticket expired at least 10 minutes earlier).
   - After that time, run one cleanup with `POST /api/v1/cvs/storage-reconciliation` ([api-examples.md](api-examples.md#clean-up-cv-storage)), or wait for an automatic sweep after a later CV upload.
   - Then rerun the script (or the app action) for the same candidate. It reports `Already erased: true` and the current figures.
4. Optionally, the owner runs this read-only SQL in psql as the migration owner (the owner of schema `tenant_context`, whose owner-only policies let it read these rows) over a direct connection. It prints counts and ids only:

   ```sql
   -- psql: replace both values; the results never show personal data.
   \set team '<team id>'
   \set candidate '<candidate id>'
   SELECT
     (SELECT count(*) FROM app.records WHERE team_id = :'team' AND id = :'candidate') AS candidate_rows,
     (SELECT count(*) FROM app.candidate_states WHERE team_id = :'team' AND candidate_id = :'candidate') AS follow_up_states,
     (SELECT count(*) FROM app.uploads WHERE team_id = :'team' AND candidate_id = :'candidate') AS linked_uploads,
     (SELECT count(*) FROM app.record_files WHERE team_id = :'team' AND record_id = :'candidate') AS linked_record_files,
     (SELECT count(*) FROM app.bulk_intake_items WHERE team_id = :'team' AND candidate_id = :'candidate') AS linked_bulk_items,
     (SELECT count(*) FROM app.records WHERE team_id = :'team' AND kind = 'task' AND candidate_id = :'candidate') AS linked_tasks;
   SELECT e.id AS erasure_id, e.erased_at, e.erased_by,
     (SELECT count(*) FROM app.activity a WHERE a.erasure_id = e.id) AS activity_rows,
     (SELECT count(*) FILTER (WHERE u.blob_deleted_at IS NULL AND u.storage_provider = 'blob') FROM app.uploads u WHERE u.erasure_id = e.id) AS blob_files_waiting,
     (SELECT count(*) FILTER (WHERE f.blob_deleted_at IS NULL) FROM app.record_files f WHERE f.erasure_id = e.id) AS record_files_waiting
   FROM app.candidate_erasures e WHERE e.team_id = :'team' AND e.candidate_id = :'candidate';
   ```

   Every count in the first result is 0. The second result has exactly one row, and `blob_files_waiting` and `record_files_waiting` reach 0 after the cleanup.

## What remains and why

- **The tombstone** in `app.candidate_erasures`: the erasure id, team, candidate id, erasing owner and time. It is the audit record and makes a retry return the earlier erasure instead of failing.
- **Redacted activity rows**: the type, time and actor of each event about the erased records, with no record link, a fixed summary and empty details, so the audit trail keeps who did what and when. AI suggestion records keep only their request id, so a used request is still refused.
- **Erased upload rows**: object key, size, type, store, times and ledger state, with no file name and no candidate link. Pathnames are never reused and the storage quota ledger needs the rows to account for each file until its deletion is confirmed.
- **Erased record-file rows** (`app.record_files`, files of file fields): the same, with no file name, no digest and no record link, for the same reasons.
- **Bulk import item tombstones**, holding only ids, the batch and times, until their batch is purged (within 24 hours). Without them an uncertain retry of the import could create the candidate again.
- **Idempotency keys** with a one-way SHA-256 hash of the original request. Their stored responses are replaced and they are expired, so a replay returns 409 `idempotency_expired` and never recreates the candidate.
- **Possible-duplicate counts** on other candidates' import evidence (a number, never a name or id).
- **Legacy S3 objects**, if the team ever stored CVs in S3. Their charges are released, but the objects are not deleted by the app; delete them by hand by object key (the erased upload rows list the keys).
- **Blob provider-side retention**: how long Vercel Blob keeps deleted data internally is set by the provider's policy and is unknown here.
- **Neon backups and point-in-time history** until their retention window passes. After any restore to a point before an erasure, rerun the script for each erasure in the owner's request log. The log deliberately holds no name, so read the candidate's current name for `--confirm-name` from the restored record itself: open `/app/candidates/<candidate id>` as an owner of that team and copy the name exactly as shown.
- **Exports already downloaded**: CSV files on people's devices are outside the app (see "Before erasing").
- **Legacy source files**: the legacy importer reads the original CV folders and spreadsheets. Remove the person from those sources before any re-import, because a re-import would create the candidate again.

## The owner's request log

Keep a log outside the app, with no personal data, one line per erasure:

| Date received | Date erased | Team | Candidate id | Erasure id |
| ------------- | ----------- | ---- | ------------ | ---------- |

It is the list to rerun after a database restore and the evidence that each request was handled. After a restore, take the name for `--confirm-name` from the restored record (open its profile as an owner), never from the log.

## Erase an employee

How a company owner permanently erases one employee of the company directory (R2a-15, owner decisions D1 and D11). The steps mirror candidate erasure; the differences are noted.

### When to use it

- Use it only for data-protection requests, for example a former employee asking for their directory entry to be deleted, or after the retention review (below) when you have decided the data is no longer needed.
- For routine cases, set the employee's status to Left or archive them instead. Both keep the history; archiving cannot be undone but is never presented as erasure.
- Only a company owner can erase an employee, and only while signed in to the app. Company admins (with or without the organisation area), team owners and admins without company authority, members with directory:write, API tokens, OAuth grants and the MCP endpoint cannot. There is no script for employees.
- Nothing is ever erased automatically. **Admin portal > Directory > Retention review** lists, for company owners only, the employees whose status has been Left for 12 months or more, oldest first, archived ones included. The retention class (Standard or Extended) is shown there but enforces nothing yet.

### Before erasing

1. **Verify the requester** outside the app, through a channel you already trust. The app does not verify identity for you.
2. **Find every match.** In **Admin portal > Directory**, search by part of the name and by the employee number with **Include archived employees** ticked, so archived employees are included. Note each employee id from the response of `GET /api/v1/employees?search=...&includeArchived=true` or from your directory export, and erase each match separately.
3. **Check for a legal hold.** None is implemented in the app, so the owner decides whether any reason requires keeping the data, and records that decision outside the app.

### Erase in the app

1. Sign in as a company owner whose team role has directory:read (a team owner or admin), and open **Admin portal > Directory**.
2. Search for the employee and choose **Actions** on their row, then **Permanently erase employee**; or find them in the retention review and choose **Permanently erase employee** on their row.
3. Read what is removed, kept and not covered.
4. Type the employee's name exactly as shown (case matters; spaces at either end are ignored). **Permanently erase** stays disabled until it matches.
5. Choose **Permanently erase**. The page shows "Employee permanently erased." and both lists reload without the employee.
6. Record the erasure in the owner's request log (below). The erasure id is in the response of `POST /api/v1/employees/{id}/erasure`.

A second erasure of the same employee is safe: it returns the earlier erasure (`alreadyErased: true`, the same erasure id, time and counts) and writes nothing.

### Verify

1. Search **Admin portal > Directory** for the name and the employee number, with **Include archived employees** ticked: nothing is found.
2. Activity, for members with company authority, shows "Permanently erased an employee" by the erasing owner, and the earlier directory entries about the employee read "Details removed by employee erasure" in every team of the company.
3. Optionally, the owner runs this read-only SQL in psql as the migration owner (the owner of schema `tenant_context`, whose owner-only policies let it read these rows) over a direct connection. It prints counts and ids only:

   ```sql
   -- psql: replace both values; the results never show personal data.
   \set workspace '<workspace id>'
   \set employee '<employee id>'
   SELECT
     (SELECT count(*) FROM app.employees WHERE workspace_id = :'workspace' AND id = :'employee') AS employee_rows,
     (SELECT count(*) FROM app.employee_positions WHERE workspace_id = :'workspace' AND employee_id = :'employee') AS position_rows;
   SELECT e.id AS erasure_id, e.erased_at, e.erased_by, e.erasure_source,
     (SELECT count(*) FROM app.activity a WHERE a.employee_erasure_id = e.id) AS activity_rows
   FROM app.employee_erasures e WHERE e.workspace_id = :'workspace' AND e.employee_id = :'employee';
   ```

   Both counts in the first result are 0. The second result has exactly one row; `activity_rows` is the redacted rows plus the one `employee.erased` row.

### What remains and why

- **The tombstone** in `app.employee_erasures`: the erasure id, company, employee id, erasing owner, time and source. It is the audit record and makes a retry return the earlier erasure. No name, email, phone or employee number.
- **Redacted activity rows**: the type, time and actor of each directory and home-unit event about the employee, with a fixed summary, empty details and a pointer to the tombstone.
- **The `employee.erased` row** with counts only (position rows, redacted activity rows, user links).
- **One home-unit change row** naming the user id that was linked to the employee, when there was one: removing the link changes that member's home units, so company owners see it under recent access changes. It holds the user id, never the employee.
- **The user's account, team memberships, configured role and company authority**: erasure removes only the directory entry and the link. Remove the account or memberships separately if the request covers them.
- **Positions and units**: they are company structure, not personal data, and stay.
- **Neon backups and point-in-time history** until their retention window passes. After any restore to a point before an erasure, erase each employee in the owner's request log again through the app: search for the employee id's current name in the restored directory and type it exactly as shown.
- **Import spreadsheets and other copies outside the app**, such as the files the directory was imported from. Remove the person from those sources before any re-import, because a re-import would create the employee again.

### The owner's request log

Keep a log outside the app, with no personal data, one line per erasure:

| Date received | Date erased | Employee id | Erasure id |
| ------------- | ----------- | ----------- | ---------- |

It is the list to rerun after a database restore and the evidence that each request was handled. After a restore, rerun each line through **Admin portal > Directory**, taking the name to type from the restored directory, never from the log.

## Anonymise a user account

How a company owner permanently anonymises one person's account in the company (ADM-10, IAM-003, owner decisions D1, D20 and D29). It removes the person's access and personal details from the account, not the team data they worked on. The steps mirror employee erasure; the differences are noted.

### When to use it

- Use it only for data-protection requests, for example a former member asking for their account to be deleted. For a person who is leaving or on leave, use **Deactivate** on the same Security tab instead: it keeps everything and can be undone. Anonymisation cannot be undone.
- Only a company owner can anonymise, and only while signed in to the app with a recent sign-in. Company admins (the People area included), team owners and admins without company authority, recruiters, viewers, API tokens, OAuth grants and the MCP endpoint cannot. There is no script and no bulk action.
- You cannot anonymise your own account, the last owner of any team of the company (archived teams included) or the last company owner. Make someone else that team's owner, or a company owner, first.
- A person who is also in a team of another company cannot be anonymised from here: the account is shared, and one company never changes another's access.

### Before anonymising

1. **Verify the requester** outside the app, through a channel you already trust. The app does not verify identity for you.
2. **Find the person** in **Admin portal > Users**, by name or email. Note their user id from the address of their page (`/app/admin/users/<user id>`).
3. **Check for a legal hold.** None is implemented in the app, so the owner decides whether any reason requires keeping the data, and records that decision outside the app.
4. **Check the directory.** Anonymisation does not touch the company directory. If the person has an employee entry and the request covers it, erase it separately ([Erase an employee](#erase-an-employee)).
5. **Search free text the app does not edit.** Names or emails typed into records, comments, task text or vacancy notes stay. Search the workspace for the name and email and edit those mentions by hand.

### Anonymise in the app

1. Sign in as a company owner and open **Admin portal > Users**, then the person's name.
2. Open the **Security** tab. Under **Anonymise account**, choose **Anonymise account**.
3. Read what is removed, kept and not covered. **Cancel** has focus first.
4. Type the person's name exactly as shown (case matters; spaces at either end are ignored). **Anonymise account** stays disabled until it matches.
5. Choose **Anonymise account**. If your sign-in is older than 15 minutes, **Confirm it's you** opens over the dialog: enter your password and two-step code, and the same request is sent once more with the name you typed. A refusal, such as the last owner of a team, shows its reason in the dialog, which stays open.
6. The page shows "<name>'s account was anonymised. They no longer appear in Users." with **Back to Users**.
7. Record the anonymisation in the owner's request log (below). The anonymisation id is in the response of `POST /api/v1/admin/users/{user}/anonymise`.

A second anonymisation of the same person is safe: it returns the earlier anonymisation (`alreadyAnonymised: true`, the same id, time and counts) and writes nothing.

**Company groups (ADM-11).** The person's group memberships (`app.group_members`) and group manager rows (`app.group_managers`) in the company are removed, and with them their effective membership of every group above; the group activity entries about them (added to or removed from a group, made or removed as a manager) are redacted with the rest. The groups and their other members stay. These removals are not counted separately: they show in the redacted activity count.

### Verify

1. **Admin portal > Users** no longer lists the person, and their page answers "This person is not in any team of your company." Signing in with the old email and password fails.
2. Activity, for members with company authority, shows "Anonymised a user account" by the anonymising owner. The earlier entries about the person (company authority, two-step reset, deactivation and other account changes, configured roles, home units, record assignments and group memberships) read "Details removed by user anonymisation" in every team of the company. Entries the person made themselves keep their text and show the placeholder name.
3. Optionally, the owner runs this read-only SQL in psql as the migration owner (the owner of schema `tenant_context`, whose owner-only policies let it read these rows) over a direct connection. It prints counts and ids only:

   ```sql
   -- psql: replace both values; the results never show personal data.
   \set workspace '<workspace id>'
   \set person '<user id>'
   SELECT
     (SELECT count(*) FROM auth.member WHERE user_id = :'person') AS memberships,
     (SELECT count(*) FROM auth.session WHERE user_id = :'person') AS sessions,
     (SELECT count(*) FROM auth.account WHERE user_id = :'person') AS credentials,
     (SELECT count(*) FROM auth.api_tokens WHERE user_id = :'person') AS api_tokens_and_grants,
     (SELECT count(*) FROM auth.two_factor WHERE user_id = :'person') AS two_step,
     (SELECT count(*) FROM auth.verification WHERE value = :'person') AS devices_and_challenges,
     (SELECT count(*) FROM app.member_roles WHERE user_id = :'person') AS configured_roles,
     (SELECT count(*) FROM app.record_assignments WHERE user_id = :'person') AS record_assignments,
     (SELECT count(*) FROM app.workspace_admins WHERE workspace_id = :'workspace' AND user_id = :'person') AS company_authority,
     (SELECT count(*) FROM app.group_members WHERE user_id = :'person') AS group_memberships,
     (SELECT count(*) FROM app.group_managers WHERE user_id = :'person') AS group_managers,
     (SELECT count(*) FROM auth."user" WHERE id = :'person' AND email LIKE 'anonymised-%@invalid' AND NOT email_verified) AS placeholder_accounts;
   SELECT x.id AS anonymisation_id, x.anonymised_at, x.anonymised_by, x.erasure_source,
     (SELECT count(*) FROM app.activity a WHERE a.user_anonymisation_id = x.id) AS activity_rows
   FROM app.user_anonymisations x WHERE x.workspace_id = :'workspace' AND x.user_id = :'person';
   ```

   Every count in the first result is 0 except `placeholder_accounts`, which is 1. The second result has exactly one row; `activity_rows` is the redacted rows plus the one `user.anonymised` row.

### What remains and why

- **The account row** in `auth."user"`. Its name becomes "Former user" and the first 8 characters of the anonymisation id, its email `anonymised-<anonymisation id>@invalid` (a reserved domain that never receives mail), with no picture, and email verification and two-step sign-in off. Records, uploads, activity, configuration and teams refer to the account by id, so the row is kept and renamed rather than deleted.
- **The tombstone** in `app.user_anonymisations`: the anonymisation id, company, user id, anonymising owner, time and source. It is the audit record and makes a retry return the earlier anonymisation. No name or email.
- **Redacted activity rows**: the type, time and actor of each event about the person, with a fixed summary, empty details and a pointer to the tombstone. A redacted row that also named other people (a home-unit change for several members) loses their ids too, as with employee erasure.
- **The `user.anonymised` row** with ids and counts only (memberships, sessions, API tokens, two-step, configured roles, record assignments, company authority, invitations and redacted activity rows).
- **Team data the person created or acted on**: records, candidates, comments, files, saved views, follow-up notes and the activity they performed. These belong to the team (D1); their actor now reads as the placeholder name.
- **The deactivation row** in `app.workspace_users`, when the person was deactivated. It holds ids only.
- **The company directory entry**, if any. Erase it separately.
- **Sign-in rate-limit rows**, keyed by a one-way hash of the old email, which expire on their own.
- **Neon backups and point-in-time history** until their retention window passes. After any restore to a point before an anonymisation, anonymise each person in the owner's request log again: open `/app/admin/users/<user id>?tab=security` as a company owner and type the name shown there.
- **Copies outside the app**, such as exports, email threads and spreadsheets.

### The owner's request log

Keep a log outside the app, with no personal data, one line per anonymisation:

| Date received | Date anonymised | User id | Anonymisation id |
| ------------- | --------------- | ------- | ---------------- |

It is the list to rerun after a database restore and the evidence that each request was handled. After a restore, take the name to type from the restored user page, never from the log.
