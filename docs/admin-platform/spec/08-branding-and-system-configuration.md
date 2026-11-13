# 08 — Branding (White-label) & System Configuration

## 1. Look & feel (`/admin/branding`) — `scope.branding.manage`

| Setting | Type / constraints | Applies to |
|---------|--------------------|-----------|
| Instance title | string ≤ 60 | Browser title, header, emails, login |
| Logo – primary (light background) | SVG/PNG, ≤ 1 MB, recommended 240×48; auto-scaled to header height 32 px | Header, emails, portal |
| Logo – inverse (dark background / dark mode) | as above | Dark theme, dark headers |
| Logo mark (square) | SVG/PNG 512×512 | Collapsed sidebar, mobile, PWA icon, notification avatars |
| Show title next to logo | bool | Header |
| Favicon | SVG + PNG; system **generates** `favicon.ico` (16/32/48), `apple-touch-icon` 180, PWA `192/512`, `mask-icon` | Browser, bookmarks, PWA manifest |
| **Accent / primary colour** | hex | Primary buttons, links, focus rings, selected states |
| Secondary colour | hex | Secondary emphasis, charts series 2 |
| Header background / header text | hex / auto | Global top bar |
| Sidebar background / text | hex / auto | Admin + app navigation |
| Status category colours | locked to accessible defaults (overridable by System admin only) | Status lozenges |
| Default theme | `light` / `dark` / `system` | Users can override (profile) unless locked |
| Typography | font family from allow-listed set or uploaded WOFF2 (Latin + Arabic subsets), base size | Whole UI |
| Corner radius / density | `compact` / `comfortable` | UI |
| Login page | background image/colour, welcome heading, message (rich text, localised), show/hide SSO/local forms (spec 03 IAM-032), footer links (privacy, terms, support) | Login |
| Email branding | header logo (light/dark), accent colour, footer legal text/address (localised), social/link row | All emails (spec 07 NTF-045) |
| Custom footer | links + text (localised) | App footer |
| Support/help link | URL | Help menu |

| ID | Requirement |
|----|-------------|
| BRD-001 | Branding edited as **draft** with **live preview** (header, buttons, item view, login page, email, portal — light and dark, LTR and RTL), then **Publish**. Previous versions retained; *Revert*; *Reset to product defaults*. |
| BRD-002 | **Contrast validation (WCAG 2.2 AA)**: on colour change, compute contrast ratios for text-on-accent, accent-on-background (both themes), header text. If < 4.5:1 (text) or < 3:1 (UI components), show error and offer an auto-adjusted accessible shade; publishing with failures requires System admin override with acknowledgement. |
| BRD-003 | **Palette generation**: from accent colour derive a tonal scale (50–900) and hover/active/disabled/focus states for both themes; stored as design tokens. |
| BRD-004 | Assets are stored in the file store with content-hash names and served with long-lived cache headers; publishing updates the token/asset manifest version so clients refresh without cache purge. |
| BRD-005 | Uploaded SVGs are **sanitised** (strip scripts, event handlers, external references) before storage. Raster images re-encoded; EXIF stripped. |
| BRD-006 | **Custom CSS** is **not** supported by default (upgrade-fragile, XSS risk). An optional System-admin-only *Advanced: custom CSS* field may be enabled by setting `branding.allowCustomCss = true`; it is scoped under a `.custom-brand` root, sanitised (no `url()` to external hosts, no `@import`, no `expression`), and versioned. |

## 2. Design tokens contract

Branding produces a token document consumed by the front-end as CSS custom properties. Components must use tokens only — no hard-coded brand colours (add a lint rule).

```css
:root[data-theme="light"] {
  --brand-accent: #C8102E;            /* from admin */
  --brand-accent-hover: …;            /* derived */
  --brand-accent-contrast: #FFFFFF;   /* derived for text on accent */
  --brand-header-bg: …;  --brand-header-fg: …;
  --brand-sidebar-bg: …; --brand-sidebar-fg: …;
  --brand-focus-ring: …;
  --brand-font-family: …;
  --brand-radius: …;
  --status-todo: …; --status-inprogress: …; --status-done: …;
}
:root[data-theme="dark"] { /* derived dark equivalents */ }
```

| ID | Requirement |
|----|-------------|
| BRD-010 | Endpoint `GET /api/v1/branding/tokens` (public, cacheable, ETag) returns tokens + asset URLs + version; also inlined into the HTML shell to avoid flash of unbranded content. |
| BRD-011 | Login page and portal render branding **before authentication** (public endpoint) — therefore branding must never include confidential data. |

## 3. Workspace & portal branding (service workspaces)

| ID | Requirement |
|----|-------------|
| BRD-020 | Help-centre (global portal) branding: name, logo, banner image, accent colour (inherits instance by default), welcome message (localised), announcement. |
| BRD-021 | Per service workspace portal: name, logo, intro text, announcement. Workspace admins may edit these (no admin scope needed). |
| BRD-022 | Workspace avatars: built-in avatar set + upload (sanitised). |

## 4. Announcement banner (`/admin/branding/announcement`)

