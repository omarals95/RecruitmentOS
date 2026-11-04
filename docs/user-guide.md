# Using RecruitmentOS

## Start your day

Sign in with your verified email/password, or a configured Google/Microsoft provider. Select your team in the sidebar. **Overview** shows actual candidate, vacancy and workflow counts, upcoming interviews, overdue tasks and recent recruitment activity. Candidate counts describe people; CV counts describe uploaded ready files and can differ. Dark, light and system themes are available in the top bar.

Use the top-bar search (Ctrl/Cmd+K) to find candidates, vacancies, roles and tasks. Search can use a quoted phrase or exclude a word with `-word`. Your team determines which records you can access.

## Candidates and source records

Open **Candidates** to search/filter facts, skills, certifications, source-folder categories, education, experience and review status. Folder categories reproduce the folders used during import; they do not independently assess job suitability. Missing facts remain missing.

Open a candidate for education/contact details, source evidence, CVs, related applications, recruitment tasks, interviews, offers and onboarding. Use **Create hiring task** to add a task linked to this candidate and, optionally, a vacancy. Use **Add application** or the directory's multi-select vacancy action to create applications. Creating a task does not create an application or change a hiring stage.

The **My follow-up** area and shortlist are private to your account. Use **Discussion** for shared comments. Save forms explicitly. When a record changes elsewhere, a conflict keeps your draft so you can review the latest version before retrying.

Upload CV files from the candidate's profile after private storage is configured. Until storage is set up, the CV area and **Import CVs** explain that CV uploads are not set up yet and show no file picker; candidate details can still be added and edited. Files upload directly to private storage, then undergo format checks before a download is available. A file's source path is relative historical metadata. In the cloud, Open/Download uses a short-lived private link; it cannot open Windows File Explorer. Multiple CV references can belong to the same candidate.

Use **Source review** to work through incomplete/ambiguous extraction information. Review evidence before correcting facts. The application does not infer sex/gender, national service completion, nationality or residence from a name or photo. Exports contain candidate information and need the same care as the source CVs.

## Roles, vacancies and applications

Create reusable **Job roles** with title, department, description, requirements and skills. Create an **Open vacancy**, optionally copying a role's details into the draft. Changes to a role do not silently rewrite existing vacancies.

Use **Applications** to link a candidate and vacancy. Move the application through the pipeline explicitly. Dragging has a keyboard-accessible Move alternative. Application stage, vacancy status, task bucket, offer status and onboarding status are separate choices. Marking an offer accepted does not automatically mark an application hired.

## Recruitment tasks

Use **Tasks** for your team's workflow. Add and reorder buckets; choose their names and colours. A bucket is a task's status. Add custom fields (text, number, date, dropdown, checkbox) and choose which are required. Archiving a field retains old values. Archiving a populated bucket asks for a destination and moves its tasks together; at least one bucket must remain.

Tasks can link candidates and vacancies, or retain a free-text context. Set an owner, due date and priority. Edit or move cards with buttons as well as dragging. Saved views retain filters so frequently used searches are easy to revisit; views are private to your account.

## Interviews, offers and onboarding

Schedule interviews against an application, with interviewer, duration, location or meeting URL. Calendar dates/times display in **Asia/Dubai (UTC+4)**. Use day, week, month or list views and update completion/cancellation manually.

Track offer amount/currency, pay period, dates, status and decline reason separately from the application stage. Onboarding links to an application and contains document, orientation, training or other checklist items. Progress uses complete/waived items out of configured active items; an empty checklist is not automatically complete.

Notifications collect due tasks, interviews, expiring offers, vacancy targets and onboarding items. Marking visible reminders read affects your account. Analytics distinguish current inventory from changes actually observed by RecruitmentOS. Imported records do not invent old transition dates or time-to-hire values.

## Team and account settings

Owners/admins manage team details, invitations and permitted membership changes. Only owners manage ownership; a team retains at least one owner. Recruiters work with recruitment records; viewers read them. Team switching changes the active workspace.

Profile settings manage your name, password and sessions. In **API tokens**, create a named token for one integration, choose the smallest necessary scopes and expiry, and copy it once to the integration's secret store. Revoke unused tokens. A token remains tied to your user and team and loses permissions when your role changes or your membership is removed. See [API examples](api-examples.md).

## Data administration

An administrator prepares cloud services and imports legacy files using [deployment.md](deployment.md) and [migration.md](migration.md). The importer starts with a local reconciliation report and requires an explicit apply command. PostgreSQL becomes the canonical store; editing old Excel workbooks does not update the deployed application.
