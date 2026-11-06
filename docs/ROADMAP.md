# RecruitmentOS release roadmap

_Last updated: 5 November 2026. Owner: Omar Alshair. Status: approved direction, dates not committed._

This roadmap turns the requirement register (`docs/requirements/register.md`), the factory backlog (`factory/backlog.md`) and the competitive gap analysis of 15 recruitment products into releases. **Phase 1 makes RecruitmentOS usable in production for the internal team.** Later releases close the gaps against market leaders and add an integrations marketplace.

Principles that apply to every release:

- **Facts, not verdicts.** No automated ranking, scoring, rejection or inference of sensitive traits. AI only suggests; a person reviews.
- **Private stays private.** Personal notes, shortlists and saved views are never shared through any screen, API, MCP tool or integration.
- **Gated by evidence.** A feature ships only when its tests pass on the exact release and, where it touches live services, after a live check on Preview.
- **Owner approval** for deploys, new data recipients (integrations, AI providers), paid services and real-data migration.

## At a glance

```
Phase 1  Usable core (go-live)        ── in progress, factory backlog
R1.1     Feedback loop                ── scorecards, real users, pipeline speed, duplicates
R1.2     Hiring managers & approvals  ── requester role, approvals, interview kits, debrief
R1.3     Integrations marketplace v1  ── Outlook, Gmail, Google/Microsoft calendars, Teams, Slack, Discord
R1.4     Insights                     ── customisable dashboards, widgets, goals, scheduled reports
R1.5     Compliance & data lifecycle  ── retention, erasure, consent, data requests, Emiratisation tracker
R2.0     Reach & region               ── careers page, job boards, WhatsApp/SMS, Arabic/RTL, mobile, live AI
```

## Phase 1 — Usable core (go-live release)

**Goal:** the recruitment team can use RecruitmentOS every day on Production with fictional data first, then real data after the separate migration approval.

| ID    | Item                                                                                                                                                                                                                | Status                                   | Why it is in Phase 1                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------- |
| P1-01 | Trusted tenant isolation, restricted database roles, live isolation tests                                                                                                                                           | Done (Preview verified)                  | Security foundation                     |
| P1-02 | Hosted sign-in, first administrator setup, invitations, password reset                                                                                                                                              | Done (Preview verified)                  | People must be able to sign in          |
| P1-03 | Private CV storage foundations (Blob upload/download, quotas, read limits)                                                                                                                                          | Done locally; live switch-on pending     | Core intake                             |
| P1-04 | MCP endpoint for Claude and ChatGPT with OAuth consent                                                                                                                                                              | Done locally; live test pending          | Owner request                           |
| P1-05 | WP-17 bug fixes from the app review (settings tab, session error, comment authors, overdue logic, calendar order, vacancy counts, icons, formats, import dialog, phone layout)                                      | In progress                              | Visible defects undermine trust         |
| P1-06 | WP-07 core workflow and UI gaps                                                                                                                                                                                     | In progress (parts 1 and 2 done locally) | Daily journeys must work end to end     |
| P1-07 | WP-09 bulk CV intake with review, duplicate check and safe retry; WP-09b follow-ups (Blob protocol, CV re-upload, purge, paged batches, live roles) done locally; Preview migrations `0015` and `0016` pending      | Done locally; Preview migrations pending | Most requested intake path              |
| P1-08 | WP-10 AI extraction contract with consent and review (test adapter only; live provider stays off)                                                                                                                   | Queued                                   | Ready for R2.0 without blocking go-live |
| P1-09 | WP-13 database deadlines and capacity                                                                                                                                                                               | Queued                                   | Reliability under the pooler            |
| P1-10 | WP-11 logging, monitoring and security hardening                                                                                                                                                                    | Queued                                   | Operate safely                          |
| P1-11 | WP-12 migration, release and recovery operations                                                                                                                                                                    | Queued                                   | Backup, restore, rollback               |
| P1-12 | WP-08 accessibility and responsive acceptance (WCAG 2.2 AA target)                                                                                                                                                  | Queued                                   | Usable on desktop, phone and keyboard   |
| P1-13 | WP-15 documentation and configuration reconciliation                                                                                                                                                                | Queued                                   | Accurate handover                       |
| P1-14 | **Added to Phase 1:** inline "possible duplicate" warning when adding a candidate (the API already exists)                                                                                                          | Done locally                             | Prevents duplicate records from day one |
| P1-15 | **Added to Phase 1:** switch on live Blob CV storage on Preview, run the owner-run live verification, then Production                                                                                               | New, needs owner OK                      | CV upload is part of the daily workflow |
| P1-16 | **Added to Phase 1:** Production environment: migrations, restricted roles, evidence and live-role tests, secrets, custom domain (for example `app.recruitmentos.ae`), DMARC for `recruitmentos.ae`, guarded deploy | New, needs owner OK at each step         | Nothing reaches users without it        |