| ID | Requirement |
|----|-------------|
| BRD-030 | Rich-text (sanitised) banner with severity (info/warning/critical), localised text, audience (everyone incl. anonymous / logged-in only / specific groups), schedule (start/end), dismissible toggle (re-shows when content changes). |
| BRD-031 | **Maintenance mode** banner variant with countdown, plus optional read-only mode switch (System admin). |

## 5. Base URL & network configuration (`/admin/system/general/url`) — `scope.system.general`

| Setting | Notes |
|---------|-------|
| **Base URL** | Canonical external URL, e.g. `https://servicehub.entity.ae` or `https://apps.entity.ae/servicehub` (context path supported). |
| Portal path / URL | Default `${baseUrl}/portal`; optional separate host for customers (e.g. `https://support.entity.ae`) |
| Trusted proxies | CIDR list whose `X-Forwarded-For/Proto/Host` headers are honoured |
| Allowed origins (CORS) | Explicit list for API access from other web apps |
| Additional allowed hosts | Alternate hostnames accepted (redirect to canonical by default) |
| Enforce canonical host | Redirect requests on non-canonical hosts → base URL (301) |
| HSTS | max-age, includeSubDomains, preload |
| Cookie settings | `Secure`, `SameSite`, cookie domain derived from base URL |

| ID | Requirement |
|----|-------------|
| SYS-001 | Validation on save: absolute URL, `https` required in production (warning otherwise), no trailing slash, valid host, optional port, path normalised. |
| SYS-002 | **Reachability self-test** before save: server performs an HTTP request to `${newBaseUrl}/status` and checks it returns this instance's node/instance ID. Mismatch → warning with explanation (save still allowed by System admin). |
| SYS-003 | **Base URL mismatch detection** (Jira behaviour): if a System admin browses the app on a URL different from the configured base URL, show a dismissible banner "Base URL mismatch — Update base URL to <current>?". |
| SYS-004 | **Impact checklist** shown on change: email links, SAML ACS/Entity ID & OIDC redirect URIs (must be updated at IdP — show new values to copy), outgoing webhook callbacks, OAuth app callbacks, portal links, calendar feeds, existing links in sent emails (old host redirect recommended). |
| SYS-005 | **Every** absolute URL generated server-side (emails, notifications, webhooks, exports, SAML metadata, API `self` links) uses a single `UrlBuilder` reading the configured base URL. Generating absolute URLs from the incoming request `Host` header is forbidden (host-header injection). Add a CI check for string-concatenated hosts. |
| SYS-006 | Base URL changes are audited and broadcast cluster-wide (config cache invalidation). |

## 6. Localisation & regional settings (`/admin/system/general/localisation`)

| ID | Requirement |
|----|-------------|
| SYS-010 | Instance default language (installed language packs: `en`, `ar`), default timezone (e.g. `Asia/Dubai`), first day of week, working days, date/time formats, number format (Western/Eastern Arabic digits option), default currency. |
| SYS-011 | **RTL support**: when locale is RTL, `dir="rtl"` on root; layout uses logical CSS properties; icons with direction are mirrored; charts and the workflow designer remain LTR where semantically appropriate. |
| SYS-012 | Translatable configuration objects (statuses, resolutions, item types, priorities, custom field names/options/help, request types, portal texts, announcement, login message, email templates) store translations per locale with fallback to the default language. Admin UI shows a **translation coverage** indicator. |
| SYS-013 | All UI strings externalised in message catalogues (ICU MessageFormat for plurals/gender). |

## 7. General configuration (`/admin/system/general`)

| Setting | Default | Notes |
|---------|---------|-------|
| Mode | Private | Private (admin-created users) / Public (sign-up per IAM-037) |
| Anonymous access | Off | Enables `PUBLIC` grantee |
| Maximum attachment size | 25 MB | Plus blocked file extensions list; antivirus scan hook (ICAP/ClamAV) toggle |
| Time tracking | On | Hours per day, days per week, default unit, format |
| Item linking | On | Link types admin (name, outward/inward description) |
| Sub-items | On | |
| Voting / watching | On / On | |
| User email visibility | Show to logged-in users | Public / logged-in / hidden / masked |
| Mentions | On | |
| Rich text editor | WYSIWYG | |
| Search result limit | 1000 | |
| Default user avatar style | Initials | |
| Trash retention | 30 days | Workspaces, items, fields |
| Data retention policies | — | Per object type (audit log, delivery log, notifications, deleted items, login history); legal hold flag per workspace |
| Feature flags | — | List of `admin.v2.*` flags with status (playbook IMP-002) |

| ID | Requirement |
|----|-------------|
| SYS-020 | Settings are stored in a typed **settings store** (key, type, value, scope, updated_by, updated_at, version), cached and invalidated cluster-wide. |
| SYS-021 | Settings locked by environment (`CONFIG_LOCKED_BY_ENV`) display a lock icon and source, are read-only in the UI, and the API returns `423 Locked` on write attempts. |
| SYS-022 | **Configuration export/import** (JSON bundle) for promoting configuration between environments (test → prod): schemes, workflows, fields, screens, item types, statuses, notification templates, branding (assets included). Import offers diff + dry run + conflict resolution (by stable key, not DB ID). |
