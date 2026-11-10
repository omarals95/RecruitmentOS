/* Notifications: rules (event x recipient x channel), templates, user defaults, delivery log. Spec 07 §1, §4-§9. */
(function () {
  const RECIPIENTS = [
    { id: "assignee", label: "Assignee" },
    { id: "hm", label: "Hiring manager" },
    { id: "watchers", label: "Record watchers" },
    { id: "team", label: "Team" },
    { id: "group", label: "Group" },
    { id: "role", label: "Specific role" },
  ];
  const CHANNELS = [
    { id: "inapp", label: "In-app" },
    { id: "email", label: "Email" },
    { id: "digest", label: "Daily digest" },
  ];
  const ev = (id, group, name, desc, r, extra = {}) => ({ id, group, name, desc, r, on: { inapp: true, email: true, digest: true }, mandatory: false, userOff: { inapp: true, email: true }, groupName: "", roleName: "", ...extra });

  // Page-local sample state (kept while you click around; resets on reload).
  const S = {
    events: [
      ev("applied", "Candidates & applications", "Candidate applied", "A candidate applies or is added to a vacancy", { assignee: ["inapp", "email"], hm: ["digest"], watchers: ["inapp"], team: [], group: [], role: [] }),
      ev("stage", "Candidates & applications", "Application moved stage", "An application moves to another pipeline stage", { assignee: ["inapp"], hm: ["inapp", "digest"], watchers: ["inapp"], team: [], group: [], role: [] }, { on: { inapp: true, email: false, digest: true } }),
      ev("int-sched", "Interviews", "Interview scheduled", "An interview is booked", { assignee: ["inapp", "email"], hm: ["inapp", "email"], watchers: [], team: [], group: [], role: ["inapp", "email"] }, { roleName: "Interviewer" }),
      ev("int-change", "Interviews", "Interview changed or cancelled", "Time, place or interviewers change, or the interview is cancelled", { assignee: ["inapp", "email"], hm: ["inapp", "email"], watchers: ["inapp"], team: [], group: [], role: ["inapp", "email"] }, { roleName: "Interviewer" }),
      ev("feedback", "Interviews", "Interview feedback due", "Feedback is not in 24 hours after the interview", { assignee: [], hm: ["inapp"], watchers: [], team: [], group: [], role: ["inapp", "email"] }, { roleName: "Interviewer" }),
      ev("offer-appr", "Offers", "Offer needs approval", "An offer is sent for approval", { assignee: ["inapp"], hm: [], watchers: [], team: [], group: ["inapp", "email"], role: [] }, { mandatory: true, groupName: "offer-approvers", userOff: { inapp: false, email: false } }),
      ev("offer-dec", "Offers", "Offer approved or declined", "An approver decides, or the candidate declines", { assignee: ["inapp", "email"], hm: ["inapp", "email"], watchers: ["inapp"], team: [], group: [], role: [] }),
      ev("task", "Tasks & comments", "Task assigned", "A team task is assigned to someone", { assignee: ["inapp", "email"], hm: [], watchers: [], team: [], group: [], role: [] }),
      ev("task-due", "Tasks & comments", "Task due", "A task is due today or overdue", { assignee: ["inapp", "digest"], hm: [], watchers: [], team: [], group: [], role: [] }, { on: { inapp: true, email: false, digest: true } }),
      ev("mention", "Tasks & comments", "Mentioned in a comment", "Someone @mentions a person in a comment", { assignee: [], hm: [], watchers: [], team: [], group: [], role: [] }, { mandatory: true, mentioned: ["inapp", "email"], userOff: { inapp: false, email: false } }),
      ev("vacancy", "Vacancies & imports", "Vacancy approved", "A vacancy is approved and can be advertised", { assignee: ["inapp", "email"], hm: ["inapp", "email"], watchers: [], team: ["digest"], group: [], role: [] }),
      ev("import", "Vacancies & imports", "CV import finished", "A bulk CV import completes, with counts and errors", { assignee: ["inapp", "email"], hm: [], watchers: [], team: [], group: [], role: [] }, { on: { inapp: true, email: true, digest: false } }),
    ],
    defaults: { digestTime: "08:00", digestDays: ["Mon", "Tue", "Wed", "Thu", "Fri"], quiet: true, quietFrom: "20:00", quietTo: "07:00", own: false, batch: "10 minutes", cap: "200" },
    templates: null, // filled below
    log: null,
    filters: { status: "All", recipient: "", event: "All", channel: "All" },
    preview: { sample: 0, width: "Desktop" },
  };

  const FIELDS = [
    ["Candidate", ["candidate.name", "candidate.firstName", "candidate.email"]],
    ["Vacancy", ["vacancy.title", "vacancy.unit", "vacancy.location"]],
    ["Application", ["application.stage", "application.previousStage"]],
    ["Interview", ["interview.date", "interview.time", "interview.location", "interview.interviewers"]],
    ["Offer", ["offer.salary", "offer.startDate", "offer.decision"]],
    ["Task & comment", ["task.title", "task.due", "comment.excerpt"]],
    ["People", ["actor.name", "recipient.firstName"]],
    ["Workspace", ["team.name", "company.name", "links.view", "links.unsubscribe"]],
  ];
  const SAMPLES = [
    { label: "Fatima Al Zaabi → Senior Data Analyst", v: { "candidate.name": "Fatima Al Zaabi", "candidate.firstName": "Fatima", "candidate.email": "fatima.alzaabi@example.test", "vacancy.title": "Senior Data Analyst", "vacancy.unit": "Finance", "vacancy.location": "Dubai", "application.stage": "Interview", "application.previousStage": "Screening", "interview.date": "Wednesday 12 November 2026", "interview.time": "10:30 (Dubai time)", "interview.location": "Video call (Teams link in the invite)", "interview.interviewers": "Sara Haddad, Khalid Al Mansoori", "offer.salary": "AED 32,000 a month", "offer.startDate": "1 February 2027", "offer.decision": "Approved", "task.title": "Check references", "task.due": "Thursday 13 November", "comment.excerpt": "Strong SQL; can we move to the panel this week?", "actor.name": "Sara Haddad", "recipient.firstName": "Khalid", "team.name": "Talent Acquisition" } },
    { label: "Arjun Nair → Graduate Software Engineer", v: { "candidate.name": "Arjun Nair", "candidate.firstName": "Arjun", "candidate.email": "arjun.nair@example.test", "vacancy.title": "Graduate Software Engineer", "vacancy.unit": "Platform Engineering", "vacancy.location": "Abu Dhabi", "application.stage": "Assessment", "application.previousStage": "Interview", "interview.date": "Sunday 16 November 2026", "interview.time": "14:00 (Dubai time)", "interview.location": "Al Noor Tower, room 12B", "interview.interviewers": "Daniel Okafor", "offer.salary": "AED 14,500 a month", "offer.startDate": "7 September 2027", "offer.decision": "Declined by candidate", "task.title": "Send assessment pack", "task.due": "Today", "comment.excerpt": "@Rahul please share the coding task.", "actor.name": "Rahul Menon", "recipient.firstName": "Daniel", "team.name": "Graduate Hiring" } },
    { label: "Hannah Clarke → Head of Internal Audit", v: { "candidate.name": "Hannah Clarke", "candidate.firstName": "Hannah", "candidate.email": "hannah.clarke@example.test", "vacancy.title": "Head of Internal Audit", "vacancy.unit": "Office of the CEO", "vacancy.location": "Dubai", "application.stage": "Offer", "application.previousStage": "Assessment", "interview.date": "Monday 17 November 2026", "interview.time": "09:00 (Dubai time)", "interview.location": "Video call", "interview.interviewers": "Mariam Al Suwaidi", "offer.salary": "AED 68,000 a month", "offer.startDate": "4 January 2027", "offer.decision": "Waiting for approval", "task.title": "Book board interview", "task.due": "Friday 14 November", "comment.excerpt": "Offer is above band; needs group approval.", "actor.name": "Mariam Al Suwaidi", "recipient.firstName": "Omar", "team.name": "Executive Search" } },
  ];
  const COMMON = { "company.name": "Al Noor Holding", "links.view": "https://recruitmentos-preview.vercel.app/applications/a-2291", "links.unsubscribe": "https://recruitmentos-preview.vercel.app/me/notifications" };
  const KNOWN = new Set(FIELDS.flatMap(([, f]) => f));

  const tpl = (id, event, name, subject, body, extra = {}) => ({ id, event, name, subject, body, status: "Published", version: 1, edited: "3 Nov 2026 · Omar Alshair", ...extra });
  S.templates = [
    tpl("t-applied", "applied", "Candidate applied", "New applicant for {{vacancy.title}}: {{candidate.name}}", "Hello {{recipient.firstName}},\n\n{{candidate.name}} has applied for {{vacancy.title}} ({{vacancy.unit}}, {{vacancy.location}}).\n\nOpen the application to review the CV and move it to Screening.", { version: 3 }),
    tpl("t-stage", "stage", "Application moved stage", "{{candidate.name}} moved to {{application.stage}}", "Hello {{recipient.firstName}},\n\n{{actor.name}} moved {{candidate.name}} from {{application.previousStage}} to {{application.stage}} for {{vacancy.title}}.", { version: 2 }),
    tpl("t-int-sched", "int-sched", "Interview scheduled", "Interview booked: {{candidate.name}} on {{interview.date}}", "Hello {{recipient.firstName}},\n\nYou are on the panel to interview {{candidate.name}} for {{vacancy.title}}.\n\nWhen: {{interview.date}}, {{interview.time}}\nWhere: {{interview.location}}\nPanel: {{interview.interviewers}}\n\nPlease read the CV before the interview and add your feedback in RecruitmentOS within 24 hours.", { version: 4, status: "Draft", draftOf: 4, edited: "Today 09:12 · Sara Haddad" }),
    tpl("t-int-change", "int-change", "Interview changed or cancelled", "Change to your interview with {{candidate.name}}", "Hello {{recipient.firstName}},\n\n{{actor.name}} changed the interview with {{candidate.name}} for {{vacancy.title}}.\n\nNow: {{interview.date}}, {{interview.time}} · {{interview.location}}"),
    tpl("t-feedback", "feedback", "Interview feedback due", "Feedback needed: {{candidate.name}}", "Hello {{recipient.firstName}},\n\nYour feedback on {{candidate.name}} ({{vacancy.title}}) is due. The hiring team is waiting for it before the next step.", { version: 2 }),
    tpl("t-offer-appr", "offer-appr", "Offer needs approval", "Approve offer for {{candidate.name}}?", "Hello {{recipient.firstName}},\n\n{{actor.name}} asks you to approve an offer for {{candidate.name}} as {{vacancy.title}}.\n\nSalary: {{offer.salary}}\nStart date: {{offer.startDate}}\n\nYou can approve or decline from the offer page.", { version: 3 }),
    tpl("t-offer-dec", "offer-dec", "Offer approved or declined", "Offer for {{candidate.name}}: {{offer.decision}}", "Hello {{recipient.firstName}},\n\nThe offer for {{candidate.name}} ({{vacancy.title}}) is now: {{offer.decision}}."),
    tpl("t-task", "task", "Task assigned", "New task: {{task.title}}", "Hello {{recipient.firstName}},\n\n{{actor.name}} assigned you a task: {{task.title}}. Due {{task.due}}."),
    tpl("t-task-due", "task-due", "Task due", "Due {{task.due}}: {{task.title}}", "Hello {{recipient.firstName}},\n\nYour task “{{task.title}}” is due {{task.due}}.", { status: "Draft", edited: "Yesterday · Rahul Menon" }),
    tpl("t-mention", "mention", "Mentioned in a comment", "{{actor.name}} mentioned you on {{candidate.name}}", "Hello {{recipient.firstName}},\n\n{{actor.name}} mentioned you:\n“{{comment.excerpt}}”", { version: 2 }),
    tpl("t-vacancy", "vacancy", "Vacancy approved", "{{vacancy.title}} is approved", "Hello {{recipient.firstName}},\n\n{{vacancy.title}} in {{vacancy.unit}} is approved and can now be advertised."),
    tpl("t-import", "import", "CV import finished", "Your CV import has finished", "Hello {{recipient.firstName}},\n\nYour CV import into {{team.name}} has finished. Open the import to see what was added and any files that could not be read."),
    tpl("t-digest", "", "Daily digest", "Your RecruitmentOS summary for today", "Good morning {{recipient.firstName}},\n\nHere is what happened in {{team.name}} since yesterday.", { version: 2 }),
  ];

  const L = (id, time, event, record, name, email, channel, status, attempts, extra = {}) => ({ id, time, event, record, name, email, channel, status, attempts, provider: channel !== "In-app" ? "re_" + id.replace("d-", "") + "f2a9c1" : "—", tv: "v" + (extra.v || 2), ...extra });
  S.log = [
    L("d-4012", "Today 11:42", "Interview scheduled", "Fatima Al Zaabi · Senior Data Analyst", "Khalid Al Mansoori", "khalid.almansoori@example.test", "Email", "Delivered", 1, { why: "Hiring manager of the vacancy (Finance)" }),
    L("d-4011", "Today 11:42", "Interview scheduled", "Fatima Al Zaabi · Senior Data Analyst", "Sara Haddad", "sara.haddad@example.test", "In-app", "Delivered", 1, { why: "Assignee of the application" }),
    L("d-4010", "Today 11:05", "Mentioned in a comment", "Arjun Nair · Graduate Software Engineer", "Rahul Menon", "rahul.menon@example.test", "Email", "Delivered", 1, { why: "Mentioned in the comment (always on)" }),
    L("d-4009", "Today 10:31", "Offer needs approval", "Hannah Clarke · Head of Internal Audit", "Mariam Al Suwaidi", "mariam.alsuwaidi@example.test", "Email", "Sent", 1, { why: "Member of group offer-approvers" }),
    L("d-4008", "Today 10:31", "Offer needs approval", "Hannah Clarke · Head of Internal Audit", "Khalid Al Mansoori", "khalid.almansoori@example.test", "Email", "Failed", 3, { why: "Member of group offer-approvers", error: "Provider timeout after 30 s (Resend 504). Next automatic retry in 8 minutes." }),
    L("d-4007", "Today 09:50", "Candidate applied", "Omar Farouk · Senior Data Analyst", "Sara Haddad", "sara.haddad@example.test", "Email", "Delivered", 1, { why: "Assignee of the application" }),
    L("d-4006", "Today 08:00", "Daily digest", "12 updates", "Rahul Menon", "rahul.menon@example.test", "Daily digest", "Delivered", 1, { why: "Daily digest at 08:00 (Asia/Dubai)" }),
    L("d-4005", "Today 08:00", "Daily digest", "9 updates", "Aisha Rahman", "aisha.rahman@example.test", "Daily digest", "Bounced", 1, { why: "Daily digest at 08:00 (Asia/Dubai)", error: "Hard bounce: mailbox does not exist (550 5.1.1). Address marked as bouncing; 1 of 3 before it is suppressed." }),
    L("d-4004", "Yesterday 17:22", "CV import finished", "Import #118 · 23 CVs", "Rahul Menon", "rahul.menon@example.test", "Email", "Delivered", 1, { why: "Started the import (assignee)" }),
    L("d-4003", "Yesterday 15:10", "Application moved stage", "Arjun Nair · Graduate Software Engineer", "Daniel Okafor", "daniel.okafor@example.test", "In-app", "Sent", 1, { why: "Watching the application" }),
    L("d-4002", "Yesterday 14:03", "Task assigned", "Check references · Fatima Al Zaabi", "Layla Hassan", "layla.hassan@example.test", "Email", "Delivered", 1, { why: "Assignee of the task" }),
    L("d-4001", "Yesterday 09:30", "Vacancy approved", "Head of Internal Audit", "Mariam Al Suwaidi", "mariam.alsuwaidi@example.test", "Email", "Delivered", 1, { why: "Hiring manager of the vacancy" }),
    L("d-4000", "8 Nov 16:45", "Interview feedback due", "Hannah Clarke · Head of Internal Audit", "Daniel Okafor", "daniel.okafor@example.test", "Email", "Failed", 5, { why: "Has the Interviewer role on the interview", error: "Recipient is suspended. Not retried automatically; RecruitmentOS stopped after 5 attempts." }),
  ];

  const esc = Admin.ui.esc;
  const chLabel = (c) => (CHANNELS.find((x) => x.id === c) || {}).label || c;
  const statusTone = (s) => ({ Delivered: "ok", Sent: "info", Bounced: "warn", Failed: "bad", Queued: "" }[s] || "");
  const sw = (on, attrs = "", disabled = false) => `<label class="nt-sw"><input type="checkbox" ${on ? "checked" : ""} ${disabled ? "disabled" : ""} ${attrs}><span></span></label>`;

  const STYLE = `<style>
    .nt-sw{position:relative;display:inline-block;width:34px;height:20px;vertical-align:middle}
    .nt-sw input{position:absolute;opacity:0;inset:0;margin:0;cursor:pointer}
    .nt-sw span{position:absolute;inset:0;border-radius:999px;background:var(--border-strong);transition:background .15s;pointer-events:none}
    .nt-sw span::after{content:"";position:absolute;top:3px;inset-inline-start:3px;width:14px;height:14px;border-radius:50%;background:var(--surface);transition:inset-inline-start .15s}
    .nt-sw input:checked+span{background:var(--primary)}
    .nt-sw input:checked+span::after{inset-inline-start:17px}
    .nt-sw input:disabled+span{opacity:.5}
    .nt-sw input:focus-visible+span{outline:2px solid var(--focus);outline-offset:2px}
    .nt-chip{display:inline-flex;gap:4px;align-items:center;border:1px solid var(--border);background:var(--surface-subtle);border-radius:999px;padding:1px 8px;font-size:12px;margin:2px 4px 2px 0;white-space:nowrap}
    .nt-chip i{font-style:normal;color:var(--muted)}
    .nt-grp td{background:var(--surface-subtle);font-weight:700;font-size:12px;color:var(--muted)}
    .nt-click{cursor:pointer}
    .nt-editor{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}
    .nt-fields{display:flex;flex-wrap:wrap;gap:4px}
    .nt-fields button{font-family:ui-monospace,Consolas,monospace;font-size:11px}
    textarea.nt-body{min-height:220px;font-family:ui-monospace,Consolas,monospace;font-size:13px;resize:vertical}
    .nt-mail{direction:ltr;text-align:left;border:1px solid var(--border);border-radius:10px;background:#eef0f5;padding:16px;margin-inline:auto;transition:max-width .2s}
    .nt-mail .h{background:#4338ca;color:#fff;padding:12px 16px;border-radius:8px 8px 0 0;font-weight:700;display:flex;gap:8px;align-items:center}
    .nt-mail .h b{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:6px;background:#fff;color:#4338ca;font-size:12px}
    .nt-mail .b{background:#fff;color:#191c28;padding:16px;line-height:1.55}
    .nt-mail .b a.cta{display:inline-block;background:#4338ca;color:#fff;padding:8px 14px;border-radius:6px;margin-top:10px}
    .nt-mail .f{background:#fff;color:#606b7d;font-size:11px;padding:10px 16px 14px;border-top:1px solid #e1e5ed;border-radius:0 0 8px 8px}
    .nt-subj{font-weight:700;margin-bottom:8px}
    .nt-kv{display:grid;grid-template-columns:140px 1fr;gap:6px 12px;margin:0}
    .nt-kv dt{color:var(--muted)}
    .nt-kv dd{margin:0}
    .nt-steps{list-style:none;padding:0;margin:0}
    .nt-steps li{padding:6px 0;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:center}
    @media (max-width:1100px){.nt-editor{grid-template-columns:1fr}}
  </style>`;

  // ---------- Rules ----------
  function recipientChips(e) {
    const chips = RECIPIENTS.filter((r) => (e.r[r.id] || []).length).map((r) => {
      const who = r.id === "group" ? `Group: ${e.groupName}` : r.id === "role" ? `Role: ${e.roleName}` : r.label;
      return `<span class="nt-chip">${esc(who)} <i>· ${e.r[r.id].map(chLabel).join(", ")}</i></span>`;
    });
    if (e.mentioned) chips.unshift(`<span class="nt-chip">Mentioned person <i>· ${e.mentioned.map(chLabel).join(", ")}</i></span>`);
    return chips.join("") || `<span class="muted small">Nobody yet</span>`;
  }
  function rulesTab() {
    let lastGroup = "";
    const rows = S.events.map((e) => {
      const grp = e.group !== lastGroup ? `<tr class="nt-grp"><td colspan="6">${esc(e.group)}</td></tr>` : "";
      lastGroup = e.group;
      return `${grp}<tr>
        <td><b>${esc(e.name)}</b>${e.mandatory ? ` ${Admin.ui.badge("Always on", "info")}` : ""}<div class="small muted">${esc(e.desc)}</div></td>
        <td>${recipientChips(e)}</td>
        ${CHANNELS.map((c) => `<td style="text-align:center">${sw(e.on[c.id], `aria-label="${esc(e.name)}: ${c.label}" onchange="NtfPage.toggleChannel('${e.id}','${c.id}',this.checked)"`, e.mandatory && c.id !== "digest")}</td>`).join("")}
        <td>${Admin.ui.btn("Edit", { kind: "sm", attrs: `onclick="NtfPage.editRule('${e.id}')"` })}</td></tr>`;
    }).join("");
    return `<div class="callout" style="margin-bottom:12px">Rules decide <b>who</b> hears about each event and <b>how</b>. People only get a notification for records they can see. Switch a channel off here to turn it off for everyone.</div>
      <div class="toolbar"><span class="muted small"><bdi>12 events · 6 kinds of recipient · 3 channels</bdi></span><span style="flex:1"></span>
        ${Admin.ui.btn("Who gets notified?", { kind: "ghost", ic: "help", attrs: `onclick="NtfPage.helper()"` })}</div>
      <div class="table-wrap"><table class="t"><thead><tr><th style="width:26%">Event</th><th>Recipients · channels</th>${CHANNELS.map((c) => `<th style="text-align:center;width:90px">${c.label}</th>`).join("")}<th style="width:60px"></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  function ruleDrawer(id) {
    const e = S.events.find((x) => x.id === id);
    const rows = RECIPIENTS.map((r) => {
      let label = r.label;
      if (r.id === "group") label += ` ${Admin.ui.select(["offer-approvers", "hr-leadership", "recruiters", "hiring-managers", "interviewers"], e.groupName || "recruiters", `id="nt-rg" style="width:auto;margin-inline-start:6px"`)}`;
      if (r.id === "role") label += ` ${Admin.ui.select(["Interviewer", "Hiring manager", "Recruiter", "Admin", "Recruiter, no CV upload"], e.roleName || "Recruiter", `id="nt-rr" style="width:auto;margin-inline-start:6px"`)}`;
      return `<tr><td>${r.id === "group" || r.id === "role" ? label : esc(r.label) + (r.id === "team" ? ` <span class="small muted">(everyone in the record's team)</span>` : "")}</td>${CHANNELS.map((c) => `<td style="text-align:center"><input type="checkbox" data-r="${r.id}" data-c="${c.id}" ${(e.r[r.id] || []).includes(c.id) ? "checked" : ""} aria-label="${esc(r.label)} by ${c.label}"></td>`).join("")}</tr>`;
    }).join("");
    Admin.drawer(`<div class="row" style="justify-content:space-between"><h2 style="margin:0">Edit rule</h2>${Admin.ui.btn("Close", { kind: "ghost", attrs: `onclick="Admin.close()"` })}</div>
      <p class="muted" style="margin-top:4px"><b>${esc(e.name)}</b> · ${esc(e.desc)}</p>
      ${e.mentioned ? `<div class="callout" style="margin-bottom:12px">The mentioned person always gets this in-app and by email. You can add more people below.</div>` : ""}
      <h3>Who gets it, and how</h3>
      <div class="table-wrap"><table class="t"><thead><tr><th>Recipient</th>${CHANNELS.map((c) => `<th style="text-align:center">${c.label}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>
      <div style="margin-top:14px">
      ${Admin.ui.check("Always on: people cannot turn this off (use for approvals and mentions)", e.mandatory, `id="nt-rm"`)}<br>
      ${Admin.ui.check("Also notify the person who made the change", false)}</div>
      <div style="margin-top:12px">${Admin.ui.field("Email template", `<a href="#/notifications?tab=templates&tpl=${(S.templates.find((t) => t.event === e.id) || {}).id || ""}" onclick="Admin.close()">${esc(e.name)}</a>`, "Templates are shared by all teams.")}</div>
      <div class="callout warn small" style="margin-bottom:12px">Applies to all 3 teams. About 40 notifications a week come from this event.</div>
      <div class="row">${Admin.ui.btn("Save rule", { kind: "primary", attrs: `onclick="NtfPage.saveRule('${e.id}')"` })}${Admin.ui.btn("Cancel", { attrs: `onclick="Admin.close()"` })}</div>`);
  }

  // ---------- Templates ----------
  function render(text, sample, over = {}) {
    const v = { ...COMMON, ...SAMPLES[sample].v, ...over };
    return esc(text).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => (k in v ? `<span>${esc(v[k])}</span>` : `<mark title="Unknown field">${esc(m)}</mark>`)).replace(/\n/g, "<br>");
  }
  function unknownFields(t) {
    return [...new Set([...(t.subject + " " + t.body).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).filter((k) => !KNOWN.has(k)))];
  }
  function previewHtml(t, over = {}) {
    const unk = unknownFields(t);
    return `${unk.length ? `<div class="callout warn small" style="margin-bottom:8px">Unknown field${unk.length > 1 ? "s" : ""}: ${unk.map((u) => `<code>{{${esc(u)}}}</code>`).join(" ")}. ${unk.length > 1 ? "They" : "It"} will show as blank.</div>` : ""}
      <div class="nt-mail" style="max-width:${S.preview.width === "Mobile" ? "360px" : "600px"}">
        <div class="small" style="color:#606b7d;margin-bottom:6px">From: RecruitmentOS · Al Noor Holding &lt;no-reply@recruitmentos.ae&gt;</div>
        <div class="nt-subj" style="color:#191c28">${render(t.subject, S.preview.sample, over)}</div>
        <div class="h"><b>R</b>RecruitmentOS</div>
        <div class="b">${render(t.body, S.preview.sample, over)}<br><a class="cta" href="javascript:void 0">Open in RecruitmentOS</a></div>
        <div class="f">Al Noor Holding (fictional) · Dubai, United Arab Emirates<br>You get this because of your role on this record. <u>Change what you receive</u></div>
      </div>`;
  }
  function templatesTab(ctx) {
    const id = ctx.query.get("tpl");
    const t = S.templates.find((x) => x.id === id);
    if (t) return templateEditor(t);
    const rows = S.templates.map((x) => [
      `<a href="#/notifications?tab=templates&tpl=${x.id}"><b>${esc(x.name)}</b></a>`,
      x.event ? esc(S.events.find((e) => e.id === x.event).name) : `<span class="muted">Daily digest</span>`,
      "Email",
      x.status === "Draft" ? (x.draftOf ? Admin.ui.badge("Draft of v" + (x.draftOf + 1), "warn") + " " + Admin.ui.badge("v" + x.version + " live", "ok") : Admin.ui.badge("Draft · never published", "warn")) : Admin.ui.badge("Published v" + x.version, "ok"),
      `<span class="small muted">${esc(x.edited)}</span>`,
    ]);
    return `<div class="toolbar"><span class="muted small">Every email uses the company branding (logo, colour, footer) from Look &amp; feel. Templates write the message only.</span><span style="flex:1"></span>${Admin.ui.btn("Edit email branding", { kind: "ghost", ic: "palette", attrs: `onclick="Admin.navigate('branding')"` })}</div>
      ${Admin.ui.table(["Template", "Event", "Channel", "Status", "Last edited"], rows)}`;
  }
  function fieldPicker() {
    return FIELDS.map(([g, list]) => `<div style="margin-bottom:6px"><div class="small muted">${esc(g)}</div><div class="nt-fields">${list.map((f) => `<button class="btn sm" type="button" data-field="${f}" title="Insert {{${f}}}">{{${f}}}</button>`).join("")}</div></div>`).join("");
  }
  function templateEditor(t) {
    const badge = t.status === "Draft" ? Admin.ui.badge("Draft", "warn") : Admin.ui.badge("Published v" + t.version, "ok");
    return `<div class="crumbs"><a href="#/notifications?tab=templates">Templates</a> › ${esc(t.name)}</div>
      <div class="row" style="justify-content:space-between;margin-bottom:12px">
        <div class="row"><h2 style="margin:0">${esc(t.name)}</h2><span id="nt-badge">${badge}</span><span class="small muted">Last edited ${esc(t.edited)}</span></div>
        <div class="row">${Admin.ui.btn("Send test to me", { ic: "mail", attrs: `onclick="NtfPage.sendTest()"` })}${Admin.ui.btn("Save draft", { attrs: `onclick="NtfPage.saveDraft('${t.id}')"` })}${Admin.ui.btn("Publish", { kind: "primary", attrs: `onclick="NtfPage.publish('${t.id}')"` })}</div>
      </div>
      <div class="nt-editor">
        <div class="card">
          ${Admin.ui.field("Subject", `<input class="input" id="nt-subject" value="${esc(t.subject)}" data-tid="${t.id}">`)}
          ${Admin.ui.field("Message", `<textarea class="input nt-body" id="nt-body" data-tid="${t.id}">${esc(t.body)}</textarea>`, "Plain text. Line breaks are kept. The “Open in RecruitmentOS” button and footer are added for you.")}
          <h3>Insert a merge field</h3><p class="small muted" style="margin:0 0 8px">Click to insert at the cursor. Fields a recipient cannot see are left blank for them.</p>
          ${fieldPicker()}
        </div>
        <div class="card">
          <div class="row" style="justify-content:space-between;margin-bottom:10px"><h3 style="margin:0">Live preview</h3>
            <div class="row">${Admin.ui.select(SAMPLES.map((s) => s.label), SAMPLES[S.preview.sample].label, `id="nt-sample" aria-label="Sample record" style="width:auto"`)}
            ${Admin.ui.select(["Desktop", "Mobile"], S.preview.width, `id="nt-width" aria-label="Preview width" style="width:auto"`)}</div></div>
          <div id="nt-preview">${previewHtml(t)}</div>
          <p class="small muted">Version history: v${t.version} published ${t.version > 1 ? "3 Nov 2026" : "20 Oct 2026"} by Omar Alshair${t.version > 1 ? ` · v${t.version - 1} 14 Oct 2026` : ""}. <a href="#/audit?area=Notifications">See changes in the audit log</a></p>
        </div>
      </div>`;
  }

  // ---------- User defaults ----------
  function defaultsTab() {
    const d = S.defaults;
    const rows = S.events.map((e) => [
      `<b>${esc(e.name)}</b>`,
      e.mandatory ? `<span class="small muted">Always on</span>` : Admin.ui.check("In-app", e.userOff.inapp, `onchange="NtfPage.userOff('${e.id}','inapp',this.checked)"`),
      e.mandatory ? `<span class="small muted">Always on</span>` : Admin.ui.check("Email", e.userOff.email, `onchange="NtfPage.userOff('${e.id}','email',this.checked)"`),
      e.mandatory ? Admin.ui.badge("Locked", "info") : Admin.ui.badge("Users choose", ""),
    ]);
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const times = ["06:00", "07:00", "08:00", "09:00", "10:00", "17:00", "18:00", "19:00", "20:00", "21:00", "22:00"];
    return `<div class="split">
      <div><h2>What people can turn off</h2><p class="muted" style="margin-top:0">Ticked channels can be switched off by each person in their own settings. Mentions and offer approvals stay on for everyone.</p>
        ${Admin.ui.table(["Event", "Users can turn off", "", ""], rows)}</div>
      <div class="stack">
        <div class="card"><h2>Daily digest</h2>
          ${Admin.ui.field("Send at", Admin.ui.select(["06:00", "07:00", "08:00", "09:00", "10:00"], d.digestTime, `onchange="NtfPage.def('digestTime',this.value)"`), "Asia/Dubai (UTC+4). People can pick their own time.")}
          <div class="field"><label>On these days</label><div class="row">${days.map((x) => Admin.ui.check(x, d.digestDays.includes(x), `onchange="NtfPage.day('${x}',this.checked)"`)).join("")}</div></div>
          ${Admin.ui.field("Combine updates to the same record within", Admin.ui.select(["Off", "5 minutes", "10 minutes", "30 minutes"], d.batch), "Five changes in ten minutes become one email.")}
        </div>
        <div class="card"><h2>Quiet hours</h2>
          <div class="row" style="justify-content:space-between">${Admin.ui.check("Use quiet hours by default", d.quiet, `onchange="NtfPage.def('quiet',this.checked)"`)}</div>
          <div class="grid g2" style="margin-top:10px">${Admin.ui.field("From", Admin.ui.select(times, d.quietFrom, d.quiet ? "" : "disabled"))}${Admin.ui.field("To", Admin.ui.select(["05:00", "06:00", "07:00", "08:00"], d.quietTo, d.quiet ? "" : "disabled"))}</div>
          <p class="small muted" style="margin:0">Time zone: <b>Asia/Dubai (UTC+4)</b>. During quiet hours in-app notifications arrive silently and emails wait for the next digest. Always-on emails still go straight away.</p>
        </div>
        <div class="card"><h2>Other</h2>
          ${Admin.ui.check("Tell people about their own changes", d.own)}<br><br>
          ${Admin.ui.field("Email limit per person", `<div class="row">${Admin.ui.input(d.cap, `style="width:90px" inputmode="numeric"`)}<span class="muted">emails an hour, then the rest go into the digest</span></div>`)}
          <div class="row">${Admin.ui.btn("Save defaults", { kind: "primary", attrs: `onclick="Admin.toast('Saved (mockup). Applies to 8 people who have not changed their own settings.')"` })}</div>
        </div>
      </div></div>`;
  }

  // ---------- Delivery log ----------
  function filteredLog() {
    const f = S.filters, q = f.recipient.trim().toLowerCase();
    return S.log.filter((l) => (f.status === "All" || l.status === f.status) && (f.event === "All" || l.event === f.event) && (f.channel === "All" || l.channel === f.channel) && (!q || (l.name + " " + l.email).toLowerCase().includes(q)));
  }
  function logRows() {
    const rows = filteredLog();
    if (!rows.length) return `<div class="card state">${Admin.icon("inbox")}<h2>No deliveries match</h2><p class="muted">Try a different status, event or recipient.</p>${Admin.ui.btn("Clear filters", { attrs: `onclick="NtfPage.clearFilters()"` })}</div>`;
    return `<div class="table-wrap"><table class="t"><thead><tr><th>Time</th><th>Event</th><th>Record</th><th>Recipient</th><th>Channel</th><th>Status</th><th>Tries</th></tr></thead><tbody>${rows.map((l) => `
      <tr class="nt-click" tabindex="0" onclick="NtfPage.logDrawer('${l.id}')" onkeydown="if(event.key==='Enter')NtfPage.logDrawer('${l.id}')">
        <td class="small"><bdi>${esc(l.time)}</bdi></td><td>${esc(l.event)}</td><td class="small">${esc(l.record)}</td>
        <td><div class="row" style="flex-wrap:nowrap">${Admin.ui.avatar(l.name)}<div><div>${esc(l.name)}</div><div class="small muted">${esc(l.email)}</div></div></div></td>
        <td>${esc(l.channel)}</td><td>${Admin.ui.badge(l.status, statusTone(l.status))}</td><td>${l.attempts}</td></tr>`).join("")}</tbody></table></div>
      <p class="small muted"><bdi>${rows.length} of ${S.log.length} deliveries shown.</bdi></p>`;
  }
  function logTab() {
    const f = S.filters;
    const events = ["All", ...new Set(S.log.map((l) => l.event))];
    return `<div class="toolbar">
        ${Admin.ui.select(["All", "Sent", "Delivered", "Bounced", "Failed", "Queued"], f.status, `id="nt-f-status" aria-label="Status"`).replace(/>All</, ">All statuses<")}
        <input class="input" id="nt-f-rec" placeholder="Recipient name or email" value="${esc(f.recipient)}" aria-label="Recipient">
        ${Admin.ui.select(events, f.event, `id="nt-f-event" aria-label="Event"`).replace(/>All</, ">All events<")}
        ${Admin.ui.select(["All", "Email", "In-app", "Daily digest"], f.channel, `id="nt-f-channel" aria-label="Channel"`).replace(/>All</, ">All channels<")}
        <span style="flex:1"></span>${Admin.ui.btn("Export CSV", { ic: "log", attrs: `onclick="Admin.toast('Exported ' + document.querySelectorAll('#nt-log tbody tr').length + ' rows (mockup). The export is recorded in the audit log.')"` })}
      </div>
      <div id="nt-log">${logRows()}</div>
      <p class="small muted">Message content is kept for 90 days and delivery details for 1 year. Failed emails are retried automatically up to 5 times, waiting longer each time.</p>`;
  }
  function logDrawer(id) {
    const l = S.log.find((x) => x.id === id);
    const canRetry = l.status === "Failed" || l.status === "Bounced";
    const tries = Array.from({ length: l.attempts }, (_, i) => `<li>${Admin.ui.badge("Try " + (i + 1), i === l.attempts - 1 ? statusTone(l.status) : "bad")}<span class="small">${i === l.attempts - 1 ? esc(l.status) : "Timed out"}${i === 0 ? " · " + esc(l.time) : ` · +${2 ** i} min`}</span></li>`).join("");
    const t = S.templates.find((x) => x.name === l.event) || S.templates[S.templates.length - 1];
    Admin.drawer(`<div class="row" style="justify-content:space-between"><h2 style="margin:0">Delivery ${esc(l.id)}</h2>${Admin.ui.btn("Close", { kind: "ghost", attrs: `onclick="Admin.close()"` })}</div>
      <div class="row" style="margin:6px 0 14px">${Admin.ui.badge(l.status, statusTone(l.status))}<span class="muted small">${esc(l.channel)} · ${esc(l.time)} (Dubai time)</span></div>
      ${l.error ? `<div class="callout ${l.status === "Bounced" ? "warn" : "bad"}" style="margin-bottom:12px">${esc(l.error)}</div>` : ""}
      <dl class="nt-kv">
        <dt>Event</dt><dd>${esc(l.event)}</dd>
        <dt>Record</dt><dd>${esc(l.record)}</dd>
        <dt>Recipient</dt><dd>${esc(l.name)} · ${esc(l.email)}</dd>
        <dt>Why this person</dt><dd>${esc(l.why)}</dd>
        <dt>Template</dt><dd>${esc(t.name)} · ${esc(l.tv)}</dd>
        <dt>Provider</dt><dd>${l.channel === "In-app" ? "In-app" : "Resend"}</dd>
        <dt>Message ID</dt><dd><code>${esc(l.provider)}</code></dd>
      </dl>
      <h3 style="margin-top:16px">Attempts</h3><ul class="nt-steps">${tries}</ul>
      <h3 style="margin-top:16px">Message as sent</h3>
      <div style="transform:scale(.92);transform-origin:top">${previewHtml(t, { "recipient.firstName": l.name.split(" ")[0] })}</div>
      <div class="row" style="margin-top:12px">
        ${canRetry ? Admin.ui.btn("Retry now", { kind: "primary", attrs: `onclick="NtfPage.retry('${l.id}')"` }) : Admin.ui.btn("Retry now", { attrs: "disabled title='Only failed or bounced messages can be retried'" })}
        ${Admin.ui.btn("Open in audit log", { kind: "ghost", attrs: `onclick="Admin.close();Admin.navigate('audit?area=Notifications')"` })}</div>
      ${l.status === "Bounced" ? `<p class="small muted">Check the address with ${esc(l.name.split(" ")[0])} first. After 3 hard bounces the address is suppressed and flagged on the user's profile.</p>` : ""}`);
  }

  // ---------- handlers ----------
  window.NtfPage = {
    toggleChannel(id, ch, on) {
      const e = S.events.find((x) => x.id === id); e.on[ch] = on;
      Admin.toast(`${e.name}: ${chLabel(ch)} ${on ? "on" : "off"} for everyone (mockup)`);
    },
    editRule: ruleDrawer,
    saveRule(id) {
      const e = S.events.find((x) => x.id === id);
      RECIPIENTS.forEach((r) => (e.r[r.id] = [...document.querySelectorAll(`.drawer input[data-r="${r.id}"]:checked`)].map((n) => n.dataset.c)));
      const g = document.getElementById("nt-rg"), rr = document.getElementById("nt-rr"), m = document.getElementById("nt-rm");
      if (g) e.groupName = g.value; if (rr) e.roleName = rr.value; if (m) e.mandatory = m.checked;
      Admin.close(); Admin.rerender(); Admin.toast(`Rule “${e.name}” saved (mockup)`);
    },
    helper() {
      Admin.modal(`<h2>Who gets notified?</h2><p class="muted" style="margin-top:0">Pick a person, an event and a record to see if they would hear about it, and why.</p>
        <div class="grid g3">${Admin.ui.field("Person", Admin.ui.select(window.MockData.users.map((u) => u.name), "Khalid Al Mansoori", `id="nh-u"`))}
        ${Admin.ui.field("Event", Admin.ui.select(S.events.map((e) => e.name), "Interview scheduled", `id="nh-e"`))}
        ${Admin.ui.field("Record", Admin.ui.select(SAMPLES.map((s) => s.label), SAMPLES[0].label, `id="nh-r"`))}</div>
        <div id="nh-out"></div><div class="row" style="margin-top:12px">${Admin.ui.btn("Check", { kind: "primary", attrs: `onclick="NtfPage.helperRun()"` })}${Admin.ui.btn("Close", { attrs: `onclick="Admin.close()"` })}</div>`);
      NtfPage.helperRun();
    },
    helperRun() {
      const u = document.getElementById("nh-u").value, en = document.getElementById("nh-e").value;
      const e = S.events.find((x) => x.name === en);
      const user = window.MockData.users.find((x) => x.name === u);
      let out;
      if (user.status !== "Active") out = `<div class="callout bad"><b>No.</b> ${esc(u)} is ${esc(user.status.toLowerCase())}, so gets nothing.</div>`;
      else if (u === "Khalid Al Mansoori" || u === "Mariam Al Suwaidi") {
        const ch = (e.r.hm || []).filter((c) => e.on[c]);
        out = ch.length ? `<div class="callout ok"><b>Yes: ${ch.map(chLabel).join(" and ")}.</b> ${esc(u)} is the hiring manager of the vacancy, and the rule “${esc(e.name)} → Hiring manager” is on.</div>` : `<div class="callout warn"><b>No.</b> The rule for “${esc(e.name)}” does not include the hiring manager.</div>`;
      } else if (u === "Sara Haddad") {
        const ch = (e.r.assignee || []).filter((c) => e.on[c]);
        out = ch.length ? `<div class="callout ok"><b>Yes: ${ch.map(chLabel).join(" and ")}.</b> Sara is the assignee of this application.</div>` : `<div class="callout warn"><b>No.</b> The rule for “${esc(e.name)}” does not include the assignee.</div>`;
      } else out = `<div class="callout warn"><b>No.</b> ${esc(u)} has no role on this record (not assignee, hiring manager or watcher) and is not in a group or role named in the rule.</div>`;
      document.getElementById("nh-out").innerHTML = out + `<p class="small muted">Checked in order: rule → can see the record → person's own settings → quiet hours.</p>`;
    },
    sendTest() { Admin.toast("Test email sent to omar.alshair@example.test with the sample record (mockup)"); },
    saveDraft(id) {
      const t = S.templates.find((x) => x.id === id);
      if (t.status !== "Draft") { t.draftOf = t.version; t.status = "Draft"; }
      t.edited = "Just now · Omar Alshair"; Admin.rerender(); Admin.toast("Draft saved. People still get the published version.");
    },
    publish(id) {
      const t = S.templates.find((x) => x.id === id);
      const unk = unknownFields(t);
      Admin.modal(`<h2>Publish “${esc(t.name)}”?</h2>
        <ul><li>Used by 1 rule in all 3 teams</li><li>About 40 emails a week use this template</li><li>Becomes version ${t.status === "Draft" && !t.draftOf ? 1 : t.version + 1}; you can go back to v${t.version} at any time</li></ul>
        ${unk.length ? `<div class="callout warn" style="margin-bottom:12px">${unk.length} unknown merge field${unk.length > 1 ? "s" : ""} will show as blank: ${unk.map((u) => `<code>{{${esc(u)}}}</code>`).join(" ")}</div>` : `<div class="callout ok" style="margin-bottom:12px">Email check passed: works in light and dark mail apps, under 600 px wide.</div>`}
        <div class="row">${Admin.ui.btn("Publish", { kind: "primary", attrs: `onclick="NtfPage.doPublish('${t.id}')"` })}${Admin.ui.btn("Cancel", { attrs: `onclick="Admin.close()"` })}</div>`);
    },
    doPublish(id) {
      const t = S.templates.find((x) => x.id === id);
      t.version = t.status === "Draft" && !t.draftOf ? 1 : t.version + 1; t.status = "Published"; t.draftOf = 0; t.edited = "Just now · Omar Alshair";
      Admin.close(); Admin.rerender(); Admin.toast(`Published v${t.version} (mockup). Recorded in the audit log.`);
    },
    userOff(id, ch, on) { S.events.find((x) => x.id === id).userOff[ch] = on; },
    def(k, v) { S.defaults[k] = v; if (k === "quiet") Admin.rerender(); },
    day(d, on) { const a = S.defaults.digestDays; if (on && !a.includes(d)) a.push(d); if (!on) S.defaults.digestDays = a.filter((x) => x !== d); },
    logDrawer,
    retry(id) {
      const l = S.log.find((x) => x.id === id); l.status = "Queued"; l.attempts += 1; l.error = "";
      Admin.close(); const box = document.getElementById("nt-log"); if (box) box.innerHTML = logRows();
      Admin.toast("Queued for another try (mockup). The retry is recorded in the audit log.");
    },
    clearFilters() { S.filters = { status: "All", recipient: "", event: "All", channel: "All" }; Admin.rerender(); },
  };

  Admin.register({
    id: "notifications",
    group: "Communication",
    title: "Notifications",
    icon: "bell",
    spec: ["NTF-001", "NTF-002", "NTF-003", "NTF-010", "NTF-011", "NTF-012", "NTF-014", "NTF-015", "NTF-020", "NTF-021", "NTF-022", "NTF-023", "NTF-030", "NTF-031", "NTF-032", "NTF-033", "NTF-040", "NTF-041", "NTF-043", "NTF-044", "NTF-045"],
    changes: "New. Today notifications are fixed in code; admins can now choose who hears about each event on which channel, edit email wording, set defaults and see every delivery.",
    render(ctx) {
      const { ui } = ctx;
      const tab = ctx.query.get("tab") || "rules";
      const head = ui.pageHeader("Notifications", "Choose who hears about what, how they hear it, and check what was actually sent. Settings apply to every team.",
        ui.btn("Delivery log", { ic: "list", attrs: `onclick="Admin.navigate('notifications?tab=log')"` }));
      if (ctx.state !== "normal") return head + ui.stateBlock(ctx.state, { emptyTitle: "No notification rules yet", emptyText: "Start from the recommended rules: applicants, interviews, offers, tasks and mentions.", emptyAction: ui.btn("Add recommended rules", { kind: "primary", attrs: `onclick="Admin.toast('Recommended rules added (mockup)')"` }) });
      const failed = S.log.filter((l) => l.status === "Failed" || l.status === "Bounced").length;
      const kpis = `<div class="grid g4" style="margin-bottom:16px">
        ${ui.kpi("Sent today", "169", "<bdi>41 email · 128 in-app</bdi>")}
        ${ui.kpi("Failed or bounced (7 days)", String(failed), `<a href="#/notifications?tab=log">${failed ? "Review in delivery log" : "None"}</a>`)}
        ${ui.kpi("Waiting to send", "0", "Oldest: none waiting")}
        ${ui.kpi("Daily digest", S.defaults.digestTime, "Asia/Dubai · 6 people use it")}</div>`;
      const tabs = ui.tabs("ntf", [{ id: "rules", label: "Rules" }, { id: "templates", label: "Templates" }, { id: "defaults", label: "User defaults" }, { id: "log", label: "Delivery log" }], tab);
      const body = tab === "templates" ? templatesTab(ctx) : tab === "defaults" ? defaultsTab() : tab === "log" ? logTab() : rulesTab();
      return STYLE + head + kpis + tabs + body;
    },
    mount(root, ctx) {
      // Template editor: live preview and merge-field picker
      const subj = root.querySelector("#nt-subject"), body = root.querySelector("#nt-body");
      if (subj && body) {
        const t = S.templates.find((x) => x.id === subj.dataset.tid);
        let last = body;
        const refresh = () => {
          t.subject = subj.value; t.body = body.value;
          root.querySelector("#nt-preview").innerHTML = previewHtml(t);
          if (t.status !== "Draft") root.querySelector("#nt-badge").innerHTML = Admin.ui.badge("Unsaved changes", "warn");
        };
        [subj, body].forEach((el) => { el.addEventListener("input", refresh); el.addEventListener("focus", () => (last = el)); });
        root.querySelectorAll("[data-field]").forEach((b) => b.addEventListener("click", () => {
          const ins = `{{${b.dataset.field}}}`, s = last.selectionStart ?? last.value.length, e = last.selectionEnd ?? s;
          last.value = last.value.slice(0, s) + ins + last.value.slice(e);
          last.focus(); last.setSelectionRange(s + ins.length, s + ins.length); refresh();
        }));
        root.querySelector("#nt-sample").addEventListener("change", (e) => { S.preview.sample = SAMPLES.findIndex((x) => x.label === e.target.value); refresh(); });
        root.querySelector("#nt-width").addEventListener("change", (e) => { S.preview.width = e.target.value; refresh(); });
      }
      // Delivery log filters (update the table only, so typing keeps focus)
      const box = root.querySelector("#nt-log");
      if (box) {
        const map = { "nt-f-status": "status", "nt-f-event": "event", "nt-f-channel": "channel", "nt-f-rec": "recipient" };
        Object.entries(map).forEach(([id, k]) => {
          const el = root.querySelector("#" + id);
          el.addEventListener(el.tagName === "INPUT" ? "input" : "change", () => {
            S.filters[k] = el.tagName === "SELECT" ? el.value.replace(/^All .*/, "All") : el.value;
            box.innerHTML = logRows();
          });
        });
      }
    },
  });
})();