**Go-live gate:** all Phase 1 items done; full CI green on the release commit; Preview smoke checks; Production evidence script and live-role tests pass; backup and restore rehearsed; owner approval to deploy.

## R1.1 — Feedback loop

Closes top gaps 1, 2, 7 and 8 from the analysis.

| ID     | Item                                                                                                                                          | Gap |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| R11-01 | Owners, recruiters, hiring managers and interviewers become real user references (imported free-text names kept as labels)                    | #2  |
| R11-02 | Competency library and scorecard templates per job role, copied to vacancies                                                                  | #1  |
| R11-03 | Scorecards per interviewer: rating per competency, evidence, overall recommendation including "no decision"; hidden until you submit your own | #1  |
| R11-04 | Feedback-due reminders (in-app 1 hour after the interview, then next UAE business day)                                                        | #1  |
| R11-05 | Rejected and Withdrawn become an outcome with a mandatory reason; the stage reached is kept                                                   | #7  |
| R11-06 | Bulk move, reject (with reason) and assign, with a result summary                                                                             | #7  |
| R11-07 | Days-in-stage badges and stage SLA thresholds                                                                                                 | #7  |
| R11-08 | Compare-and-merge duplicates with explicit rules and audit; "not a duplicate"                                                                 | #8  |
| R11-09 | Fix metric definitions flagged in the analysis (open vacancies, department chart)                                                             | #10 |

## R1.2 — Hiring managers and approvals

Closes top gaps 2 and 3 and the "requesting department" perspective.

| ID     | Item                                                                                                     | Gap |
| ------ | -------------------------------------------------------------------------------------------------------- | --- |
| R12-01 | Hiring manager role and home screen: candidates to review, my interviews, my feedback, approvals waiting | #2  |
| R12-02 | Requisition intake form and approval chain (department head, finance, HR)                                | #3  |
| R12-03 | Offer approval chain with amount visible only to approvers                                               | #3  |
| R12-04 | Interview kits: questions per competency, guidance, and the candidate packet                             | #1  |
| R12-05 | Debrief view after all scorecards are in; decision recorded by a person                                  | #1  |
| R12-06 | Notification centre and email notifications for approvals, reminders and mentions                        | #5  |
| R12-07 | Candidate email templates and logged outbound email (sent through the R1.3 email integrations or Resend) | #5  |

## R1.3 — Integrations marketplace v1

Closes top gaps 5 and 6. Every integration is installed per team from a **marketplace** page, so admins can see what is connected and what data it gets.

**Marketplace framework (built first):**

| ID     | Item                                                                                                                                                                 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R13-01 | Marketplace catalogue: install, configure, pause, disconnect per team; owner/admin only                                                                              |
| R13-02 | Connection security: OAuth per provider, tokens encrypted and server-only, least-privilege scopes, data shared shown before install, every sync and delivery audited |
| R13-03 | Event bus and delivery queue with retries, dead-letter list and per-integration health status                                                                        |
| R13-04 | Outbound webhooks (signed) for custom integrations                                                                                                                   |

**Integrations:**

| ID     | Integration                                | What it does                                                                                                   |
| ------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| R13-10 | **Microsoft Outlook / Microsoft 365 mail** | Send candidate emails from the recruiter's mailbox, log replies to the candidate timeline                      |
| R13-11 | **Gmail / Google Workspace mail**          | Same as Outlook                                                                                                |
| R13-12 | **Microsoft Outlook calendar**             | Two-way interview sync, free/busy lookup, Teams meeting links                                                  |
| R13-13 | **Google Calendar**                        | Two-way interview sync, free/busy lookup, Google Meet links                                                    |
| R13-14 | **Candidate self-scheduling**              | Booking links from real availability (uses R13-12/13)                                                          |
| R13-15 | **Microsoft Teams**                        | Channel and personal notifications (new applicant, feedback due, approval needed) with approve/decline buttons |
| R13-16 | **Slack**                                  | Same as Teams                                                                                                  |
| R13-17 | **Discord**                                | Channel notifications through a bot or webhook (no candidate personal data beyond name and link by default)    |
| R13-18 | **Claude and ChatGPT (MCP)**               | Listed in the marketplace with their consent status (built in Phase 1)                                         |

