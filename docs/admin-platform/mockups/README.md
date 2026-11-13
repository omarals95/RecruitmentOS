# Admin portal mockups: how to build a page

Static, clickable mockups of the RecruitmentOS **Admin portal** for the owner to test before anything is built. No build step, no network, no database. Open with `run-mockups.cmd` (or the server already running at http://127.0.0.1:4400).

## Owner's direction (verbatim, 10 November 2026)
> The Jira Service management is meant to only target look and feel, workflow engine, screen customization, centralized custom fields page, and user, group, roles, and permission engine and hierarchy. Team settings should also shift under the admin portal or removed altogether and replaced by the admin settings. Other things like whitelabeling, customizing the look and feel, adding a tab to change the domain name, notification settings, and the outgoing mail server should also be part of the admin portal. The admin portal should be the one stop show for all admin access. … System health and monitoring is used to monitor system usage, storage, and server and database usage and speeds where applicable if deployed on linux servers instead of vercel.

## Product facts you must respect
- RecruitmentOS is an internal recruitment workspace (Next.js on Vercel, Neon Postgres, Vercel Blob for CVs, Resend for email). Records: candidates, job roles, vacancies, applications (pipeline stages Applied → Screening → Interview → Assessment → Offer → Hired / Rejected), interviews, offers, onboarding, team tasks.
- Hierarchy: **Company workspace** (one company) → **Teams** (each team's records are isolated from other teams) → members. Company configuration (roles, fields, screens, workflows, org chart, templates, branding) is defined once and shared by all teams.
- People's access: each member has a **team role** per team (Owner, Admin, Recruiter, Viewer), optionally narrowed by a **configured role** (company-defined, e.g. "Recruiter, no CV upload", Hiring manager = my unit and below, Interviewer = assigned to me). Separately, **company authority** (Company owner / Company admin with areas: Record fields, Workflows, Boards, Organisation, Templates; plus per-person plan access) runs the Admin portal. A team role never gives company authority.
- A role has: membership ceiling, pages, actions per resource (View, Create, Edit, Move stage, Archive, Export, Erase, Approve, Import, Comment, Share view), field rules (Default / Hidden / Read only / Can edit), record scope (All records / My unit and below / Assigned to me). Private notes, shortlists and private saved views can never be granted.
- Organisation: levels (Company, Division, Department…), units, positions, employees directory; vacancies belong to a unit; record scope follows the hierarchy.
- Use the Jira Data Center spec in `C:/Users/omara/Documents/Obsidian/RecruitmentOS/docs/admin-platform/` (files 03–10) **only** for: users, groups (nested, approval groups), roles & permission engine and hierarchy, permission helper, centralised custom fields (contexts, options), screens & screen designer, workflow engine & designer, look and feel / white-labelling, plus the admin-portal patterns of spec 10. Translate Jira terms: Jira *Instance* = our company workspace, Jira *Workspace/Project* = our **Team**, Jira *Issue/Item* = our records. Leave out service-desk and Jira-software items (customer portal, request types, SLAs, item keys, sprints, licences, LDAP/SAML/SCIM, cluster nodes, incoming mail).
- Platform reality: hosted on Vercel today (no servers to manage); the health page must also show what it looks like when self-hosted on Linux servers (CPU, memory, disk, DB connections). Email goes through **Resend** by default, with an optional custom SMTP server. The domain is a Vercel domain today (`recruitmentos-preview.vercel.app`; planned `app.recruitmentos.ae`); changing it needs DNS records and updates sign-in/OAuth callback addresses.

## Files you own
Write only the page files assigned to you under `pages/`. Do **not** edit `app.js`, `styles.css`, `data.js` or `index.html` (if you truly need a shared helper or CSS class, put scoped CSS in a `<style>` block inside your page's render output, or a helper function inside your own file). Page-specific sample data lives inside your own file. All data is fictional (`@example.test` emails; names may be Emirati, Arab, South Asian or Western; money in AED).

## Page contract (see `pages/home.js` for a complete example)
```js
Admin.register({
  id: "users",                 // route #/users ; sub-routes #/users/u-101?tab=groups → ctx.params = ["u-101"], ctx.query.get("tab")
  group: "People & access",    // one of: Overview, People & access, Configuration, Look & feel, Communication, Integrations, System
  title: "Users", icon: "users",   // icon names: see ICONS in app.js
  spec: ["IAM-005", "IAM-006"],     // requirement IDs from the spec this screen covers
  changes: "One line: what is new or different from today's app.",
  render(ctx) { return htmlString; },      // ctx: { params, query, state, navigate, ui, data, dir }
  mount(root, ctx) { /* optional: add event listeners after render */ },
});
```
- **States:** when `ctx.state` is `loading`, `empty` or `error`, return the page header plus `ctx.ui.stateBlock(ctx.state, {...})` with a sensible empty message and call to action.
- **Helpers** in `ctx.ui` (= `Admin.ui`): `pageHeader, badge(text, tone ok|warn|bad|info), btn(label,{kind:'primary'|'danger'|'ghost'|'sm', attrs, ic}), table(cols, rows), tabs(id, [{id,label}], active), field(label, control, hint), input, select, check, kpi, bar, avatar, esc, icon`. Overlays: `Admin.drawer(html)`, `Admin.modal(html)`, `Admin.close()`, `Admin.toast(msg)`, `Admin.navigate('path')`, `Admin.rerender()`.
- Tabs: `ui.tabs("x", [...], ctx.query.get("tab") || "first")` already updates `?tab=` on click.
- **Interactivity:** make the important actions work in the mockup (open drawer/modal, switch tabs, toggle checkboxes, show a toast "Saved (mockup)", drag nodes on canvases where asked). No real persistence needed.
- Must look right in **dark mode**. Right-to-left and Arabic are out of the design (owner, 10 Nov 2026). Use the CSS variables only, never hard-coded colours (except inside brand/colour pickers and previews).
- Plain-English, short UI copy. British spelling. No lorem ipsum.
- Every destructive or wide-impact action shows an impact summary first ("Used by 3 teams · 2 workflows · 41 records") and asks to confirm.

## Checking your work
The server runs at http://127.0.0.1:4400 . Use the agent-browser CLI to screenshot each of your routes in light and dark and to check the console has no errors:
`C:/Users/omara/AppData/Local/hermes/tools/agent-browser-0.26.0-win32-x64/bin/agent-browser-win32-x64.exe open "http://127.0.0.1:4400/#/users"` then `... set viewport 1440 900`, `... screenshot <path>.png`, `... eval "<js>"`. Save screenshots under `screenshots/<page-id>-<variant>.png` in this folder. Toggle dark with `... eval "Admin.toggleTheme()"` and states with `"Admin.setState('empty')"` (reset to light/normal afterwards: `localStorage.clear()` then reload).
