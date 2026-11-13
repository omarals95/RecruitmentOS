/* Workflows: list, workflow schemes, statuses, and the drag-and-drop designer
   (side panel, problems, test run, draft/publish with migration wizard). Page-specific data lives here. */
(function () {
  const ui = Admin.ui, esc = ui.esc;
  const NW = 140, NH = 46, VB_W = 900, VB_H = 470, GRID = 10;
  const CAT_LABEL = { todo: "To do", prog: "In progress", done: "Done" };
  const GROUP_SIZES = { "offer-approvers": 2, "hr-leadership": 2, "hiring-managers": 1, recruiters: 3, interviewers: 2, "system-administrators": 1 };
  const GROUPS = Object.keys(GROUP_SIZES);
  const APPROVAL_GROUPS = ["offer-approvers"];
  const FIELDS = ["CV", "Interview feedback", "Assessment score", "Salary (AED)", "Start date", "Rejection reason", "Notice period", "Offer status"];
  const ROLES = ["Viewer", "Recruiter", "Admin", "Owner"];
  const COND = {
    group: "User is in group",
    notEmpty: "Field is not empty",
    hiringManager: "Only the hiring manager of the vacancy",
    notCreator: "Not the person who added the record",
    teamRole: "User has team role (or higher)",
  };
  const POST = { setField: "Set field", notify: "Notify", assign: "Assign to" };
  const NOTIFY = ["Candidate", "Hiring manager", "Assigned recruiter", "Team owners", "Group: offer-approvers"];
  const ASSIGN = ["Person who moved it", "Hiring manager", "Round robin in the team", "Team owner"];
  const SCREENS = ["No screen", "Rejection reason screen", "Offer details screen", "Interview feedback screen"];
  const PERSON_ONLY = ["Hired", "Rejected"];

  const clone = (o) => JSON.parse(JSON.stringify(o));
  let seq = 100;
  const nid = (p) => p + "_" + ++seq;
  const st = (id, name, cat, x, y) => ({ id, name, cat, x, y });
  const tr = (id, from, to, name, o = {}) =>
    Object.assign({ id, from, to, name, screen: "No screen", condOp: "AND", conditions: [], validators: { fields: [], cv: false, comment: false }, post: [], approval: null }, o);

  // ---------- sample workflows ----------
  function pipeline(mid, midVerb) {
    return {
      initial: "s_app",
      statuses: [st("s_app", "Applied", "todo", 40, 50), st("s_scr", "Screening", "prog", 270, 50), st("s_int", "Interview", "prog", 500, 50),
        st("s_ass", mid, "prog", 730, 50), st("s_off", "Offer", "prog", 500, 230), st("s_hir", "Hired", "done", 730, 230), st("s_rej", "Rejected", "done", 270, 390)],
      transitions: [
        tr("t_scr", "s_app", "s_scr", "Start screening", { conditions: [{ type: "teamRole", v: "Recruiter" }], post: [{ type: "assign", a: "Person who moved it" }] }),
        tr("t_int", "s_scr", "s_int", "Shortlist", { validators: { fields: [], cv: true, comment: false }, post: [{ type: "notify", a: "Candidate" }] }),
        tr("t_ass", "s_int", "s_ass", midVerb, { conditions: [{ type: "notEmpty", v: "Interview feedback" }] }),
        tr("t_off1", "s_ass", "s_off", "Make offer", { validators: { fields: ["Assessment score"], cv: false, comment: false } }),
        tr("t_off2", "s_int", "s_off", "Skip to offer", { conditions: [{ type: "hiringManager" }] }),
        tr("t_hir", "s_off", "s_hir", "Mark as hired", { screen: "Offer details screen", validators: { fields: ["Salary (AED)", "Start date"], cv: true, comment: false },
          approval: { group: "offer-approvers", quorum: "any", n: 2, onReject: "s_int", noSelf: true },
          post: [{ type: "setField", a: "Offer status", b: "Accepted" }, { type: "notify", a: "Hiring manager" }, { type: "notify", a: "Team owners" }] }),
        tr("t_rej", "*", "s_rej", "Reject", { screen: "Rejection reason screen", validators: { fields: ["Rejection reason"], cv: false, comment: true }, post: [{ type: "notify", a: "Candidate" }] }),
        tr("t_rec", "s_rej", "s_scr", "Reconsider", { conditions: [{ type: "group", v: "hr-leadership" }] }),
      ],
    };
  }
  function engineeringDraft() {
    const g = pipeline("Assessment", "Send assessment");
    g.transitions = g.transitions.filter((t) => t.id !== "t_off1"); // draft lost the way out of Assessment
    g.transitions.find((t) => t.id === "t_hir").approval.group = "";
    return g;
  }
  function vacancyGraph() {
    return {
      initial: "v_dr",
      statuses: [st("v_dr", "Draft", "todo", 40, 50), st("v_aw", "Awaiting approval", "prog", 270, 50), st("v_ap", "Approved", "prog", 500, 50),
        st("v_op", "Open", "prog", 730, 50), st("v_fi", "Filled", "done", 730, 230), st("v_ca", "Cancelled", "done", 270, 390)],
      transitions: [
        tr("vt1", "v_dr", "v_aw", "Submit", { validators: { fields: ["Salary (AED)"], cv: false, comment: false } }),
        tr("vt2", "v_aw", "v_ap", "Approve", { approval: { group: "offer-approvers", quorum: "all", n: 2, onReject: "v_dr", noSelf: true } }),
        tr("vt3", "v_aw", "v_dr", "Return to draft", { validators: { fields: [], cv: false, comment: true } }),
        tr("vt4", "v_ap", "v_op", "Publish vacancy", { post: [{ type: "notify", a: "Team owners" }] }),
        tr("vt5", "v_op", "v_fi", "Mark filled", { conditions: [{ type: "teamRole", v: "Recruiter" }] }),
        tr("vt6", "*", "v_ca", "Cancel", { conditions: [{ type: "teamRole", v: "Admin" }] }),
      ],
    };
  }
  function offerGraph() {
    return {
      initial: "o_dr",
      statuses: [st("o_dr", "Draft", "todo", 40, 50), st("o_aw", "Awaiting approval", "prog", 270, 50), st("o_ap", "Approved", "prog", 500, 50),
        st("o_se", "Sent", "prog", 730, 50), st("o_ac", "Accepted", "done", 730, 230), st("o_de", "Declined", "done", 500, 230), st("o_wd", "Withdrawn", "done", 270, 390)],
      transitions: [
        tr("ot1", "o_dr", "o_aw", "Submit", { validators: { fields: ["Salary (AED)", "Start date"], cv: false, comment: false } }),
        tr("ot2", "o_aw", "o_ap", "Approve", { approval: { group: "offer-approvers", quorum: "n", n: 2, onReject: "o_dr", noSelf: true } }),
        tr("ot3", "o_ap", "o_se", "Send to candidate", { post: [{ type: "notify", a: "Candidate" }, { type: "setField", a: "Offer status", b: "Sent" }] }),
        tr("ot4", "o_se", "o_ac", "Accepted"),
        tr("ot5", "o_se", "o_de", "Declined", { validators: { fields: [], cv: false, comment: true } }),
        tr("ot6", "*", "o_wd", "Withdraw", { conditions: [{ type: "group", v: "hr-leadership" }] }),
      ],
    };
  }

  const WFS = [
    { id: "applications", name: "Applications pipeline", isDefault: true, version: 4, draft: false, kind: "Applications", usedBy: "Applications (default) · Talent Acquisition, Graduate Hiring", teams: 2, modified: "2 Nov 2026 · Omar Alshair",
      graph: pipeline("Assessment", "Send assessment"), inflight: { Applied: 9, Screening: 6, Interview: 5, Assessment: 3, Offer: 2, Hired: 14, Rejected: 22 } },
    { id: "engineering", name: "Engineering hiring", version: 2, draft: true, kind: "Applications", usedBy: "Applications for Engineering vacancies · Talent Acquisition", teams: 1, modified: "Today 09:40 · Mariam Al Suwaidi",
      graph: engineeringDraft(), extraPublished: ["Reference check"], inflight: { Applied: 7, Screening: 5, Interview: 4, "Reference check": 3, Assessment: 2, Offer: 1, Hired: 6, Rejected: 11 } },
    { id: "executive", name: "Executive search", version: 1, draft: false, kind: "Applications", usedBy: "Applications for Executive vacancies · Executive Search", teams: 1, modified: "14 Oct 2026 · Mariam Al Suwaidi",
      graph: pipeline("Board interview", "Send to board"), inflight: { Applied: 3, Screening: 2, Interview: 2, "Board interview": 1, Offer: 1, Hired: 2, Rejected: 4 } },
    { id: "vacancy", name: "Vacancy approval", version: 3, draft: false, kind: "Vacancies", usedBy: "Vacancies · all teams", teams: 3, modified: "28 Sep 2026 · Omar Alshair",
      graph: vacancyGraph(), inflight: { Draft: 2, "Awaiting approval": 3, Approved: 1, Open: 8, Filled: 12, Cancelled: 2 } },
    { id: "offer", name: "Offer approval", version: 0, draft: true, kind: "Offers", usedBy: "Offers · takes effect when first published", teams: 0, modified: "Yesterday · Omar Alshair",
      graph: offerGraph(), inflight: {} },
  ];
  WFS.forEach((w) => {
    w.publishedNames = w.version ? w.graph.statuses.map((s) => s.name).concat(w.extraPublished || []) : [];
    w.original = clone(w.graph);
  });

  const SCHEME = [
    { kind: "Application", type: "Any (default)", wf: "applications", teams: "All teams" },
    { kind: "Application", type: "Vacancy category: Engineering", wf: "engineering", teams: "Talent Acquisition" },
    { kind: "Application", type: "Vacancy category: Executive", wf: "executive", teams: "Executive Search" },
    { kind: "Application", type: "Vacancy category: Graduate", wf: "applications", teams: "Graduate Hiring" },
    { kind: "Vacancy", type: "Any (default)", wf: "vacancy", teams: "All teams" },
    { kind: "Offer", type: "Any (default)", wf: "offer", teams: "All teams" },
  ];
  let schemePublished = clone(SCHEME);

  const TEST_USERS = [
    { id: "u-104", name: "Sara Haddad", label: "Sara Haddad · Recruiter", role: "Recruiter", groups: ["recruiters"], person: true },
    { id: "u-105", name: "Khalid Al Mansoori", label: "Khalid Al Mansoori · Hiring manager", role: "Recruiter", groups: ["hiring-managers", "offer-approvers"], person: true, hm: true },
    { id: "u-102", name: "Mariam Al Suwaidi", label: "Mariam Al Suwaidi · Team admin", role: "Admin", groups: ["hr-leadership", "offer-approvers"], person: true },
    { id: "auto", name: "Automation", label: "Automation (rule or AI app)", role: null, groups: [], person: false },
  ];

  // ---------- designer state (kept in this closure between renders) ----------
  let cur = null; // current workflow object
  let sel = null; // {type:'status'|'transition', id}
  let test = null; // test-run state when on
  let wiz = null;

  const W = (id) => WFS.find((w) => w.id === id);
  const sById = (g, id) => g.statuses.find((s) => s.id === id);
  const sName = (g, id) => (id === "*" ? "Any status" : (sById(g, id) || {}).name || "?");
  const opts = (list, selected) => list.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(selected) ? "selected" : ""}>${esc(l)}</option>`).join("");
  const pairs = (arr) => arr.map((x) => [x, x]);

  function statusBadges(w) {
    return [w.version ? ui.badge("Published v" + w.version, "ok") : "", w.draft ? ui.badge(w.version ? "Draft v" + (w.version + 1) : "Draft · never published", "warn") : ""].join(" ");
  }

  // ---------- problems (live validation) ----------
  function problems(g) {
    const out = [];
    const reach = new Set([g.initial]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of g.transitions) {
        const ok = t.from === "*" ? true : reach.has(t.from);
        if (ok && sById(g, t.to) && !reach.has(t.to)) { reach.add(t.to); changed = true; }
      }
    }
    const hasGlobal = g.transitions.find((t) => t.from === "*");
    for (const s of g.statuses) {
      const outs = g.transitions.filter((t) => t.from === s.id && t.to !== s.id);
      if (s.cat !== "done" && !outs.length)
        out.push({ level: "error", text: `Status ${s.name} has no way out`, detail: hasGlobal ? `Only the “${hasGlobal.name}” transition (from any status) leaves it. Add a transition so records can move forward.` : "Add a transition so records can leave this status.", focus: { type: "status", id: s.id } });
      if (!reach.has(s.id))
        out.push({ level: "error", text: `Status ${s.name} cannot be reached`, detail: "No transition leads into it from the first status.", focus: { type: "status", id: s.id } });
    }
    if (!g.statuses.some((s) => s.cat === "done")) out.push({ level: "error", text: "There is no Done status", detail: "Every workflow needs at least one status in the Done category.", focus: null });
    const names = {};
    g.statuses.forEach((s) => { const k = s.name.trim().toLowerCase(); if (names[k]) out.push({ level: "error", text: `Two statuses are called ${s.name}`, detail: "Status names must be unique.", focus: { type: "status", id: s.id } }); names[k] = 1; });
    for (const t of g.transitions) {
      const label = `${sName(g, t.from)} → ${sName(g, t.to)}`;
      if (!t.name.trim()) out.push({ level: "error", text: `Transition ${label} has no name`, detail: "The name is the button people click.", focus: { type: "transition", id: t.id } });
      if (t.approval && !t.approval.group) out.push({ level: "error", text: `Transition ${label} needs an approver group`, detail: "Pick the approval group that must approve this move.", focus: { type: "transition", id: t.id } });
      if (t.approval && t.approval.group && t.approval.quorum === "n" && +t.approval.n > (GROUP_SIZES[t.approval.group] || 0))
        out.push({ level: "error", text: `Transition ${label} asks for ${t.approval.n} approvals`, detail: `${t.approval.group} has only ${GROUP_SIZES[t.approval.group]} members, so it could never be approved.`, focus: { type: "transition", id: t.id } });
      if (t.approval && t.approval.group && !APPROVAL_GROUPS.includes(t.approval.group))
        out.push({ level: "warn", text: `${t.approval.group} is not marked as an approval group`, detail: `Used by ${label}. Mark it as an approval group on the Groups page, or pick another group.`, focus: { type: "transition", id: t.id } });
      const to = sById(g, t.to);
      if (to && to.name === "Hired" && !t.conditions.length && !t.approval)
        out.push({ level: "warn", text: `Anyone who can move records can run ${label}`, detail: "Consider a condition or an approval step.", focus: { type: "transition", id: t.id } });
    }
    return out;
  }

  // ---------- SVG drawing ----------
  const center = (s) => ({ x: s.x + NW / 2, y: s.y + NH / 2 });
  function clip(c, v) {
    const hw = NW / 2 + 3, hh = NH / 2 + 3;
    const k = Math.min(v.x ? hw / Math.abs(v.x) : Infinity, v.y ? hh / Math.abs(v.y) : Infinity);
    return { x: c.x + v.x * k, y: c.y + v.y * k };
  }
  function edgeGeom(a, b, bend) {
    const ca = center(a), cb = center(b);
    const dx = cb.x - ca.x, dy = cb.y - ca.y, len = Math.hypot(dx, dy) || 1;
    const mid = { x: (ca.x + cb.x) / 2 - (dy / len) * bend, y: (ca.y + cb.y) / 2 + (dx / len) * bend };
    const p1 = clip(ca, { x: mid.x - ca.x, y: mid.y - ca.y }), p2 = clip(cb, { x: mid.x - cb.x, y: mid.y - cb.y });
    const c = { x: 2 * mid.x - (p1.x + p2.x) / 2, y: 2 * mid.y - (p1.y + p2.y) / 2 };
    const r = (n) => Math.round(n * 10) / 10;
    return { d: `M${r(p1.x)},${r(p1.y)} Q${r(c.x)},${r(c.y)} ${r(p2.x)},${r(p2.y)}`, lx: r(0.25 * p1.x + 0.5 * c.x + 0.25 * p2.x), ly: r(0.25 * p1.y + 0.5 * c.y + 0.25 * p2.y) };
  }
  const lblW = (s) => Math.max(36, Math.round(String(s).length * 6.3 + 18));

  function canvasLayers(w) {
    const g = w.graph, probs = problems(g);
    const badT = new Set(probs.filter((p) => p.level === "error" && p.focus && p.focus.type === "transition").map((p) => p.focus.id));
    const badS = new Set(probs.filter((p) => p.level === "error" && p.focus && p.focus.type === "status").map((p) => p.focus.id));
    let lines = "", labels = "";
    for (const t of g.transitions) {
      const to = sById(g, t.to);
      if (!to) continue;
      const cls = `wf-edge${sel && sel.type === "transition" && sel.id === t.id ? " sel" : ""}${badT.has(t.id) ? " bad" : ""}${t.approval ? " appr" : ""}`;
      const marker = cls.includes(" sel") ? "wf-arr-sel" : cls.includes(" bad") ? "wf-arr-bad" : "wf-arr";
      const title = `<title>${esc(t.name)}: ${esc(sName(g, t.from))} → ${esc(to.name)}${t.approval ? " · needs approval" : ""}</title>`;
      if (t.from === "*") {
        const c = center(to), x2 = to.x - 3, x1 = to.x - 26, txt = "All · " + t.name, lw = lblW(txt);
        lines += `<g class="${cls}" data-t="${t.id}">${title}<path class="hit" d="M${x1},${c.y} L${x2},${c.y}"/><path class="line" d="M${x1},${c.y} L${x2},${c.y}" marker-end="url(#${marker})"/></g>`;
        labels += `<g class="${cls} global" data-t="${t.id}">${title}<g class="lbl" transform="translate(${x1 - lw / 2},${c.y})"><rect x="${-lw / 2}" y="-11" width="${lw}" height="22" rx="11"/><text text-anchor="middle" dy="4">${esc(txt)}</text></g></g>`;
        continue;
      }
      const from = sById(g, t.from);
      if (!from) continue;
      const rev = g.transitions.some((o) => o.from === t.to && o.to === t.from);
      const geo = edgeGeom(from, to, rev ? 26 : 0), lw = lblW(t.name || "(no name)");
      lines += `<g class="${cls}" data-t="${t.id}">${title}<path class="hit" d="${geo.d}"/><path class="line" d="${geo.d}" marker-end="url(#${marker})"/></g>`;
      labels += `<g class="${cls}" data-t="${t.id}">${title}<g class="lbl" transform="translate(${geo.lx},${geo.ly})"><rect x="${-lw / 2}" y="-11" width="${lw}" height="22" rx="11"/><text text-anchor="middle" dy="4">${esc(t.name || "(no name)")}</text></g></g>`;
    }
    const init = sById(g, g.initial);
    if (init) {
      const c = center(init);
      lines += `<g class="wf-init"><title>Records start here</title><circle cx="${init.x - 30}" cy="${c.y}" r="6"/><path d="M${init.x - 24},${c.y} L${init.x - 3},${c.y}" marker-end="url(#wf-arr)"/></g>`;
    }
    const nodes = g.statuses.map((s) => {
      const n = w.inflight[s.name] || 0;
      const cls = `wf-node ${s.cat}${sel && sel.type === "status" && sel.id === s.id ? " sel" : ""}${badS.has(s.id) ? " bad" : ""}${test && test.status === s.id ? " cur" : ""}`;
      return `<g class="${cls}" data-s="${s.id}" transform="translate(${s.x},${s.y})" tabindex="0" role="button" aria-label="Status ${esc(s.name)}, ${CAT_LABEL[s.cat]}">
        <title>${esc(s.name)} · ${CAT_LABEL[s.cat]} · drag to move, click to edit</title>
        <rect width="${NW}" height="${NH}" rx="10"/><rect class="cat" width="5" height="${NH - 16}" x="7" y="8" rx="2"/>
        <text class="nm" x="20" y="20">${esc(s.name)}</text><text class="ct" x="20" y="36">${CAT_LABEL[s.cat]}${n ? " · " + n + (n === 1 ? " record" : " records") : ""}</text>
        ${test && test.status === s.id ? `<text class="tst" x="${NW - 8}" y="16" text-anchor="end">TEST</text>` : ""}</g>`;
    }).join("");
    return { lines, nodes, labels };
  }

  function drawCanvas(root) {
    const L = canvasLayers(cur);
    root.querySelector("#wf-lines").innerHTML = L.lines;
    root.querySelector("#wf-nodes").innerHTML = L.nodes;
    root.querySelector("#wf-labels").innerHTML = L.labels;
  }

  // ---------- side panel ----------
  function condRow(c, i) {
    let param = "";
    if (c.type === "group") param = `<select class="input" data-tb="conditions.${i}.v">${opts(pairs(GROUPS), c.v)}</select>`;
    else if (c.type === "notEmpty") param = `<select class="input" data-tb="conditions.${i}.v">${opts(pairs(FIELDS), c.v)}</select>`;
    else if (c.type === "teamRole") param = `<select class="input" data-tb="conditions.${i}.v">${opts(pairs(ROLES), c.v)}</select>`;
    return `<div class="wf-rule"><select class="input" data-tb="conditions.${i}.type" data-re="1" aria-label="Condition type">${opts(Object.entries(COND), c.type)}</select>${param}
      <button class="btn ghost sm" data-act="rm-cond" data-i="${i}" aria-label="Remove condition">Remove</button></div>`;
  }
  function postRow(p, i) {
    let param = "";
    if (p.type === "setField") param = `<select class="input" data-tb="post.${i}.a">${opts(pairs(FIELDS), p.a)}</select><input class="input" data-tb="post.${i}.b" value="${esc(p.b || "")}" placeholder="Value" aria-label="Value">`;
    else if (p.type === "notify") param = `<select class="input" data-tb="post.${i}.a">${opts(pairs(NOTIFY), p.a)}</select>`;
    else param = `<select class="input" data-tb="post.${i}.a">${opts(pairs(ASSIGN), p.a)}</select>`;
    return `<div class="wf-rule"><span class="wf-num">${i + 1}</span><select class="input" data-tb="post.${i}.type" data-re="1" aria-label="Post-action type">${opts(Object.entries(POST), p.type)}</select>${param}
      <button class="btn ghost sm" data-act="rm-post" data-i="${i}" aria-label="Remove post-action">Remove</button></div>`;
  }
  function transitionPanel(g, t) {
    const to = sById(g, t.to), a = t.approval;
    const statusOpts = g.statuses.map((s) => [s.id, s.name]);
    const personOnly = to && PERSON_ONLY.includes(to.name);
    return `<div class="row" style="justify-content:space-between"><h2 style="margin:0">Transition</h2>${t.from === "*" ? ui.badge("From any status", "info") : ""}</div>
      <p class="small muted" style="margin:2px 0 12px">The name is the button people see on the record.</p>
      ${ui.field("Name", `<input class="input" data-tb="name" value="${esc(t.name)}">`)}
      <div class="wf-two">${ui.field("From", `<select class="input" data-tb="from" data-re="1">${opts([["*", "Any status (global)"]].concat(statusOpts), t.from)}</select>`)}
        ${ui.field("To", `<select class="input" data-tb="to" data-re="1">${opts(statusOpts, t.to)}</select>`)}</div>
      ${ui.field("Screen shown when moving", `<select class="input" data-tb="screen">${opts(pairs(SCREENS), t.screen)}</select>`, "Collects fields such as the rejection reason.")}
      ${personOnly ? `<div class="callout" style="margin-bottom:12px"><b>Always done by a person.</b> Moves into ${esc(to.name)} cannot be run by automation rules or AI apps. This rule is fixed.</div>` : ""}
      <section class="wf-sec"><div class="row" style="justify-content:space-between"><h3>Conditions</h3>
        <select class="input wf-op" data-tb="condOp" aria-label="Combine conditions">${opts([["AND", "All must pass"], ["OR", "Any can pass"]], t.condOp)}</select></div>
        <p class="small muted">Who can see and run this transition. Checked again when it runs.</p>
        ${t.conditions.map(condRow).join("") || `<p class="small muted">No conditions: anyone with “Move stage” on applications can run it.</p>`}
        ${ui.btn("Add condition", { kind: "sm", attrs: 'data-act="add-cond"' })}</section>
      <section class="wf-sec"><h3>Validators</h3><p class="small muted">Checked before the move is saved. All failures are shown together.</p>
        <div class="wf-chips">${FIELDS.map((f) => `<label class="check"><input type="checkbox" data-vfield="${esc(f)}" ${t.validators.fields.includes(f) ? "checked" : ""}> ${esc(f)} required</label>`).join("")}</div>
        <label class="check"><input type="checkbox" data-tb="validators.cv" ${t.validators.cv ? "checked" : ""}> CV must be attached</label><br>
        <label class="check"><input type="checkbox" data-tb="validators.comment" ${t.validators.comment ? "checked" : ""}> Comment required</label></section>
      <section class="wf-sec"><h3>Approval step</h3>
        <label class="check"><input type="checkbox" data-act="appr-toggle" ${a ? "checked" : ""}> Needs approval before the move happens</label>
        ${a ? `<div style="margin-top:10px">
          ${ui.field("Approval group", `<select class="input" data-tb="approval.group" data-re="1">${opts([["", "Choose a group…"]].concat(GROUPS.map((x) => [x, x + (APPROVAL_GROUPS.includes(x) ? " (approval group)" : "")])), a.group)}</select>`, a.group ? `${GROUP_SIZES[a.group]} members. Approvers are fixed when the step starts.` : `<span style="color:var(--danger)">Required.</span>`)}
          <div class="field"><label>Who must approve</label><div class="row">
            ${[["any", "Any one"], ["all", "All"], ["n", "At least"]].map(([v, l]) => `<label class="check"><input type="radio" name="wf-q" data-tb="approval.quorum" data-re="1" value="${v}" ${a.quorum === v ? "checked" : ""}> ${l}</label>`).join("")}
            ${a.quorum === "n" ? `<input class="input" type="number" min="1" style="width:70px" data-tb="approval.n" value="${esc(a.n)}" aria-label="Number of approvals">` : ""}</div></div>
          ${ui.field("If declined, go to", `<select class="input" data-tb="approval.onReject">${opts(statusOpts, a.onReject)}</select>`)}
          <label class="check"><input type="checkbox" data-tb="approval.noSelf" ${a.noSelf ? "checked" : ""}> People cannot approve their own move</label></div>` : ""}
      </section>
      <section class="wf-sec"><h3>Post-actions</h3><p class="small muted">Run in order after the move is saved. Status change and history are always recorded first.</p>
        ${t.post.map(postRow).join("") || `<p class="small muted">None.</p>`}
        ${ui.btn("Add post-action", { kind: "sm", attrs: 'data-act="add-post"' })}</section>
      <div class="row" style="justify-content:space-between;margin-top:14px">${ui.btn("Delete transition", { kind: "danger sm", attrs: 'data-act="del-t"' })}${ui.btn("Done", { kind: "sm", attrs: 'data-act="desel"' })}</div>`;
  }
  function statusPanel(g, s) {
    const ins = g.transitions.filter((t) => t.to === s.id), outs = g.transitions.filter((t) => t.from === s.id);
    const link = (t) => `<li><a href="javascript:void 0" data-act="sel-t" data-id="${t.id}">${esc(t.name || "(no name)")}</a> <span class="muted small">${esc(sName(g, t.from))} → ${esc(sName(g, t.to))}</span></li>`;
    const n = cur.inflight[s.name] || 0;
    return `<h2>Status</h2>
      ${ui.field("Name", `<input class="input" data-sb="name" value="${esc(s.name)}">`, "Shared by every workflow that uses it. Arabic name is set on the Statuses tab.")}
      ${ui.field("Category", `<select class="input" data-sb="cat">${opts(Object.entries(CAT_LABEL), s.cat)}</select>`, "The colour follows the category.")}
      <p class="small"><b>${n}</b> records are in this status now.</p>
      ${PERSON_ONLY.includes(s.name) ? `<div class="callout" style="margin-bottom:10px">Moves into ${esc(s.name)} are always done by a person.</div>` : ""}
      <h3>Comes from</h3><ul class="wf-ul">${ins.map(link).join("") || `<li class="muted small">Nothing leads here.</li>`}</ul>
      <h3>Goes to</h3><ul class="wf-ul">${outs.map(link).join("") || `<li class="muted small">No way out yet.</li>`}</ul>
      <div class="row" style="margin-top:12px">${ui.btn("Add transition from here", { kind: "sm", attrs: `data-act="add-t" data-from="${s.id}"` })}
        ${g.initial !== s.id ? ui.btn("Make first status", { kind: "sm", attrs: 'data-act="set-initial"' }) : ui.badge("First status", "info")}</div>
      <div class="row" style="justify-content:space-between;margin-top:14px">${ui.btn("Delete status", { kind: "danger sm", attrs: 'data-act="del-s"' })}${ui.btn("Done", { kind: "sm", attrs: 'data-act="desel"' })}</div>`;
  }
  function emptyPanel() {
    return `<h2>Nothing selected</h2><p class="muted">Click a status or a transition to edit it. Drag statuses to arrange the diagram; arrows follow.</p>
      <div class="stack small">
        <div class="row"><span class="wf-sw todo"></span> To do</div><div class="row"><span class="wf-sw prog"></span> In progress</div><div class="row"><span class="wf-sw done"></span> Done</div>
        <div class="row"><span class="wf-sw appr"></span> Dashed label: needs approval</div><div class="row"><span class="badge">All · Reject</span> can run from any status</div></div>`;
  }

  // ---------- test run ----------
  const rank = (r) => ROLES.indexOf(r);
  function evalT(t, u, f) {
    const g = cur.graph, to = sById(g, t.to), res = [];
    const conds = t.conditions.map((c) => {
      if (c.type === "group") return u.groups.includes(c.v) ? { ok: true, text: `In group ${c.v}` } : { ok: false, text: `${u.name} is not in ${c.v}` };
      if (c.type === "notEmpty") return f[c.v] ? { ok: true, text: `${c.v} has a value` } : { ok: false, text: `${c.v} is empty` };
      if (c.type === "hiringManager") return u.hm ? { ok: true, text: "Is the vacancy's hiring manager" } : { ok: false, text: `Only the hiring manager (Khalid Al Mansoori) can run it` };
      if (c.type === "notCreator") return u.id !== "u-104" ? { ok: true, text: "Did not add this application" } : { ok: false, text: "Sara Haddad added this application" };
      if (c.type === "teamRole") return u.role && rank(u.role) >= rank(c.v) ? { ok: true, text: `Team role ${u.role} (needs ${c.v})` } : { ok: false, text: `Needs team role ${c.v}; ${u.name} has ${u.role || "none"}` };
      return { ok: true, text: "" };
    });
    let condOk = !conds.length || (t.condOp === "OR" ? conds.some((c) => c.ok) : conds.every((c) => c.ok));
    res.push(...conds);
    if (to && PERSON_ONLY.includes(to.name) && !u.person) { res.push({ ok: false, text: `${to.name} is always done by a person` }); condOk = false; }
    let valOk = true;
    t.validators.fields.forEach((fl) => { const ok = !!f[fl]; valOk = valOk && ok; res.push({ ok, text: ok ? `${fl} filled in` : `${fl} is required` }); });
    if (t.validators.cv) { valOk = valOk && !!f.CV; res.push({ ok: !!f.CV, text: f.CV ? "CV attached" : "CV must be attached" }); }
    if (t.validators.comment) res.push({ ok: true, text: "Asks for a comment (the test fills one in)" });
    if (t.approval) res.push({ ok: true, info: true, text: `Then waits for ${t.approval.group || "an approver group"} (${t.approval.quorum === "any" ? "any one" : t.approval.quorum === "all" ? "all" : "at least " + t.approval.n})` });
    return { ok: condOk && valOk, hidden: !condOk, res };
  }
  function testPanel() {
    const g = cur.graph, u = TEST_USERS.find((x) => x.id === test.user);
    const avail = g.transitions.filter((t) => t.from === test.status || (t.from === "*" && t.to !== test.status));
    const wt = test.waiting && g.transitions.find((t) => t.id === test.waiting);
    return `<div class="row" style="justify-content:space-between"><h2 style="margin:0">Test run</h2>${ui.badge("Nothing is saved", "info")}</div>
      <p class="small muted">Walk a sample application through this ${cur.draft ? "draft" : "workflow"} and see which rules pass and why.</p>
      ${ui.field("Sample application", `<div class="input" style="background:var(--surface-subtle)">Fatima Al Zahra · Senior Backend Engineer · Platform Engineering</div>`)}
      ${ui.field("Test as", `<select class="input" data-test="user">${opts(TEST_USERS.map((x) => [x.id, x.label]), test.user)}</select>`)}
      <div class="field"><label>Fields on the sample</label><div class="wf-chips">${["CV", "Interview feedback", "Assessment score", "Salary (AED)", "Start date", "Rejection reason"].map((f) =>
        `<label class="check"><input type="checkbox" data-testfield="${esc(f)}" ${test.fields[f] ? "checked" : ""}> ${esc(f === "CV" ? "CV attached" : f + " filled")}</label>`).join("")}</div></div>
      <p>Current status: <b>${esc(sName(g, test.status))}</b></p>
      ${wt ? `<div class="callout warn"><b>Waiting for approval</b><br>${esc(wt.name)} needs ${esc(wt.approval.group || "an approver group")} (${wt.approval.quorum === "any" ? "any one of " + (GROUP_SIZES[wt.approval.group] || 0) : wt.approval.quorum === "all" ? "all " + (GROUP_SIZES[wt.approval.group] || 0) : "at least " + wt.approval.n}).
          <div class="row" style="margin-top:8px">${ui.btn("Approve as Mariam Al Suwaidi", { kind: "primary sm", attrs: 'data-act="test-approve"' })}${ui.btn("Decline", { kind: "danger sm", attrs: 'data-act="test-decline"' })}</div></div>`
        : `<h3>Available moves for ${esc(u.name)}</h3>${avail.map((t) => {
          const r = evalT(t, u, test.fields);
          return `<div class="wf-try ${r.ok ? "" : "no"}"><div class="row" style="justify-content:space-between"><b>${esc(t.name)} → ${esc(sName(g, t.to))}</b>
            ${ui.btn(r.ok ? "Run" : r.hidden ? "Hidden" : "Blocked", { kind: r.ok ? "primary sm" : "sm", attrs: `data-act="test-run" data-id="${t.id}" ${r.ok ? "" : "disabled"}` })}</div>
            <ul class="wf-res">${r.res.map((x) => `<li class="${x.info ? "i" : x.ok ? "ok" : "no"}">${x.info ? "•" : x.ok ? "✓" : "✗"} ${esc(x.text)}</li>`).join("") || `<li class="ok">✓ No rules</li>`}</ul></div>`;
        }).join("") || `<p class="muted small">No way out of this status.</p>`}`}
      <h3 style="margin-top:12px">Steps</h3><ol class="wf-log">${test.log.map((l) => `<li>${l}</li>`).join("") || `<li class="muted">Started in ${esc(sName(g, g.initial))}.</li>`}</ol>
      <div class="row">${ui.btn("Restart test", { kind: "sm", attrs: 'data-act="test-reset"' })}${ui.btn("End test run", { kind: "sm", attrs: 'data-act="test-toggle"' })}</div>`;
  }
  function newTest() {
    return { status: cur.graph.initial, user: "u-104", fields: { CV: true, "Interview feedback": false, "Assessment score": false, "Salary (AED)": true, "Start date": false, "Rejection reason": false }, log: [], waiting: null };
  }
  function postSummary(t) {
    return t.post.map((p) => (p.type === "setField" ? `set ${p.a} to “${p.b || ""}”` : p.type === "notify" ? `notify ${p.a}` : `assign to ${p.a}`)).join(", ");
  }

  function panelHtml() {
    if (test) return testPanel();
    const g = cur.graph;
    if (sel && sel.type === "transition") { const t = g.transitions.find((x) => x.id === sel.id); if (t) return transitionPanel(g, t); }
    if (sel && sel.type === "status") { const s = sById(g, sel.id); if (s) return statusPanel(g, s); }
    return emptyPanel();
  }
  function problemsHtml() {
    const p = problems(cur.graph), e = p.filter((x) => x.level === "error").length, w = p.length - e;
    return `<div class="row" style="justify-content:space-between;margin-bottom:8px"><h2 style="margin:0">Problems</h2>
      <span class="row">${ui.badge(e + (e === 1 ? " error" : " errors"), e ? "bad" : "ok")}${ui.badge(w + (w === 1 ? " warning" : " warnings"), w ? "warn" : "")}</span></div>
      ${p.length ? `<ul class="list-plain">${p.map((x, i) => `<li class="row" style="justify-content:space-between;flex-wrap:nowrap"><div class="row" style="flex-wrap:nowrap;align-items:flex-start">${ui.badge(x.level === "error" ? "Error" : "Warning", x.level === "error" ? "bad" : "warn")}
        <div><b>${esc(x.text)}</b><div class="small muted">${esc(x.detail)}</div></div></div>${x.focus ? ui.btn("Show", { kind: "sm", attrs: `data-act="focus" data-i="${i}"` }) : ""}</li>`).join("")}</ul>
        <p class="small muted" style="margin:8px 0 0">Errors block publishing. Warnings do not.</p>`
        : `<div class="callout ok">No problems. This ${cur.draft ? "draft is ready to publish" : "workflow is valid"}.</div>`}`;
  }
  function tableHtml() {
    const g = cur.graph;
    return ui.table(["From", "To", "Transition", "Conditions", "Validators", "Approval", "Post-actions"], g.transitions.map((t) => [
      esc(sName(g, t.from)), esc(sName(g, t.to)), `<a href="javascript:void 0" data-act="sel-t" data-id="${t.id}">${esc(t.name || "(no name)")}</a>`,
      t.conditions.length ? t.conditions.length + " (" + (t.condOp === "AND" ? "all" : "any") + ")" : "–",
      t.validators.fields.length + (t.validators.cv ? 1 : 0) + (t.validators.comment ? 1 : 0) || "–",
      t.approval ? esc(t.approval.group || "group missing") : "–", t.post.length || "–",
    ]));
  }
  function headActions() {
    return [
      ui.btn(test ? "Test run on" : "Test run", { kind: test ? "primary" : "", ic: "activity", attrs: 'data-act="test-toggle" aria-pressed="' + !!test + '"' }),
      ui.btn("Compare with published", { attrs: `data-act="diff" ${cur.version ? "" : "disabled"}` }),
      cur.draft ? ui.btn("Discard draft", { kind: "danger", attrs: 'data-act="discard"' }) : "",
      ui.btn(cur.draft ? "Publish" : "Published", { kind: "primary", attrs: `data-act="publish" ${cur.draft ? "" : "disabled"}` }),
    ].join("");
  }
  function headHtml() {
    return ui.pageHeader(cur.name, `${statusBadges(cur)} <span class="muted">· ${esc(cur.usedBy)}</span>`, headActions(), `<a href="#/workflows">Workflows</a> / ${esc(cur.name)}`);
  }

  function drawAll(root) {
    drawCanvas(root);
    root.querySelector("#wf-panel").innerHTML = panelHtml();
    root.querySelector("#wf-problems").innerHTML = problemsHtml();
    root.querySelector("#wf-table").innerHTML = tableHtml();
    root.querySelector("#wf-head").innerHTML = headHtml();
  }
  function markDraft(root) {
    if (!cur.draft) { cur.draft = true; root.querySelector("#wf-head").innerHTML = headHtml(); }
  }

  // ---------- modals ----------
  function bindModal(handler) {
    const m = document.querySelector(".modal");
    if (m) m.addEventListener("click", (e) => { const b = e.target.closest("[data-m]"); if (b) handler(b.dataset.m, b, m); });
    return m;
  }
  function addStatusModal(root) {
    Admin.modal(`<h2>Add status</h2>
      ${ui.field("Name", `<input class="input" id="wf-ns-name" placeholder="For example: Reference check">`, "Statuses are shared: if one with this name exists, it is reused.")}
      ${ui.field("Category", `<select class="input" id="wf-ns-cat">${opts(Object.entries(CAT_LABEL), "prog")}</select>`)}
      <div id="wf-ns-err" class="small" style="color:var(--danger)"></div>
      <div class="row" style="justify-content:flex-end">${ui.btn("Cancel", { attrs: 'data-m="cancel"' })}${ui.btn("Add status", { kind: "primary", attrs: 'data-m="ok"' })}</div>`);
    document.getElementById("wf-ns-name").focus();
    bindModal((a, b, m) => {
      if (a === "cancel") return Admin.close();
      const name = m.querySelector("#wf-ns-name").value.trim();
      if (!name) return (m.querySelector("#wf-ns-err").textContent = "Enter a name.");
      if (cur.graph.statuses.some((s) => s.name.toLowerCase() === name.toLowerCase())) return (m.querySelector("#wf-ns-err").textContent = "This workflow already has a status with that name.");
      const spots = [[730, 390], [500, 390], [40, 230], [40, 390], [270, 230]];
      const free = spots.find(([x, y]) => !cur.graph.statuses.some((s) => Math.abs(s.x - x) < NW && Math.abs(s.y - y) < NH)) || [380, 160];
      const s = st(nid("s"), name, m.querySelector("#wf-ns-cat").value, free[0], free[1]);
      cur.graph.statuses.push(s); sel = { type: "status", id: s.id };
      Admin.close(); markDraft(root); drawAll(root); Admin.toast(`Added ${name}. Drag it into place and add transitions.`);
    });
  }
  function addTransitionModal(root, from) {
    const g = cur.graph, so = g.statuses.map((s) => [s.id, s.name]);
    Admin.modal(`<h2>Add transition</h2>
      <div class="wf-two">${ui.field("From", `<select class="input" id="wf-nt-from">${opts([["*", "Any status (global)"]].concat(so), from || g.statuses[0].id)}</select>`)}
      ${ui.field("To", `<select class="input" id="wf-nt-to">${opts(so, (g.statuses.find((s) => s.id !== from) || {}).id)}</select>`)}</div>
      ${ui.field("Name (button label)", `<input class="input" id="wf-nt-name" placeholder="For example: Move to offer">`)}
      <div id="wf-nt-err" class="small" style="color:var(--danger)"></div>
      <div class="row" style="justify-content:flex-end">${ui.btn("Cancel", { attrs: 'data-m="cancel"' })}${ui.btn("Add transition", { kind: "primary", attrs: 'data-m="ok"' })}</div>`);
    bindModal((a, b, m) => {
      if (a === "cancel") return Admin.close();
      const f = m.querySelector("#wf-nt-from").value, t = m.querySelector("#wf-nt-to").value, name = m.querySelector("#wf-nt-name").value.trim();
      if (!name) return (m.querySelector("#wf-nt-err").textContent = "Enter a name. It is the button people click.");
      if (g.transitions.some((x) => x.from === f && x.to === t)) return (m.querySelector("#wf-nt-err").textContent = "That transition already exists.");
      const n = tr(nid("t"), f, t, name);
      g.transitions.push(n); sel = { type: "transition", id: n.id };
      Admin.close(); markDraft(root); drawAll(root);
    });
  }
  function confirmDeleteStatus(root, s) {
    const n = cur.inflight[s.name] || 0, tc = cur.graph.transitions.filter((t) => t.from === s.id || t.to === s.id).length;
    Admin.modal(`<h2>Delete status “${esc(s.name)}” from this draft?</h2>
      <ul><li><b>${n}</b> records are in ${esc(s.name)} now. When you publish, you choose where they move.</li><li><b>${tc}</b> transitions to or from it will be removed.</li>
      <li>The status stays available to other workflows.</li></ul>
      <div class="row" style="justify-content:flex-end">${ui.btn("Cancel", { attrs: 'data-m="cancel"' })}${ui.btn("Delete status", { kind: "danger", attrs: 'data-m="ok"' })}</div>`);
    bindModal((a) => {
      if (a === "ok") {
        const g = cur.graph;
        g.statuses = g.statuses.filter((x) => x.id !== s.id);
        g.transitions = g.transitions.filter((t) => t.from !== s.id && t.to !== s.id);
        g.transitions.forEach((t) => { if (t.approval && t.approval.onReject === s.id) t.approval.onReject = g.statuses[0] && g.statuses[0].id; });
        if (g.initial === s.id) g.initial = g.statuses[0] && g.statuses[0].id;
        sel = null; markDraft(root); drawAll(root);
      }
      Admin.close();
    });
  }
  function diffModal() {
    const names = cur.graph.statuses.map((s) => s.name);
    const added = names.filter((n) => !cur.publishedNames.includes(n)), removed = cur.publishedNames.filter((n) => !names.includes(n));
    const ot = cur.original.transitions, nt = cur.graph.transitions;
    const tAdded = nt.filter((t) => !ot.find((o) => o.id === t.id)), tRemoved = ot.filter((o) => !nt.find((t) => t.id === o.id));
    const tChanged = nt.filter((t) => { const o = ot.find((x) => x.id === t.id); return o && JSON.stringify(o) !== JSON.stringify(t); });
    const og = cur.original;
    Admin.modal(`<h2>Draft compared with published v${cur.version}</h2>
      <ul class="list-plain">
        ${removed.map((n) => `<li>${ui.badge("Removed", "bad")} Status <b>${esc(n)}</b> (${cur.inflight[n] || 0} records)</li>`).join("")}
        ${added.map((n) => `<li>${ui.badge("Added", "ok")} Status <b>${esc(n)}</b></li>`).join("")}
        ${tRemoved.map((t) => `<li>${ui.badge("Removed", "bad")} Transition <b>${esc(t.name)}</b> ${esc(sName(og, t.from))} → ${esc(sName(og, t.to))}</li>`).join("")}
        ${tAdded.map((t) => `<li>${ui.badge("Added", "ok")} Transition <b>${esc(t.name)}</b> ${esc(sName(cur.graph, t.from))} → ${esc(sName(cur.graph, t.to))}</li>`).join("")}
        ${tChanged.map((t) => `<li>${ui.badge("Changed", "warn")} Transition <b>${esc(t.name)}</b> rules or approval</li>`).join("")}
      </ul>${!removed.length && !added.length && !tAdded.length && !tRemoved.length && !tChanged.length ? `<p class="muted">No differences (layout changes only).</p>` : ""}
      ${cur.id === "engineering" ? `<p class="small muted">Published v2 also had “Reference check”, removed in this draft.</p>` : ""}
      <div class="row" style="justify-content:flex-end">${ui.btn("Close", { attrs: 'data-m="cancel"' })}</div>`);
    bindModal(() => Admin.close());
  }

  // ---------- publish + migration wizard ----------
  function publish(root) {
    const errs = problems(cur.graph).filter((p) => p.level === "error");
    if (errs.length) {
      Admin.modal(`<h2>Fix ${errs.length} ${errs.length === 1 ? "problem" : "problems"} before publishing</h2>
        <ul class="list-plain">${errs.map((e, i) => `<li class="row" style="justify-content:space-between"><span>${ui.badge("Error", "bad")} ${esc(e.text)}</span>${e.focus ? ui.btn("Show", { kind: "sm", attrs: `data-m="show" data-i="${i}"` }) : ""}</li>`).join("")}</ul>
        <p class="small muted">Your draft is kept. Records keep using published version ${cur.version || "(none)"} until you publish.</p>
        <div class="row" style="justify-content:flex-end">${ui.btn("Close", { attrs: 'data-m="cancel"' })}</div>`);
      bindModal((a, b) => { if (a === "show") { sel = errs[+b.dataset.i].focus; test = null; drawAll(root); } Admin.close(); });
      return;
    }
    const names = cur.graph.statuses.map((s) => s.name);
    const removed = cur.publishedNames.filter((n) => !names.includes(n));
    wiz = { step: 1, removed, map: {}, ack: false };
    removed.forEach((n) => { wiz.map[n] = (cur.graph.statuses.find((s) => s.name === "Interview") || cur.graph.statuses[0]).id; });
    drawWizard(root);
  }
  function drawWizard(root) {
    const names = cur.graph.statuses.map((s) => s.name);
    const added = names.filter((n) => !cur.publishedNames.includes(n));
    const inflight = Object.entries(cur.inflight);
    const total = inflight.reduce((a, [, n]) => a + n, 0);
    const finished = cur.graph.statuses.filter((s) => s.cat === "done").reduce((a, s) => a + (cur.inflight[s.name] || 0), 0);
    const toMove = wiz.removed.reduce((a, n) => a + (cur.inflight[n] || 0), 0);
    const steps = ["Impact", "Move records", "Check and publish"];
    let body = "";
    if (wiz.step === 1) {
      body = `<ul><li>Used by: <b>${esc(cur.usedBy)}</b></li><li><b>${total - finished}</b> ${esc(cur.kind.toLowerCase())} in flight and ${finished} finished (${cur.teams} ${cur.teams === 1 ? "team" : "teams"})</li>
        <li>Changes: ${added.length ? `+ ${added.map(esc).join(", ")}` : "no statuses added"}; ${wiz.removed.length ? `− ${wiz.removed.map(esc).join(", ")}` : "no statuses removed"}</li></ul>
        ${cur.publishedNames.length ? ui.table(["Status now", "Records", "After publishing"], cur.publishedNames.map((n) => [esc(n), String(cur.inflight[n] || 0),
          wiz.removed.includes(n) ? ui.badge("Removed: needs a new status", "warn") : ui.badge("Stays", "ok")])) : `<p class="muted">Never published, so no records use it yet.</p>`}`;
    } else if (wiz.step === 2) {
      const so = cur.graph.statuses.map((s) => [s.id, s.name]);
      body = wiz.removed.length ? `<p>Choose where records in removed statuses go. Their history keeps the old status.</p>
        ${ui.table(["Removed status", "Records", "Move to"], wiz.removed.map((n) => [`<b>${esc(n)}</b>`, String(cur.inflight[n] || 0),
          `<select class="input" data-map="${esc(n)}" aria-label="New status for ${esc(n)}">${opts(so, wiz.map[n])}</select>`]))}`
        : `<div class="callout ok">No statuses were removed. Every record stays where it is.</div>`;
    } else {
      body = `<h3>Dry run</h3><ul>${wiz.removed.map((n) => `<li><b>${cur.inflight[n] || 0}</b> records: ${esc(n)} → ${esc(sName(cur.graph, wiz.map[n]))}</li>`).join("") || "<li>No records move.</li>"}
        <li>0 problems found. ${toMove} records move in the background; each gets a history entry “Moved by workflow migration”.</li>
        <li>Version ${cur.version + 1} becomes live for new and existing records. Version ${cur.version || "–"} is kept for revert.</li></ul>
        <label class="check"><input type="checkbox" data-m="ack" ${wiz.ack ? "checked" : ""}> I understand ${toMove} records will move and this is logged in the audit log.</label>`;
    }
    Admin.modal(`<h2>Publish “${esc(cur.name)}” as version ${cur.version + 1}</h2>
      <div class="wf-steps">${steps.map((s, i) => `<span class="${i + 1 === wiz.step ? "on" : i + 1 < wiz.step ? "done" : ""}">${i + 1}. ${s}</span>`).join("")}</div>
      ${body}
      <div class="row" style="justify-content:space-between;margin-top:14px">${ui.btn("Cancel", { attrs: 'data-m="cancel"' })}
        <span class="row">${wiz.step > 1 ? ui.btn("Back", { attrs: 'data-m="back"' }) : ""}
        ${wiz.step < 3 ? ui.btn("Next", { kind: "primary", attrs: 'data-m="next"' }) : ui.btn(toMove ? `Publish and move ${toMove} records` : "Publish", { kind: "primary", attrs: `data-m="go" ${wiz.ack ? "" : "disabled"}` })}</span></div>`);
    const m = bindModal((a) => {
      if (a === "cancel") { wiz = null; return Admin.close(); }
      if (a === "back") { wiz.step--; return drawWizard(root); }
      if (a === "next") { wiz.step++; return drawWizard(root); }
      if (a === "ack") { wiz.ack = m.querySelector('[data-m="ack"]').checked; return drawWizard(root); }
      if (a === "go") {
        wiz.removed.forEach((n) => { const to = sName(cur.graph, wiz.map[n]); cur.inflight[to] = (cur.inflight[to] || 0) + (cur.inflight[n] || 0); delete cur.inflight[n]; });
        cur.version += 1; cur.draft = false; cur.publishedNames = cur.graph.statuses.map((s) => s.name); cur.original = clone(cur.graph);
        cur.modified = "Just now · Omar Alshair"; if (!cur.teams) cur.usedBy = cur.kind + " · all teams";
        Admin.close(); Admin.toast(`Published version ${cur.version} (mockup). ${toMove} records moved.`); wiz = null; drawAll(root);
      }
    });
    if (m) m.querySelectorAll("[data-map]").forEach((s) => s.addEventListener("change", () => { wiz.map[s.dataset.map] = s.value; }));
  }

  // ---------- designer mount ----------
  function setPath(o, path, v) {
    const k = path.split("."), last = k.pop();
    k.forEach((x) => (o = o[x]));
    o[last] = v;
  }
  function mountDesigner(root) {
    const page = root.querySelector("#wf-page");
    if (!page) return;
    const svg = page.querySelector("#wf-svg");
    drawAll(page);
    let drag = null, suppress = false;
    const pt = (e) => new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
    svg.addEventListener("pointerdown", (e) => {
      const n = e.target.closest(".wf-node");
      if (!n || e.button > 0) return;
      const s = sById(cur.graph, n.dataset.s), p = pt(e);
      drag = { s, ox: p.x - s.x, oy: p.y - s.y, moved: false };
      svg.setPointerCapture(e.pointerId);
      svg.classList.add("dragging");
      e.preventDefault();
    });
    svg.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const p = pt(e), s = drag.s;
      const x = Math.max(0, Math.min(VB_W - NW, Math.round((p.x - drag.ox) / GRID) * GRID));
      const y = Math.max(0, Math.min(VB_H - NH, Math.round((p.y - drag.oy) / GRID) * GRID));
      if (x === s.x && y === s.y) return;
      s.x = x; s.y = y; drag.moved = true;
      drawCanvas(page);
    });
    const end = (e) => {
      if (!drag) return;
      const d = drag; drag = null; svg.classList.remove("dragging");
      try { svg.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
      suppress = true; setTimeout(() => (suppress = false), 0);
      if (!d.moved) { sel = { type: "status", id: d.s.id }; if (!test) page.querySelector("#wf-panel").innerHTML = panelHtml(); }
      drawCanvas(page);
    };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);
    svg.addEventListener("click", (e) => {
      if (suppress) return;
      const t = e.target.closest("[data-t]");
      sel = t ? { type: "transition", id: t.dataset.t } : null;
      if (test && t) test = null;
      drawCanvas(page); page.querySelector("#wf-panel").innerHTML = panelHtml();
    });
    svg.addEventListener("keydown", (e) => {
      const n = e.target.closest(".wf-node");
      if (!n) return;
      const s = sById(cur.graph, n.dataset.s), step = e.shiftKey ? 50 : GRID;
      const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); sel = { type: "status", id: s.id }; test = null; drawAll(page); page.querySelector(`[data-s="${s.id}"]`).focus(); }
      if (mv) { e.preventDefault(); s.x = Math.max(0, Math.min(VB_W - NW, s.x + mv[0])); s.y = Math.max(0, Math.min(VB_H - NH, s.y + mv[1])); drawCanvas(page); page.querySelector(`[data-s="${s.id}"]`).focus(); }
    });

    const selT = () => sel && sel.type === "transition" && cur.graph.transitions.find((t) => t.id === sel.id);
    const selS = () => sel && sel.type === "status" && sById(cur.graph, sel.id);
    const soft = () => { markDraft(page); drawCanvas(page); page.querySelector("#wf-problems").innerHTML = problemsHtml(); page.querySelector("#wf-table").innerHTML = tableHtml(); };

    const onEdit = (e) => {
      const el = e.target;
      if (el.dataset.test === "user") { test.user = el.value; page.querySelector("#wf-panel").innerHTML = panelHtml(); return; }
      if (el.dataset.testfield) { test.fields[el.dataset.testfield] = el.checked; page.querySelector("#wf-panel").innerHTML = panelHtml(); return; }
      const t = selT(), s = selS();
      if (el.dataset.tb && t) {
        let v = el.type === "checkbox" ? el.checked : el.value;
        if (el.dataset.tb === "approval.n") v = Math.max(1, parseInt(v, 10) || 1);
        setPath(t, el.dataset.tb, v);
        if (/^conditions\.\d+\.type$/.test(el.dataset.tb)) { const c = t.conditions[+el.dataset.tb.split(".")[1]]; c.v = c.type === "group" ? GROUPS[0] : c.type === "notEmpty" ? FIELDS[0] : c.type === "teamRole" ? "Recruiter" : undefined; }
        if (/^post\.\d+\.type$/.test(el.dataset.tb)) { const p = t.post[+el.dataset.tb.split(".")[1]]; p.a = p.type === "setField" ? FIELDS[0] : p.type === "notify" ? NOTIFY[0] : ASSIGN[0]; p.b = ""; }
        soft();
        if (el.dataset.re && e.type === "change") page.querySelector("#wf-panel").innerHTML = panelHtml();
      } else if (el.dataset.vfield && t) {
        const f = el.dataset.vfield, list = t.validators.fields;
        t.validators.fields = el.checked ? list.concat(f) : list.filter((x) => x !== f);
        soft();
      } else if (el.dataset.sb && s) {
        s[el.dataset.sb] = el.value;
        soft();
        if (el.dataset.sb === "cat") page.querySelector("#wf-panel").innerHTML = panelHtml();
      } else if (el.dataset.act === "appr-toggle" && t) {
        t.approval = el.checked ? { group: "", quorum: "any", n: 1, onReject: t.from === "*" ? cur.graph.statuses[0].id : t.from, noSelf: true } : null;
        soft(); page.querySelector("#wf-panel").innerHTML = panelHtml();
      }
    };
    page.addEventListener("input", (e) => { if (e.target.matches("input[type=text],input:not([type]),input[type=number]")) onEdit(e); });
    page.addEventListener("change", (e) => { if (!e.target.matches("input:not([type]),input[type=text]")) onEdit(e); });

    page.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b || b.tagName === "INPUT") return;
      const a = b.dataset.act, g = cur.graph, t = selT();
      if (a === "add-status") return addStatusModal(page);
      if (a === "add-t") return addTransitionModal(page, b.dataset.from || (sel && sel.type === "status" ? sel.id : null));
      if (a === "tidy") {
        g.statuses.forEach((s, i) => { const o = cur.original.statuses.find((x) => x.id === s.id); if (o) { s.x = o.x; s.y = o.y; } else { s.x = 40 + (i % 4) * 230; s.y = 390; } });
        drawCanvas(page); return Admin.toast("Layout tidied");
      }
      if (a === "sel-t") { sel = { type: "transition", id: b.dataset.id }; test = null; return drawAll(page); }
      if (a === "desel") { sel = null; return drawAll(page); }
      if (a === "focus") { const p = problems(g)[+b.dataset.i]; sel = p.focus; test = null; drawAll(page); return page.querySelector("#wf-svg").scrollIntoView({ block: "nearest" }); }
      if (a === "add-cond" && t) { t.conditions.push({ type: "group", v: GROUPS[0] }); soft(); return (page.querySelector("#wf-panel").innerHTML = panelHtml()); }
      if (a === "rm-cond" && t) { t.conditions.splice(+b.dataset.i, 1); soft(); return (page.querySelector("#wf-panel").innerHTML = panelHtml()); }
      if (a === "add-post" && t) { t.post.push({ type: "notify", a: NOTIFY[0] }); soft(); return (page.querySelector("#wf-panel").innerHTML = panelHtml()); }
      if (a === "rm-post" && t) { t.post.splice(+b.dataset.i, 1); soft(); return (page.querySelector("#wf-panel").innerHTML = panelHtml()); }
      if (a === "del-t" && t) { g.transitions = g.transitions.filter((x) => x !== t); sel = null; markDraft(page); drawAll(page); return Admin.toast(`Removed transition “${t.name}” from the draft`); }
      if (a === "del-s" && selS()) return confirmDeleteStatus(page, selS());
      if (a === "set-initial" && selS()) { g.initial = sel.id; markDraft(page); return drawAll(page); }
      if (a === "test-toggle") { test = test ? null : newTest(); return drawAll(page); }
      if (a === "test-reset") { test = newTest(); return drawAll(page); }
      if (a === "test-run") {
        const tt = g.transitions.find((x) => x.id === b.dataset.id), u = TEST_USERS.find((x) => x.id === test.user);
        const from = sName(g, test.status);
        if (tt.approval) { test.waiting = tt.id; test.log.push(`${esc(u.name)} ran <b>${esc(tt.name)}</b> from ${esc(from)}: waiting for ${esc(tt.approval.group)}.`); }
        else { test.status = tt.to; test.log.push(`${esc(u.name)} ran <b>${esc(tt.name)}</b>: ${esc(from)} → ${esc(sName(g, tt.to))}${tt.post.length ? `. Then: ${esc(postSummary(tt))}` : ""}.`); }
        return drawAll(page);
      }
      if (a === "test-approve" || a === "test-decline") {
        const tt = g.transitions.find((x) => x.id === test.waiting);
        const to = a === "test-approve" ? tt.to : tt.approval.onReject;
        test.log.push(a === "test-approve" ? `Mariam Al Suwaidi approved (${esc(tt.approval.group)}). Moved to ${esc(sName(g, to))}${tt.post.length ? `. Then: ${esc(postSummary(tt))}` : ""}.` : `Mariam Al Suwaidi declined. Moved to ${esc(sName(g, to))}.`);
        test.status = to; test.waiting = null;
        return drawAll(page);
      }
      if (a === "publish") return publish(page);
      if (a === "diff") return diffModal();
      if (a === "discard") {
        Admin.modal(`<h2>Discard the draft of “${esc(cur.name)}”?</h2><p>All unpublished changes are lost. ${cur.version ? `Records keep using published version ${cur.version}.` : "This workflow has never been published, so it will be deleted."}</p>
          <div class="row" style="justify-content:flex-end">${ui.btn("Keep draft", { attrs: 'data-m="cancel"' })}${ui.btn("Discard draft", { kind: "danger", attrs: 'data-m="ok"' })}</div>`);
        bindModal((x) => {
          Admin.close();
          if (x !== "ok") return;
          if (!cur.version) { WFS.splice(WFS.indexOf(cur), 1); Admin.toast("Draft deleted (mockup)"); return Admin.navigate("workflows"); }
          cur.graph = clone(cur.original); cur.draft = false; sel = null; test = null; drawAll(page); Admin.toast("Draft discarded");
        });
      }
    });
  }

  // ---------- list, schemes, statuses ----------
  function listTab(q) {
    const rows = WFS.filter((w) => !q || w.name.toLowerCase().includes(q.toLowerCase())).map((w) => {
      const errs = problems(w.graph).filter((p) => p.level === "error").length;
      return [
        `<a href="#/workflows/${w.id}"><b>${esc(w.name)}</b></a>${w.isDefault ? " " + ui.badge("Default", "info") : ""}`,
        statusBadges(w) + (w.draft && errs ? " " + ui.badge(errs + (errs === 1 ? " problem" : " problems"), "bad") : ""),
        esc(w.usedBy), String(w.graph.statuses.length), String(Object.values(w.inflight).reduce((a, b) => a + b, 0)), esc(w.modified),
        `<span class="row" style="flex-wrap:nowrap">${ui.btn("Open designer", { kind: "sm", attrs: `onclick="Admin.navigate('workflows/${w.id}')"` })}${ui.btn("Copy", { kind: "sm ghost", attrs: `data-copy="${w.id}"` })}${ui.btn("Export", { kind: "sm ghost", attrs: `data-export="${w.id}"` })}</span>`,
      ];
    });
    return `<div class="toolbar"><input class="input" id="wf-q" placeholder="Search workflows" value="${esc(q || "")}" aria-label="Search workflows">
      <span class="muted small">${WFS.length} workflows · ${WFS.filter((w) => w.draft).length} with drafts</span></div>
      ${ui.table(["Workflow", "Status", "Used by", "Statuses", "Records", "Last changed", ""], rows, { empty: "No workflow matches your search." })}
      <p class="small muted">A workflow is shared by every team that uses it through the workflow scheme. Edits happen in a draft; records only change when you publish.</p>`;
  }
  function schemesTab() {
    const dirty = JSON.stringify(SCHEME) !== JSON.stringify(schemePublished);
    const pubRow = (r) => schemePublished.find((p) => p.kind === r.kind && p.type === r.type);
    const wfOpts = WFS.map((w) => [w.id, w.name + (w.version ? "" : " (draft)")]);
    return `<div class="callout" style="margin-bottom:12px">The company has one workflow scheme. A record uses the first row that matches its kind and type; otherwise the default row for its kind.</div>
      ${dirty ? `<div class="callout warn row" style="justify-content:space-between;margin-bottom:12px"><span><b>Unpublished scheme changes.</b> Records keep their current workflow until you publish.</span>
        <span class="row">${ui.btn("Discard", { kind: "sm", attrs: 'data-sc="discard"' })}${ui.btn("Publish scheme", { kind: "primary sm", attrs: 'data-sc="publish"' })}</span></div>` : ""}
      <div class="toolbar">${ui.btn("Add mapping", { kind: "primary", ic: "workflow", attrs: 'data-sc="add"' })}<span class="muted small">Record types and categories come from Custom fields.</span></div>
      ${ui.table(["Record kind", "Type or category", "Workflow", "Teams", ""], SCHEME.map((r, i) => {
        const w = W(r.wf), pr = pubRow(r), changed = !pr || pr.wf !== r.wf;
        return [esc(r.kind), esc(r.type), `<select class="input" data-scrow="${i}" aria-label="Workflow for ${esc(r.kind)} ${esc(r.type)}">${opts(wfOpts, r.wf)}</select>
          ${w && !w.version ? `<div class="small" style="color:var(--warning)">Takes effect when this workflow is first published.</div>` : ""}`,
          esc(r.teams) + (changed ? " " + ui.badge(pr ? "Changed" : "New", "warn") : ""),
          r.type.startsWith("Any") ? ui.badge("Default", "info") : ui.btn("Remove", { kind: "sm ghost", attrs: `data-sc="rm" data-i="${i}"` })];
      }))}`;
  }
  function statusesTab() {
    const map = {};
    WFS.forEach((w) => w.graph.statuses.forEach((s) => {
      const m = (map[s.name] = map[s.name] || { name: s.name, cat: s.cat, wfs: [], n: 0 });
      m.wfs.push(w.name); m.n += w.inflight[s.name] || 0;
    }));
    const ar = { Applied: "تم التقديم", Screening: "الفرز", Interview: "مقابلة", Assessment: "تقييم", Offer: "عرض", Hired: "تم التعيين", Rejected: "مرفوض" };
    return `<p class="muted">Statuses are shared by all workflows. The colour comes from the category. A status can be deleted only when no workflow uses it.</p>
      ${ui.table(["Status", "Category", "Arabic name", "Used in", "Records"], Object.values(map).map((s) => [
        `<b>${esc(s.name)}</b>`, ui.badge(CAT_LABEL[s.cat], s.cat === "done" ? "ok" : s.cat === "prog" ? "info" : ""), ar[s.name] ? `<span dir="rtl">${ar[s.name]}</span>` : `<span class="muted small">Not translated</span>`,
        esc(s.wfs.join(", ")), String(s.n)]))}`;
  }
  function createModal() {
    Admin.modal(`<h2>Create workflow</h2>
      ${ui.field("Name", `<input class="input" id="wf-new-name" placeholder="For example: Graduate hiring">`)}
      ${ui.field("Start from", `<select class="input" id="wf-new-from">${opts(WFS.map((w) => [w.id, "Copy of " + w.name]), "applications")}</select>`)}
      <p class="small muted">It starts as a draft and is not used until you add it to the workflow scheme and publish.</p>
      <div id="wf-new-err" class="small" style="color:var(--danger)"></div>
      <div class="row" style="justify-content:flex-end">${ui.btn("Cancel", { attrs: 'data-m="cancel"' })}${ui.btn("Create draft", { kind: "primary", attrs: 'data-m="ok"' })}</div>`);
    bindModal((a, b, m) => {
      if (a === "cancel") return Admin.close();
      const name = m.querySelector("#wf-new-name").value.trim();
      if (!name) return (m.querySelector("#wf-new-err").textContent = "Enter a name.");
      const src = W(m.querySelector("#wf-new-from").value), id = "wf-" + ++seq;
      const w = { id, name, version: 0, draft: true, kind: src.kind, usedBy: "Not in the scheme yet", teams: 0, modified: "Just now · Omar Alshair", graph: clone(src.graph), inflight: {}, publishedNames: [] };
      w.original = clone(w.graph); WFS.push(w); Admin.close(); Admin.navigate("workflows/" + id);
    });
  }
  function schemePublishModal() {
    const changes = SCHEME.map((r) => ({ r, old: schemePublished.find((p) => p.kind === r.kind && p.type === r.type) })).filter((x) => !x.old || x.old.wf !== x.r.wf);
    const recs = changes.reduce((a, x) => a + (x.old ? Object.entries(W(x.old.wf) ? W(x.old.wf).inflight : {}).length * 2 : 0), 0);
    Admin.modal(`<h2>Publish workflow scheme changes?</h2>
      <ul>${changes.map((x) => `<li>${esc(x.r.kind)} · ${esc(x.r.type)}: ${x.old ? esc((W(x.old.wf) || {}).name || "–") + " → " : "new: "}<b>${esc(W(x.r.wf).name)}</b> (${esc(x.r.teams)})</li>`).join("")}</ul>
      <p>About <b>${recs}</b> records change workflow. Statuses with the same name are kept; the migration wizard asks where the others go.</p>
      <div class="row" style="justify-content:flex-end">${ui.btn("Cancel", { attrs: 'data-m="cancel"' })}${ui.btn("Continue to migration", { kind: "primary", attrs: 'data-m="ok"' })}</div>`);
    bindModal((a) => {
      Admin.close();
      if (a === "ok") { schemePublished = clone(SCHEME); Admin.toast("Scheme published (mockup). Migration job started."); Admin.rerender(); }
    });
  }
  function addMappingModal() {
    Admin.modal(`<h2>Add mapping</h2>
      ${ui.field("Record kind", `<select class="input" id="sc-kind">${opts(pairs(["Application", "Vacancy", "Offer", "Interview", "Onboarding"]), "Application")}</select>`)}
      ${ui.field("Type or category", `<select class="input" id="sc-type">${opts(pairs(["Vacancy category: Finance", "Vacancy category: Marketing", "Vacancy category: Internship", "Vacancy type: Contract"]), "Vacancy category: Finance")}</select>`)}
      ${ui.field("Workflow", `<select class="input" id="sc-wf">${opts(WFS.map((w) => [w.id, w.name]), "applications")}</select>`)}
      ${ui.field("Teams", `<select class="input" id="sc-team">${opts(pairs(["All teams", "Talent Acquisition", "Executive Search", "Graduate Hiring"]), "All teams")}</select>`)}
      <div class="row" style="justify-content:flex-end">${ui.btn("Cancel", { attrs: 'data-m="cancel"' })}${ui.btn("Add to draft", { kind: "primary", attrs: 'data-m="ok"' })}</div>`);
    bindModal((a, b, m) => {
      if (a === "ok") SCHEME.splice(SCHEME.length - 2, 0, { kind: m.querySelector("#sc-kind").value, type: m.querySelector("#sc-type").value, wf: m.querySelector("#sc-wf").value, teams: m.querySelector("#sc-team").value });
      Admin.close(); if (a === "ok") Admin.rerender();
    });
  }

  const STYLE = `<style>
    .wf-designer{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;align-items:start}
    .wf-canvas{background-color:var(--surface);background-image:radial-gradient(var(--border) 1px,transparent 1px);background-size:18px 18px;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
    .wf-canvas svg{display:block;width:100%;height:auto;touch-action:none;user-select:none;-webkit-user-select:none;font-family:inherit}
    .wf-node{cursor:grab;outline:none}.dragging,.dragging .wf-node{cursor:grabbing}
    .wf-node>rect:first-of-type{stroke-width:1.5}
    .wf-node.todo>rect:first-of-type{fill:var(--surface-subtle);stroke:var(--border-strong)}.wf-node.todo .cat{fill:var(--muted)}
    .wf-node.prog>rect:first-of-type{fill:var(--primary-soft);stroke:var(--primary)}.wf-node.prog .cat{fill:var(--primary)}
    .wf-node.done>rect:first-of-type{fill:var(--success-bg);stroke:var(--success)}.wf-node.done .cat{fill:var(--success)}
    .wf-node.bad>rect:first-of-type{stroke:var(--danger);stroke-dasharray:5 3;stroke-width:2}
    .wf-node.sel>rect:first-of-type,.wf-node:focus-visible>rect:first-of-type{stroke:var(--focus);stroke-width:3;stroke-dasharray:none}
    .wf-node.cur>rect:first-of-type{stroke:var(--warning);stroke-width:3.5;stroke-dasharray:none}
    .wf-node .nm{fill:var(--text);font-weight:700;font-size:13px}.wf-node .ct{fill:var(--muted);font-size:11px}.wf-node .tst{fill:var(--warning);font-size:9px;font-weight:700}
    .wf-edge .line{fill:none;stroke:var(--muted);stroke-width:1.6}.wf-edge .hit{fill:none;stroke:transparent;stroke-width:14;cursor:pointer}
    .wf-edge.bad .line{stroke:var(--danger)}.wf-edge.sel .line{stroke:var(--focus);stroke-width:2.6}
    .wf-edge .lbl{cursor:pointer}.wf-edge .lbl rect{fill:var(--surface);stroke:var(--border-strong)}.wf-edge .lbl text{fill:var(--text);font-size:11.5px}
    .wf-edge.appr .lbl rect{stroke:var(--primary);stroke-dasharray:4 2;stroke-width:1.5}.wf-edge.global .lbl rect{fill:var(--surface-subtle)}
    .wf-edge.bad .lbl rect{stroke:var(--danger)}.wf-edge.sel .lbl rect{stroke:var(--focus);stroke-width:2.5;stroke-dasharray:none;fill:var(--primary-soft)}.wf-edge.sel .lbl text{font-weight:700}
    .wf-edge:hover .line{stroke-width:2.4}
    .wf-init circle{fill:var(--text)}.wf-init path{stroke:var(--muted);stroke-width:1.6;fill:none}
    #wf-arr path{fill:var(--muted)}#wf-arr-sel path{fill:var(--focus)}#wf-arr-bad path{fill:var(--danger)}
    .wf-panel{position:sticky;top:0;max-height:calc(100vh - 110px);overflow-y:auto}
    .wf-sec{border-top:1px solid var(--border);padding-top:10px;margin-top:12px}.wf-sec h3{margin:0}
    .wf-rule{display:flex;gap:6px;align-items:center;margin:6px 0}.wf-rule .input{min-width:0}
    .wf-num{font-size:11px;color:var(--muted);min-width:14px}
    select.input.wf-op{width:auto;padding:3px 6px;font-size:12px}
    .wf-two{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .wf-chips{display:flex;flex-wrap:wrap;gap:4px 12px;margin:6px 0}
    .wf-ul{margin:4px 0 10px;padding-inline-start:18px}
    .wf-sw{display:inline-block;width:18px;height:12px;border-radius:4px;border:1.5px solid}
    .wf-sw.todo{background:var(--surface-subtle);border-color:var(--border-strong)}.wf-sw.prog{background:var(--primary-soft);border-color:var(--primary)}
    .wf-sw.done{background:var(--success-bg);border-color:var(--success)}.wf-sw.appr{border-style:dashed;border-color:var(--primary)}
    .wf-try{border:1px solid var(--border);border-radius:10px;padding:8px 10px;margin:6px 0}.wf-try.no{background:var(--surface-subtle)}
    .wf-res{list-style:none;margin:6px 0 0;padding:0;font-size:12px}.wf-res .ok{color:var(--success)}.wf-res .no{color:var(--danger)}.wf-res .i{color:var(--muted)}
    .wf-log{margin:4px 0 12px;padding-inline-start:20px;font-size:12px}
    .wf-steps{display:flex;gap:6px;margin:6px 0 14px;flex-wrap:wrap}.wf-steps span{padding:3px 10px;border-radius:999px;font-size:12px;background:var(--surface-subtle);color:var(--muted);border:1px solid var(--border)}
    .wf-steps span.on{background:var(--primary-soft);color:var(--primary-text);font-weight:700;border-color:transparent}.wf-steps span.done{color:var(--success)}
    @media (max-width:1100px){.wf-designer{grid-template-columns:1fr}.wf-panel{position:static;max-height:none}}
  </style>`;

  Admin.register({
    id: "workflows",
    group: "Configuration",
    title: "Workflows",
    icon: "workflow",
    spec: ["WFL-001", "WFL-002", "WFL-011", "WFL-012", "WFL-020", "WFL-030", "WFL-040", "WFL-070", "WFL-071", "WFL-072", "WFL-073", "Designer §11"],
    changes: "New. Today the pipeline stages are fixed in code. Admins can now design workflows with rules, approvals and a test run, map them to vacancy categories, and publish with a migration wizard.",
    render(ctx) {
      const id = ctx.params[0];
      if (id) {
        const w = W(id);
        if (!w) return ui.pageHeader("Workflow not found", "", "", `<a href="#/workflows">Workflows</a>`) + `<p>No workflow called <code>${esc(id)}</code>. <a href="#/workflows">Back to workflows</a>.</p>`;
        if (cur !== w) { cur = w; sel = null; test = null; }
        if (ctx.state !== "normal")
          return ui.pageHeader(w.name, "Workflow designer", "", `<a href="#/workflows">Workflows</a> / ${esc(w.name)}`) +
            ui.stateBlock(ctx.state, { emptyTitle: "This workflow has no statuses yet", emptyText: "Add the first status, for example Applied, then add transitions between statuses.", emptyAction: ui.btn("Add status", { kind: "primary", attrs: "onclick=\"Admin.setState('normal')\"" }) });
        return STYLE + `<div id="wf-page"><div id="wf-head"></div>
          <div class="toolbar">${ui.btn("Add status", { kind: "primary", ic: "workflow", attrs: 'data-act="add-status"' })}${ui.btn("Add transition", { attrs: 'data-act="add-t"' })}${ui.btn("Tidy layout", { kind: "ghost", attrs: 'data-act="tidy"' })}
            <span class="muted small">Drag statuses to arrange them (arrow keys also move a selected status). Click an arrow label to edit a transition.</span></div>
          <div class="wf-designer"><div>
            <div class="wf-canvas" dir="ltr"><svg id="wf-svg" viewBox="0 0 ${VB_W} ${VB_H}" role="group" aria-label="Workflow diagram for ${esc(w.name)}">
              <defs>${[["wf-arr"], ["wf-arr-sel"], ["wf-arr-bad"]].map(([m]) => `<marker id="${m}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker>`).join("")}</defs>
              <g id="wf-lines"></g><g id="wf-nodes"></g><g id="wf-labels"></g></svg></div>
            <div class="card" id="wf-problems" style="margin-top:16px"></div>
            <details class="card" style="margin-top:16px"><summary><b>Transitions as a table</b> <span class="muted small">(text view for review and screen readers)</span></summary><div id="wf-table" style="margin-top:10px"></div></details>
          </div><aside class="card wf-panel" id="wf-panel" aria-live="polite"></aside></div></div>`;
      }
      const tab = ctx.query.get("tab") || "workflows";
      const head = ui.pageHeader("Workflows", "Statuses, transitions, rules and approvals that records move through. Defined once for the company and shared by every team.",
        ui.btn("Create workflow", { kind: "primary", ic: "workflow", attrs: 'data-create="1"' }) + ui.btn("Import JSON", { attrs: 'data-import="1"' }));
      if (ctx.state !== "normal")
        return head + ui.stateBlock(ctx.state, { emptyTitle: "No workflows yet", emptyText: "Records use the built-in pipeline Applied → Screening → Interview → Assessment → Offer → Hired / Rejected until you create a workflow.", emptyAction: ui.btn("Create workflow", { kind: "primary", attrs: "onclick=\"Admin.setState('normal')\"" }) });
      const body = tab === "schemes" ? schemesTab() : tab === "statuses" ? statusesTab() : listTab(ctx.query.get("q"));
      return STYLE + head + ui.tabs("wf", [{ id: "workflows", label: "Workflows" }, { id: "schemes", label: "Workflow schemes" }, { id: "statuses", label: "Statuses" }], tab) + `<div id="wf-list">${body}</div>`;
    },
    mount(root, ctx) {
      if (ctx.state !== "normal") return;
      if (ctx.params[0]) return mountDesigner(root);
      const list = root.querySelector("#wf-list");
      root.querySelector("[data-create]").addEventListener("click", createModal);
      root.querySelector("[data-import]").addEventListener("click", () => Admin.toast("Import: choose a workflow JSON file (mockup). Missing statuses can be created."));
      if (!list) return;
      const q = list.querySelector("#wf-q");
      const onSearch = (e) => {
        const pos = e.target.selectionStart;
        list.innerHTML = listTab(e.target.value);
        const nq = list.querySelector("#wf-q"); nq.focus(); nq.setSelectionRange(pos, pos);
        nq.addEventListener("input", onSearch);
      };
      if (q) q.addEventListener("input", onSearch);
      list.addEventListener("click", (e) => {
        const c = e.target.closest("[data-copy]"), x = e.target.closest("[data-export]"), sc = e.target.closest("[data-sc]");
        if (c) { const src = W(c.dataset.copy), id = "wf-" + ++seq; const w = { id, name: "Copy of " + src.name, version: 0, draft: true, kind: src.kind, usedBy: "Not in the scheme yet", teams: 0, modified: "Just now · Omar Alshair", graph: clone(src.graph), inflight: {}, publishedNames: [] }; w.original = clone(w.graph); WFS.push(w); Admin.toast("Copied as a new draft"); Admin.rerender(); }
        if (x) Admin.toast(`Exported ${W(x.dataset.export).name}.json (mockup)`);
        if (sc) {
          const a = sc.dataset.sc;
          if (a === "add") addMappingModal();
          if (a === "discard") { SCHEME.splice(0, SCHEME.length, ...clone(schemePublished)); Admin.rerender(); }
          if (a === "publish") schemePublishModal();
          if (a === "rm") { const r = SCHEME[+sc.dataset.i]; Admin.modal(`<h2>Remove mapping?</h2><p>${esc(r.kind)} · ${esc(r.type)} records (${esc(r.teams)}) will use the default ${esc(r.kind)} workflow after you publish the scheme.</p><div class="row" style="justify-content:flex-end">${ui.btn("Cancel", { attrs: 'data-m="cancel"' })}${ui.btn("Remove", { kind: "danger", attrs: 'data-m="ok"' })}</div>`); bindModal((m) => { Admin.close(); if (m === "ok") { SCHEME.splice(+sc.dataset.i, 1); Admin.toast("Removed from the scheme draft. Publish the scheme to apply."); Admin.rerender(); } }); }
        }
      });
      list.addEventListener("change", (e) => {
        const s = e.target.closest("[data-scrow]");
        if (s) { SCHEME[+s.dataset.scrow].wf = s.value; Admin.rerender(); }
      });
    },
  });
})();
