/* Health & monitoring: checks, usage, storage, speed, database; Vercel vs self-hosted (Linux servers). Spec 09 §1-3, §5, §7, §10. */
(function () {
  const S = { mode: "vercel", range: "Last 24 hours", checked: {} };
  const esc = Admin.ui.esc;
  const N = (s) => `<bdi dir="ltr">${s}</bdi>`;

  // ---------- deterministic sample series ----------
  const wave = (n, base, amp, seed, min = 0) => Array.from({ length: n }, (_, i) => Math.max(min, Math.round(base + amp * Math.sin((i + seed) * 0.62) + amp * 0.45 * Math.sin((i * (seed + 3)) % 11))));
  const DAYS = Array.from({ length: 30 }, (_, i) => { const d = new Date(Date.UTC(2026, 9, 12 + i)); return d; });
  const REQ = DAYS.map((d, i) => { const wd = d.getUTCDay(); const weekend = wd === 6 || wd === 0; return Math.round((weekend ? 1900 : 7600) + 900 * Math.sin(i * 0.9) + i * 60); });

  // ---------- SVG charts (no libraries) ----------
  function spark(vals, { w = 120, h = 30, color = "var(--primary)", label = "Trend", max } = {}) {
    const hi = max ?? Math.max(...vals), lo = max != null ? 0 : Math.min(...vals), span = hi - lo || 1;
    const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1)}`).join(" ");
    return `<svg class="hm-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" style="stroke:${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }
  function areaChart(vals, labels, { h = 170, unit = "requests" } = {}) {
    const W = 640, H = h, pl = 44, pr = 8, pt = 10, pb = 22;
    const max = Math.ceil(Math.max(...vals) / 2000) * 2000;
    const x = (i) => pl + (i / (vals.length - 1)) * (W - pl - pr), y = (v) => pt + (1 - v / max) * (H - pt - pb);
    const line = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const grid = [0, 0.5, 1].map((f) => `<line x1="${pl}" x2="${W - pr}" y1="${y(max * f)}" y2="${y(max * f)}" style="stroke:var(--border)" stroke-width="1"/><text x="${pl - 6}" y="${y(max * f) + 4}" text-anchor="end" style="fill:var(--muted)" font-size="10">${(max * f).toLocaleString("en-GB")}</text>`).join("");
    const last = labels.length - 1;
    const ticks = labels.map((l, i) => ((i % 7 === 0 && last - i >= 4) || i === last ? `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === last ? "end" : "middle"}" style="fill:var(--muted)" font-size="10">${l}</text>` : "")).join("");
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Requests per day, last 30 days, between ${Math.min(...vals).toLocaleString("en-GB")} and ${Math.max(...vals).toLocaleString("en-GB")} ${unit}" style="display:block;direction:ltr">
      ${grid}<polygon points="${pl},${y(0)} ${line} ${W - pr},${y(0)}" style="fill:var(--primary-soft)"/><polyline points="${line}" fill="none" style="stroke:var(--primary)" stroke-width="2"/>${ticks}</svg>`;
  }
  const dots = (hist) => `<span class="hm-dots" aria-label="Last 7 days">${hist.map((s) => `<i class="${s}" title="${s === "ok" ? "Passing" : s === "warn" ? "Warning" : "Failing"}"></i>`).join("")}</span>`;
  const statusBadge = (s) => Admin.ui.badge(s === "ok" ? "Passing" : s === "warn" ? "Warning" : "Failing", s);

  // ---------- data per mode ----------
  function checks() {
    const v = S.mode === "vercel";
    return [
      { id: "db", name: "Database", what: v ? "Neon Postgres (Frankfurt) answers a test query" : "PostgreSQL 16 on db-01 answers a test query", status: "ok", last: "1 min ago", dur: v ? "18 ms" : "2 ms", hist: ["ok", "ok", "ok", "ok", "ok", "ok", "ok"], fix: "If this fails: check the database is running and the connection string is correct. Records cannot be opened or saved while it is down." },
      { id: "cv", name: "CV storage", what: v ? "Vercel Blob: write, read and delete a test file" : "/srv/recruitmentos/cv on db-01: write, read and delete a test file", status: v ? "ok" : "warn", note: v ? "" : "Disk is 82 % full (warning at 80 %)", last: "1 min ago", dur: v ? "142 ms" : "9 ms", hist: v ? ["ok", "ok", "ok", "ok", "ok", "ok", "ok"] : ["ok", "ok", "ok", "ok", "warn", "warn", "warn"], fix: v ? "If this fails: check the Vercel Blob token in the project settings. CV uploads and downloads stop while it fails." : "Free up space on db-01 or grow the disk. Uploads stop when the disk is 95 % full. Old import files in /srv/recruitmentos/tmp can be removed safely." },
      { id: "mail", name: "Email provider", what: "Resend accepts a test request (no email is sent)", status: "ok", note: "2 older messages wait in the error queue", last: "1 min ago", dur: "96 ms", hist: ["ok", "ok", "warn", "ok", "ok", "ok", "ok"], fix: "If this fails: check the Resend API key on the Outgoing mail page. Emails wait in the queue and are sent when it recovers.", link: ["Outgoing mail", "mail?tab=queue"] },
      { id: "jobs", name: "Background jobs", what: v ? "Vercel Cron: digest, reminders and clean-up ran on time" : "systemd timers on app-01: digest, reminders and clean-up ran on time", status: "ok", last: "08:00 today", dur: "—", hist: ["ok", "ok", "ok", "ok", "ok", "ok", "ok"], fix: "If this fails: digests and reminders are late. Check the job schedule and the last error below." },
      { id: "signin", name: "Sign-in", what: "Sign-in page loads and the Google sign-in callback address is reachable", status: "ok", last: "5 min ago", dur: "210 ms", hist: ["ok", "ok", "ok", "ok", "ok", "ok", "ok"], fix: "If this fails: nobody can sign in. Check the domain and the sign-in callback address on the Domain page.", link: ["Domain", "domain"] },
    ];
  }
  const SERVERS = [
    { id: "app-01", role: "App server", spec: "Ubuntu 24.04 · Node.js 22 · 4 vCPU · 8 GB", cpu: 34, mem: 61, disk: 48, up: "41 days", load: "1.12 · 0.98 · 0.87", seed: 1 },
    { id: "app-02", role: "App server", spec: "Ubuntu 24.04 · Node.js 22 · 4 vCPU · 8 GB", cpu: 29, mem: 57, disk: 46, up: "41 days", load: "0.94 · 0.90 · 0.81", seed: 4 },
    { id: "db-01", role: "Database and CV files", spec: "Ubuntu 24.04 · PostgreSQL 16 · 8 vCPU · 32 GB", cpu: 22, mem: 71, disk: 82, up: "97 days", load: "1.64 · 1.51 · 1.47", seed: 7 },
  ];
  const TH = [
    { m: "CPU", warn: 80, crit: 95, unit: "%" },
    { m: "Memory", warn: 85, crit: 95, unit: "%" },
    { m: "Disk", warn: 80, crit: 90, unit: "%" },
    { m: "Database connections", warn: 80, crit: 95, unit: "% of max" },
    { m: "Page speed (p95)", warn: 1000, crit: 3000, unit: "ms" },
    { m: "Health check failing", warn: 2, crit: 5, unit: "minutes" },
  ];
  const ROUTES = [
    ["Page", "/candidates", 1840, 210, 540], ["Page", "/pipeline", 1320, 260, 720], ["Page", "/candidates/[id]", 2210, 190, 480], ["Page", "/vacancies", 610, 170, 410], ["Page", "/admin", 120, 230, 610],
    ["API", "GET /api/candidates", 3900, 85, 240], ["API", "POST /api/applications/[id]/move", 410, 120, 380], ["API", "POST /api/cv/upload", 64, 640, 1850], ["API", "GET /api/search", 980, 140, 690],
  ];
  const QUERIES = [
    ["SELECT … FROM applications JOIN candidates … WHERE team_id = $1 ORDER BY updated_at DESC LIMIT $2", 1240, 38, 612],
    ["SELECT … FROM audit_log WHERE created_at BETWEEN $1 AND $2 ORDER BY created_at DESC", 42, 210, 940],
    ["UPDATE applications SET stage = $1, updated_at = now() WHERE id = $2", 318, 12, 520],
    ["SELECT … FROM candidates WHERE search_vector @@ plainto_tsquery($1) AND team_id = $2", 980, 24, 310],
  ];
  const KINDS = [["Candidate", 103], ["Job role", 24], ["Vacancy", 16], ["Application", 148], ["Interview", 61], ["Offer", 9], ["Onboarding", 5], ["Team task", 87]];
  const CV = [["Talent Acquisition", 214, 2], ["Executive Search", 61, 1], ["Graduate Hiring", 43, 2]]; // KB used, GB limit

  const STYLE = `<style>
    .hm-seg{display:inline-flex;border:1px solid var(--border-strong);border-radius:10px;overflow:hidden;background:var(--surface)}
    .hm-seg button{border:0;background:none;padding:7px 14px;cursor:pointer;display:inline-flex;gap:6px;align-items:center;color:var(--text)}
    .hm-seg button+button{border-inline-start:1px solid var(--border-strong)}
    .hm-seg button[aria-pressed="true"]{background:var(--primary-soft);color:var(--primary-text);font-weight:700}
    .hm-dots{display:inline-flex;gap:3px}
    .hm-dots i{width:9px;height:14px;border-radius:2px;background:var(--success)}
    .hm-dots i.warn{background:var(--warning)} .hm-dots i.bad{background:var(--danger)}
    .hm-click{cursor:pointer}
    .hm-sec{margin:24px 0 10px;display:flex;align-items:baseline;gap:10px}
    .hm-sec h2{margin:0}
    .hm-m{display:grid;grid-template-columns:70px 1fr 44px;gap:8px;align-items:center;margin:6px 0}
    .hm-m .v{text-align:end;font-weight:700;font-variant-numeric:tabular-nums}
    .hm-bar.warn>span{background:var(--warning)} .hm-bar.bad>span{background:var(--danger)}
    .hm-hbar{display:grid;grid-template-columns:100px 1fr 48px;gap:8px;align-items:center;margin:5px 0}
    .hm-hbar .v{text-align:end;font-variant-numeric:tabular-nums}
    .hm-spark{display:block;max-width:100%}
    .hm-kv{display:grid;grid-template-columns:150px 1fr;gap:6px 12px;margin:0}
    .hm-kv dt{color:var(--muted)} .hm-kv dd{margin:0}
    .hm-code{font-family:ui-monospace,Consolas,monospace;font-size:12px;direction:ltr;unicode-bidi:embed}
    td.num,th.num{text-align:end!important;font-variant-numeric:tabular-nums}
  </style>`;

  const tone = (pct, warn = 80, crit = 90) => (pct >= crit ? "bad" : pct >= warn ? "warn" : "");
  const meter = (label, pct, extra = "") => `<div class="hm-m"><span class="small muted">${label}</span><div class="bar hm-bar ${tone(pct)}"><span style="width:${pct}%"></span></div><span class="v small">${N(pct + "%")}</span></div>${extra}`;

  // ---------- sections ----------
  function checksCard() {
    const list = checks();
    const rows = list.map((c) => `<tr class="hm-click" tabindex="0" onclick="HealthPage.check('${c.id}')" onkeydown="if(event.key==='Enter')HealthPage.check('${c.id}')">
      <td><b>${c.name}</b><div class="small muted">${esc(c.what)}</div>${c.note ? `<div class="small" style="color:var(--${c.status === "warn" ? "warning" : "muted"})">${esc(c.note)}</div>` : ""}</td>
      <td>${statusBadge(c.status)}</td><td class="small"><bdi>${esc(S.checked[c.id] || c.last)}</bdi></td><td class="small">${N(c.dur)}</td><td>${dots(c.hist)}</td>
      <td>${Admin.ui.btn("Run now", { kind: "sm", attrs: `onclick="event.stopPropagation();HealthPage.run('${c.id}')"` })}</td></tr>`).join("");
    return `<div class="table-wrap"><table class="t"><thead><tr><th>Check</th><th>Status</th><th>Last checked</th><th>Took</th><th>7 days</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  function vercelCard() {
    return `<div class="grid g2">
      <div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Vercel functions</h2>${Admin.ui.badge("Region fra1 · Frankfurt", "info")}</div>
        <div class="grid g3" style="margin-top:12px">
          <div><div class="kpi-label">Invocations (24 h)</div><div class="kpi" style="font-size:20px">18,420</div>${spark(wave(24, 760, 260, 2, 120), { label: "Invocations per hour" })}</div>
          <div><div class="kpi-label">Errors</div><div class="kpi" style="font-size:20px">${N("0.1 %")}</div><div class="small muted">${N("19 of 18,420")}</div></div>
          <div><div class="kpi-label">Duration p95</div><div class="kpi" style="font-size:20px">${N("410 ms")}</div><div class="small muted">limit ${N("60 s")}</div></div>
        </div>
        <div class="callout small" style="margin-top:12px"><b>Cold starts:</b> about 4 % of requests start a fresh function, which adds roughly 300 ms. This happens most after quiet periods (early morning). Nothing to fix; it is normal on Vercel.</div></div>
      <div class="card"><h2>Where things run</h2>
        <dl class="hm-kv"><dt>App</dt><dd>Vercel · fra1 (Frankfurt)</dd><dt>Database</dt><dd>Neon Postgres · aws-eu-central-1 (Frankfurt)</dd><dt>CV files</dt><dd>Vercel Blob</dd><dt>Email</dt><dd>Resend · eu-west-1 (Ireland)</dd><dt>Version</dt><dd><span class="hm-code">1.0.0 · build 20261110.1133 · deployed today 07:12</span></dd></dl>
        <p class="small muted" style="margin-bottom:0">No servers to manage. Vercel adds capacity on its own, so CPU, memory and disk are not shown. Switch to “Self-hosted” above to see what this page shows on your own Linux servers.</p></div></div>`;
  }
  function serversSection() {
    const cards = SERVERS.map((s) => {
      const worst = Math.max(s.cpu >= 80 ? 2 : 0, s.mem >= 85 ? 2 : 0, s.disk >= 90 ? 3 : s.disk >= 80 ? 2 : 0);
      return `<div class="card"><div class="row" style="justify-content:space-between"><div><h2 style="margin:0">${s.id}</h2><div class="small muted">${s.role}</div></div>${worst === 3 ? Admin.ui.badge("Critical", "bad") : worst === 2 ? Admin.ui.badge("Warning", "warn") : Admin.ui.badge("Healthy", "ok")}</div>
        <div class="small muted" style="margin:6px 0 10px">${s.spec}</div>
        ${meter("CPU", s.cpu)}${spark(wave(48, s.cpu, 9, s.seed, 2), { w: 260, h: 26, label: s.id + " CPU, last 24 hours", max: 100 })}
        ${meter("Memory", s.mem)}${spark(wave(48, s.mem, 4, s.seed + 1, 2), { w: 260, h: 26, label: s.id + " memory, last 24 hours", max: 100 })}
        ${meter("Disk", s.disk)}${s.disk >= 80 ? `<div class="small" style="color:var(--warning)">Above the 80 % warning. About 3 weeks until 90 % at the current rate.</div>` : ""}
        <dl class="hm-kv" style="margin-top:10px;grid-template-columns:100px 1fr"><dt>Uptime</dt><dd>${N(s.up)}</dd><dt>Load (1/5/15)</dt><dd class="hm-code">${s.load}</dd></dl></div>`;
    }).join("");
    const th = TH.map((t, i) => [`<b>${t.m}</b>`, `<div class="row" style="flex-wrap:nowrap">${Admin.ui.input(String(t.warn), `style="width:80px" aria-label="${t.m} warning" data-th="${i}" data-k="warn"`)}<span class="small muted">${t.unit}</span></div>`, `<div class="row" style="flex-wrap:nowrap">${Admin.ui.input(String(t.crit), `style="width:80px" aria-label="${t.m} critical" data-th="${i}" data-k="crit"`)}<span class="small muted">${t.unit}</span></div>`]);
    return `<div class="hm-sec"><h2>Servers</h2><span class="small muted">3 Linux servers · from the RecruitmentOS agent on each server, every 60 s</span></div>
      <div class="grid g3">${cards}</div>
      <div class="grid g2" style="margin-top:16px">
        <div class="card"><h2>Alert thresholds</h2>${Admin.ui.table(["Metric", "Warning at", "Critical at"], th)}
          <div style="margin-top:12px">${Admin.ui.field("Send alerts to", Admin.ui.select(["system-administrators (email + in-app)", "hr-leadership (email + in-app)", "Omar Alshair only"], "system-administrators (email + in-app)"), "One alert per problem, and another when it recovers.")}</div>
          ${Admin.ui.btn("Save thresholds", { kind: "primary", attrs: `onclick="HealthPage.saveTh()"` })}</div>
        <div class="card"><h2>For your load balancer and monitoring</h2>
          <dl class="hm-kv"><dt>Is it running?</dt><dd class="hm-code">GET /health/live</dd><dt>Ready for traffic?</dt><dd class="hm-code">GET /health/ready</dd><dt>Public status</dt><dd class="hm-code">GET /status → {"state":"RUNNING"}</dd><dt>Metrics</dt><dd class="hm-code">GET /metrics (Prometheus, internal network only)</dd></dl>
          <p class="small muted">Use these with your own tools (Grafana, Zabbix) alongside this page.</p>
          <h3>Recent alerts</h3><ul class="list-plain small">
            <li class="row">${Admin.ui.badge("Warning", "warn")} db-01 disk above 80 % · since 7 Nov 02:10 · still open</li>
            <li class="row">${Admin.ui.badge("Recovered", "ok")} app-02 CPU above 80 % for 6 min · 5 Nov 14:22</li></ul></div></div>`;
  }
  function usageSection() {
    const labels = DAYS.map((d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }));
    const max = Math.max(...KINDS.map((k) => k[1]));
    return `<div class="hm-sec"><h2>Usage</h2><span class="small muted">Counted every night at 02:00 (Asia/Dubai)</span><span style="flex:1"></span>${Admin.ui.btn("Export CSV", { kind: "sm", attrs: `onclick="Admin.toast('Usage exported (mockup)')"` })}</div>
      <div class="grid g3" style="margin-bottom:16px">
        ${Admin.ui.kpi("Active users today", "6", "of 8 people with access")}
        ${Admin.ui.kpi("Active in last 7 days", "7", "1 invited, not signed in yet")}
        ${Admin.ui.kpi("Active in last 30 days", "8", "Daniel Okafor is now suspended")}</div>
      <div class="split" style="grid-template-columns:minmax(0,1fr) 360px">
        <div class="card"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Requests per day</h3><span class="small muted">last 30 days · today ${REQ[REQ.length - 1].toLocaleString("en-GB")}</span></div>${areaChart(REQ, labels)}
          <p class="small muted" style="margin:4px 0 0">Lower at weekends (Saturday and Sunday).</p></div>
        <div class="card"><h3>Records by kind</h3>${KINDS.map(([k, n]) => `<div class="hm-hbar"><span class="small">${k}</span><div class="bar"><span style="width:${(n / max) * 100}%"></span></div><span class="v small">${n}</span></div>`).join("")}
          <p class="small muted" style="margin:6px 0 0">All 3 teams. Archived records included.</p></div></div>`;
  }
  function storageSection() {
    const v = S.mode === "vercel";
    const dbMax = v ? 512 : 200 * 1024;
    return `<div class="hm-sec"><h2>Storage</h2></div>
      <div class="grid g2">
        <div class="card"><h3>Database</h3>
          <div class="row" style="justify-content:space-between"><span>${v ? "Neon Postgres" : "PostgreSQL on db-01"}</span><b>${N("41 MB of " + (v ? "512 MB" : "200 GB"))}</b></div>${Admin.ui.bar(Math.max(1.5, (41 / dbMax) * 100))}
          <table class="t" style="margin-top:10px"><thead><tr><th>Largest tables</th><th class="num">Size</th><th class="num">Rows</th></tr></thead><tbody>
            <tr><td class="hm-code">applications</td><td class="num">${N("9.8 MB")}</td><td class="num">148</td></tr><tr><td class="hm-code">audit_log</td><td class="num">${N("7.1 MB")}</td><td class="num">4,212</td></tr><tr><td class="hm-code">notifications</td><td class="num">${N("6.4 MB")}</td><td class="num">3,880</td></tr><tr><td class="hm-code">candidates</td><td class="num">${N("4.2 MB")}</td><td class="num">103</td></tr></tbody></table></div>
        <div class="card"><h3>CV storage by team</h3><div class="small muted" style="margin-bottom:8px">${v ? "Vercel Blob" : "/srv/recruitmentos/cv on db-01"} · ${N("318 KB used of 5 GB")}</div>
          ${CV.map(([t, kb, gb]) => `<div style="margin-bottom:10px"><div class="row" style="justify-content:space-between"><span>${t}</span><span class="small">${N(`<b>${kb} KB</b> of ${gb} GB`)}</span></div>${Admin.ui.bar(Math.max(1.5, (kb / (gb * 1048576)) * 100))}</div>`).join("")}
          <p class="small muted" style="margin:0">Limits per team are set on the <a href="#/teams">Teams</a> page. Uploads stop at the limit; admins get a warning at 80 %.</p></div></div>`;
  }
  function speedSection() {
    const rows = ROUTES.map(([k, r, n, p50, p95], i) => `<tr><td>${Admin.ui.badge(k, k === "Page" ? "info" : "")}</td><td class="hm-code">${esc(r)}</td><td class="num">${n.toLocaleString("en-GB")}</td><td class="num">${N(p50 + " ms")}</td><td class="num">${N(p95 >= 1000 ? `<span style="color:var(--warning);font-weight:700">${p95.toLocaleString("en-GB")} ms</span>` : p95 + " ms")}</td><td>${spark(wave(24, p95, p95 * 0.12, i + 2, 10), { w: 90, h: 22, label: "p95 trend for " + r })}</td></tr>`).join("");
    const q = QUERIES.map(([sql, n, mean, max]) => `<tr><td class="hm-code small">${esc(sql)}</td><td class="num">${n.toLocaleString("en-GB")}</td><td class="num">${N(mean + " ms")}</td><td class="num">${N(max >= 500 ? `<span style="color:var(--warning);font-weight:700">${max} ms</span>` : max + " ms")}</td></tr>`).join("");
    return `<div class="hm-sec"><h2>Speed</h2><span class="small muted">p50 = typical, p95 = slowest 1 in 20 · ${esc(S.range.toLowerCase())}</span></div>
      <div class="table-wrap"><table class="t"><thead><tr><th>Kind</th><th>Page or API route</th><th class="num">Requests / day</th><th class="num">p50</th><th class="num">p95</th><th>p95 trend</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="small muted">CV upload is slow because files are scanned and their text is read before saving. Pages over 1,000 ms at p95 are highlighted.</p>
      <h3 style="margin-top:16px">Slowest database queries</h3>
      <div class="table-wrap"><table class="t"><thead><tr><th>Query (values removed)</th><th class="num">Calls (24 h)</th><th class="num">Average</th><th class="num">Slowest</th></tr></thead><tbody>${q}</tbody></table></div>`;
  }
  function dbSection() {
    const v = S.mode === "vercel", used = v ? 7 : 23, max = v ? 100 : 200;
    return `<div class="hm-sec"><h2>Database</h2><span class="small muted">${v ? "Neon Postgres, through the connection pooler" : "PostgreSQL 16 on db-01"}</span></div>
      <div class="grid g4">
        <div class="card"><div class="kpi-label">Connections in use</div><div class="kpi">${N(`${used} <span class="small muted">/ ${max}</span>`)}</div>${Admin.ui.bar((used / max) * 100)}${spark(wave(24, used, v ? 3 : 6, 3, 1), { w: 200, h: 24, label: "Connections, last 24 hours" })}</div>
        <div class="card"><div class="kpi-label">Average query time</div><div class="kpi">${N((v ? "4.1" : "2.6") + " ms")}</div>${spark(wave(24, v ? 4 : 2.6, 1.2, 5, 1), { w: 200, h: 24, label: "Average query time" })}</div>
        <div class="card"><div class="kpi-label">Slow queries (over 500 ms)</div><div class="kpi">3</div><div class="small muted"><bdi>in the last 24 hours · 0 deadlocks</bdi></div></div>
        <div class="card"><div class="kpi-label">Queries per minute</div><div class="kpi">${v ? "312" : "298"}</div>${spark(wave(24, 300, 90, 6, 20), { w: 200, h: 24, label: "Queries per minute" })}</div></div>`;
  }

  window.HealthPage = {
    mode(m) { S.mode = m; Admin.rerender(); },
    range(r) { S.range = r; Admin.rerender(); },
    run(id) { S.checked[id] = "Just now"; Admin.rerender(); Admin.toast("Check ran: same result as before (mockup)"); },
    runAll() { checks().forEach((c) => (S.checked[c.id] = "Just now")); Admin.rerender(); Admin.toast("All 5 checks ran (mockup)"); },
    check(id) {
      const c = checks().find((x) => x.id === id);
      Admin.drawer(`<div class="row" style="justify-content:space-between"><h2 style="margin:0">${c.name}</h2>${Admin.ui.btn("Close", { kind: "ghost", attrs: `onclick="Admin.close()"` })}</div>
        <div class="row" style="margin:8px 0 12px">${statusBadge(c.status)}<span class="small muted">Checked ${esc(S.checked[c.id] || c.last)} · took ${c.dur} · runs every minute</span></div>
        <p>${esc(c.what)}.</p>${c.note ? `<div class="callout ${c.status === "warn" ? "warn" : ""}" style="margin-bottom:12px">${esc(c.note)}</div>` : ""}
        <h3>What to do</h3><p>${esc(c.fix)}</p>
        <h3>Last 7 days</h3>${dots(c.hist)}
        <div class="row" style="margin-top:16px">${Admin.ui.btn("Run now", { kind: "primary", attrs: `onclick="Admin.close();HealthPage.run('${c.id}')"` })}${c.status !== "ok" ? Admin.ui.btn("Snooze for 24 hours", { attrs: `onclick="Admin.close();Admin.toast('Snoozed until tomorrow (mockup). Recorded in the audit log.')"` }) : ""}${c.link ? Admin.ui.btn("Open " + c.link[0], { kind: "ghost", attrs: `onclick="Admin.close();Admin.navigate('${c.link[1]}')"` }) : ""}</div>`);
    },
    saveTh() {
      const bad = [...document.querySelectorAll("[data-th]")].filter((el) => !/^\d+$/.test(el.value.trim()));
      if (bad.length) { bad[0].focus(); Admin.toast("Thresholds must be whole numbers"); return; }
      document.querySelectorAll("[data-th]").forEach((el) => (TH[el.dataset.th][el.dataset.k] = Number(el.value)));
      const wrong = TH.find((t) => t.warn >= t.crit);
      if (wrong) { Admin.toast(`${wrong.m}: the warning must be lower than critical`); return; }
      Admin.toast("Thresholds saved (mockup)");
    },
  };

  Admin.register({
    id: "health",
    group: "System",
    title: "Health & monitoring",
    icon: "activity",
    spec: ["OBS-001", "OBS-002", "OBS-003", "OBS-010", "OBS-011", "OBS-020", "OBS-021", "OBS-030", "OBS-031", "OBS-050"],
    changes: "New. Today there is no health page; admins can now see checks, usage, storage, speed and the database, plus per-server CPU, memory and disk when self-hosted on Linux.",
    render(ctx) {
      const { ui } = ctx;
      const v = S.mode === "vercel";
      const head = ui.pageHeader("Health & monitoring", "Is everything working, how much is used, and how fast it is.",
        `${ui.select(["Last hour", "Last 24 hours", "Last 7 days", "Last 30 days"], S.range, `aria-label="Time range" style="width:auto" onchange="HealthPage.range(this.value)"`)}${ui.btn("Run all checks", { kind: "primary", ic: "activity", attrs: `onclick="HealthPage.runAll()"` })}`);
      if (ctx.state !== "normal") return STYLE + head + ui.stateBlock(ctx.state, { emptyTitle: "No measurements yet", emptyText: "Numbers appear after the first nightly count at 02:00. Health checks start within a minute of setup.", emptyAction: ui.btn("Run all checks now", { kind: "primary", attrs: `onclick="Admin.setState('normal')"` }) });
      const mode = `<div class="row" style="margin-bottom:12px"><span class="small muted">Deployment:</span>
        <div class="hm-seg" role="group" aria-label="Deployment mode">
          <button aria-pressed="${v}" onclick="HealthPage.mode('vercel')">${Admin.icon("globe", 'width="14" height="14"')}Hosted on Vercel</button>
          <button aria-pressed="${!v}" onclick="HealthPage.mode('self')">${Admin.icon("screen", 'width="14" height="14"')}Self-hosted (Linux servers)</button></div>
        <span class="small muted">${v ? "What you have today." : "Mockup: what this page shows if RecruitmentOS runs on your own servers."}</span></div>`;
      const banner = v ? `<div class="callout ok" style="margin-bottom:16px"><b>All checks passing.</b> Version 1.0.0 · up since today 07:12 (last deployment) · production</div>`
        : `<div class="callout warn" style="margin-bottom:16px"><b>1 warning:</b> db-01 disk is 82 % full, which affects CV storage. Everything else is passing. Version 1.0.0 · up 41 days.</div>`;
      return STYLE + head + mode + banner +
        `<div class="hm-sec" style="margin-top:0"><h2>Health checks</h2><span class="small muted">Click a check for details and what to do</span></div>${checksCard()}` +
        (v ? `<div class="hm-sec"><h2>Hosting</h2></div>${vercelCard()}` : serversSection()) +
        usageSection() + storageSection() + speedSection() + dbSection();
    },
  });
})();