Notifications never include private notes, sensitive attributes or CV contents; links open RecruitmentOS where permissions are checked again. Each provider needs an app registration in Omar's accounts (Microsoft Entra, Google Cloud, Slack, Discord), approved separately.

## R1.4 — Insights

Closes top gap 10.

| ID     | Item                                                                                                                                                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R14-01 | Customisable home dashboard: add, remove, resize and reorder widgets                                                                                                                                                               |
| R14-02 | Widget library: KPI card, trend, bar/stacked, funnel, time-in-stage, pipeline by stage, source effectiveness, recruiter workload, interviewer feedback SLA, upcoming interviews, overdue tasks, offers pending, requisition ageing |
| R14-03 | Widget builder: pick metric, calculation (count, sum, average, median, percentage, rate, time between events, conversion), chart, filters, date range and comparison with the previous period                                      |
| R14-04 | Targets and colour thresholds; personal and shared dashboards; role templates (recruiter, hiring manager, admin)                                                                                                                   |
| R14-05 | Scheduled report emails and CSV export with formula-injection protection                                                                                                                                                           |

Metric definitions follow the analysis: imported history never creates fake events, and small samples show their count.

## R1.5 — Compliance and data lifecycle

Closes top gap 9. Requires the owner's privacy and retention policy decisions first.

| ID     | Item                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------ |
| R15-01 | Retention schedules per record type, anonymisation and permanent deletion workflow across rows, CVs, exports and backups |
| R15-02 | Candidate consent records and privacy notice versions                                                                    |
| R15-03 | Data subject requests: access, correction, erasure, with an audit trail                                                  |
| R15-04 | Audit export for administrators                                                                                          |
| R15-05 | Emiratisation tracker and work permit checklist (if approved; counts only, no automated decisions)                       |
| R15-06 | Malware scanning and quarantine for uploaded CVs before real untrusted intake at scale                                   |

## R2.0 — Reach and region

| ID     | Item                                                                                            |
| ------ | ----------------------------------------------------------------------------------------------- |
| R20-01 | Careers page and job posting; job boards (Bayt, GulfTalent, LinkedIn) through the marketplace   |
| R20-02 | WhatsApp and SMS with explicit consent, through the marketplace                                 |
| R20-03 | Arabic interface and right-to-left layout                                                       |
| R20-04 | Installable mobile app (PWA) for hiring managers: approvals, scorecards, interviews             |
| R20-05 | Live AI extraction with an approved provider, region and retention terms; human review required |

## Deliberately not doing

- Automated candidate ranking, suitability scores or automatic rejection.
- Inferring gender, nationality, age or other sensitive traits from names, photos or folders.
- Sending CVs to an AI provider without the owner's specific approval of provider, region and retention.
- Two-way sync with the old Excel files.

## Top 10 gaps covered

| #   | Gap from the analysis                               | Release                                 |
| --- | --------------------------------------------------- | --------------------------------------- |
| 1   | Structured interview feedback (scorecards, kits)    | R1.1, R1.2                              |
| 2   | Hiring managers and interviewers as real users      | R1.1, R1.2                              |
| 3   | Requisition and offer approvals                     | R1.2                                    |
| 4   | CV storage, bulk import, AI extraction switched off | Phase 1 (storage, bulk), R2.0 (live AI) |
| 5   | Candidate communication                             | R1.2, R1.3, R2.0                        |
| 6   | Calendar sync and self-scheduling                   | R1.3                                    |
| 7   | Bulk actions, rejection reasons, stage ageing       | R1.1                                    |
| 8   | Duplicate merge                                     | Phase 1 (warning), R1.1 (merge)         |
| 9   | Retention, erasure, consent, data requests          | R1.5                                    |
| 10  | Fixed dashboards, miscounted metrics                | Phase 1 (fixes), R1.1, R1.4             |
