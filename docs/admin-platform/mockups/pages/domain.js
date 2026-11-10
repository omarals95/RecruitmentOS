/* Domain & URL: current address, change-domain flow (DNS records → verification → impact review → switch),
   Vercel vs self-hosted (Linux) checklist, and the host-header security note. */
(function () {
  const ui = Admin.ui, esc = ui.esc;
  const VERIFY = "7c41b9e2d05f8a13";
  const AI_APPS = [
    ["Claude (desktop)", "Omar Alshair", "Connected 12 Oct 2026"],
    ["ChatGPT connector", "Mariam Al Suwaidi", "Connected 30 Oct 2026"],
    ["Reporting assistant", "Service account · Talent Acquisition", "Connected 4 Nov 2026"],
  ];
  const fresh = () => ({ step: 0, input: "app.recruitmentos.ae", domain: "", err: "", checks: { a: "pending", b: "pending" }, reasons: {}, cert: "waiting", count: 0, fail: false, lastChecked: "", reviewed: {} });
  const D = {
    primary: (window.MockData && window.MockData.company.domain) || "recruitmentos-preview.vercel.app",
    old: null, redirect: true, mode: "vercel", flow: fresh(),
    history: [["21 Jul 2026", "Omar Alshair", "Workspace created on recruitmentos-preview.vercel.app"]],
  };

  const okHost = (h) => /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(h);
  const sub = (d) => d.split(".").length > 2 ? d.split(".").slice(0, -2).join(".") : "@";
  const now = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const copyBtn = (v, label = "Copy") => ui.btn(label, { kind: "sm", attrs: `data-copy="${esc(v)}" aria-label="Copy ${esc(v)}"` });
  const STATUS = { pending: ["Pending", "warn"], verified: ["Verified", "ok"], failed: ["Failed", "bad"] };

  function records() {
    const d = D.flow.domain || D.flow.input, host = sub(d);
    if (D.mode === "vercel")
      return [
        { id: "a", type: "CNAME", name: host, value: "cname.vercel-dns.com", ttl: "3600", why: "Points the address at Vercel" },
        { id: "b", type: "TXT", name: "_vercel" + (host === "@" ? "" : "." + host.split(".").slice(1).join(".")).replace(/\.$/, ""), value: `vc-domain-verify=${d},${VERIFY}`, ttl: "3600", why: "Proves you own the domain" },
      ];
    return [
      { id: "a", type: "A", name: host, value: "203.0.113.24", ttl: "3600", why: "Public IP of your reverse proxy server" },
      { id: "b", type: "TXT", name: "_recruitmentos-verify" + (host === "@" ? "" : "." + host), value: `recruitmentos-verify=${VERIFY}`, ttl: "3600", why: "Proves you own the domain" },
    ];
  }
  const newBase = () => "https://" + (D.flow.domain || (D.old ? D.primary : D.flow.input));

  function stepper() {
    const steps = ["Enter domain", "Add DNS records", "Verify", "Review and switch"];
    return `<ol class="dm-steps">${steps.map((s, i) => `<li class="${D.flow.step === i + 1 ? "on" : D.flow.step > i + 1 ? "done" : ""}"><span>${D.flow.step > i + 1 ? "✓" : i + 1}</span>${s}</li>`).join("")}</ol>`;
  }

  function stepEnter() {
    const f = D.flow;
    return `${ui.field("New address", `<div class="row" style="flex-wrap:nowrap"><span class="muted">https://</span><input class="input" id="dm-in" value="${esc(f.input)}" placeholder="app.example.ae" spellcheck="false" autocomplete="off" style="max-width:340px" dir="ltr"></div>`,
      "Use a subdomain you control, such as app.recruitmentos.ae. Enter only the address, without https:// or a path.")}
      ${f.err ? `<div class="callout bad" style="margin-bottom:12px">${esc(f.err)}</div>` : ""}
      <div class="row">${ui.btn("Continue", { kind: "primary", attrs: 'data-act="to-dns"' })}${ui.btn("Cancel", { kind: "ghost", attrs: 'data-act="cancel"' })}</div>`;
  }
  function stepDns() {
    return `<p>Add these records at the company that manages DNS for <b>${esc((D.flow.domain.split(".").slice(-2)).join("."))}</b>. Changes usually show within minutes but can take up to 48 hours.</p>
      ${ui.table(["Type", "Name (host)", "Value", "TTL", "Why"], records().map((r) => [
        `<b>${r.type}</b>`, `<span class="dm-code" dir="ltr">${esc(r.name)}</span> ${copyBtn(r.name)}`, `<span class="dm-code" dir="ltr">${esc(r.value)}</span> ${copyBtn(r.value)}`, r.ttl, `<span class="small muted">${esc(r.why)}</span>`]))}
      ${D.mode === "vercel" ? `<p class="small muted">The domain is also added to the Vercel project <b>recruitmentos</b> (Production). Vercel issues the HTTPS certificate once DNS is correct.</p>`
        : `<p class="small muted">Self-hosted: after DNS, set up the reverse proxy and certificate using the server checklist below.</p>`}
      <div class="row">${ui.btn("I've added them: check now", { kind: "primary", attrs: 'data-act="check"' })}${ui.btn("Back", { attrs: 'data-act="back"' })}</div>`;
  }
  function stepVerify() {
    const f = D.flow, recs = records();
    const all = f.checks.a === "verified" && f.checks.b === "verified";
    return `<div class="row" style="justify-content:space-between;margin-bottom:8px"><span>Checking <b dir="ltr">${esc(f.domain)}</b>${f.lastChecked ? ` · last checked ${f.lastChecked}` : ""}</span>
        <span class="row">${ui.btn("Check again", { kind: "sm", attrs: 'data-act="check"' })}<label class="check small muted"><input type="checkbox" data-act="fail" ${f.fail ? "checked" : ""}> Simulate a failure (mockup)</label></span></div>
      ${ui.table(["Record", "Status", "Details"], recs.map((r) => {
        const [l, tone] = STATUS[f.checks[r.id]];
        return [`<b>${r.type}</b> <span class="dm-code" dir="ltr">${esc(r.name)}</span>`, ui.badge(l, tone), f.reasons[r.id] ? esc(f.reasons[r.id]) : `<span class="muted small">Not found yet.</span>`];
      }).concat([[`<b>HTTPS certificate</b>`, f.cert === "issued" ? ui.badge("Issued", "ok") : f.cert === "issuing" ? ui.badge("Issuing", "info") : ui.badge("Waiting for DNS", ""),
        f.cert === "issued" ? "Let's Encrypt · valid until 8 Feb 2027 · renews automatically" : `<span class="muted small">Starts when every record is verified.</span>`]]))}
      <div class="row" style="margin-top:12px">${ui.btn("Continue to review", { kind: "primary", attrs: `data-act="to-review" ${all && f.cert === "issued" ? "" : "disabled"}` })}${ui.btn("Show DNS records", { attrs: 'data-act="back"' })}</div>`;
  }
  function impactItems() {
    const nb = newBase();
    return [
      { id: "signin", title: "Sign-in and two-step links", tone: "ok", tag: "Automatic", body: `Sign-in, password reset and two-step verification links use <span class="dm-code" dir="ltr">${esc(nb)}</span>. People signed in on the old address sign in once more.` },
      { id: "emails", title: "Invitation and password emails", tone: "ok", tag: "Automatic", body: "New emails link to the new address. 2 invitations not yet accepted keep working through the redirect." },
      { id: "mcp", title: "AI apps (MCP) must re-authorise", tone: "warn", tag: "Action needed", need: true,
        body: `OAuth callback addresses change, so ${AI_APPS.length} connected apps stop working until their owners reconnect. New values to give them:
          <div class="dm-kv"><span>Server URL</span><span class="dm-code" dir="ltr">${esc(nb)}/api/mcp</span>${copyBtn(nb + "/api/mcp")}</div>
          <div class="dm-kv"><span>OAuth callback</span><span class="dm-code" dir="ltr">${esc(nb)}/api/mcp/oauth/callback</span>${copyBtn(nb + "/api/mcp/oauth/callback")}</div>
          <ul class="dm-apps">${AI_APPS.map(([a, o, w]) => `<li><b>${esc(a)}</b> · ${esc(o)} <span class="muted small">${esc(w)}</span></li>`).join("")}</ul>
          <span class="small muted">Owners get an email asking them to reconnect after the switch.</span>` },
      { id: "api", title: "API base URL for tokens", tone: "warn", tag: "Action needed", need: true,
        body: `Tokens keep working. Scripts should call <span class="dm-code" dir="ltr">${esc(nb)}/api/v1</span> ${copyBtn(nb + "/api/v1")}. 4 active tokens were used in the last 30 days.` },
      { id: "mail", title: "Email sender domain", tone: "warn", tag: "Check", need: true,
        body: `Mail is sent from <span class="dm-code" dir="ltr">no-reply@recruitmentos.ae</span>. SPF ${ui.badge("OK", "ok")} DKIM ${ui.badge("OK", "ok")} DMARC ${ui.badge("Missing", "bad")}. Add a DMARC record so invitations do not land in spam. <a href="#/mail">Open outgoing mail</a>` },
      { id: "old", title: "Links in emails already sent", tone: D.redirect ? "ok" : "bad", tag: D.redirect ? "Kept working" : "Will break",
        body: D.redirect ? `The old address redirects (301) to the same page on the new one, so links already sent keep working.` : `Redirect is off. Links in emails already sent will stop working. Turn on “Redirect the old address”.` },
    ];
  }
  function stepReview() {
    const items = impactItems(), f = D.flow;
    const pending = items.filter((i) => i.need && !f.reviewed[i.id]).length;
    return `<div class="grid g2" style="gap:12px;margin-bottom:12px">
        <label class="dm-opt"><input type="checkbox" data-act="redirect" ${D.redirect ? "checked" : ""}><span><b>Redirect the old address</b><br><span class="small muted">${esc(D.primary)} sends visitors to the same page on the new address (301).</span></span></label>
        <label class="dm-opt"><input type="checkbox" checked disabled><span><b>Enforce HTTPS</b> ${ui.badge("Always on", "info")}<br><span class="small muted">HTTP is redirected to HTTPS and browsers are told to use HTTPS only (HSTS).</span></span></label></div>
      <h3>Before you switch</h3>
      <ul class="list-plain dm-impact">${items.map((i) => `<li><div class="row" style="justify-content:space-between;flex-wrap:nowrap"><b>${esc(i.title)}</b>${ui.badge(i.tag, i.tone)}</div>
        <div class="small" style="margin-top:4px">${i.body}</div>
        ${i.need ? `<label class="check small" style="margin-top:6px"><input type="checkbox" data-review="${i.id}" ${f.reviewed[i.id] ? "checked" : ""}> I have read this</label>` : ""}</li>`).join("")}</ul>
      <div class="row" style="margin-top:12px">${ui.btn(`Switch to ${f.domain}`, { kind: "primary", attrs: `data-act="switch" ${pending ? "disabled" : ""}` })}${ui.btn("Back", { attrs: 'data-act="back"' })}
        ${pending ? `<span class="small muted">${pending} ${pending === 1 ? "item" : "items"} left to read.</span>` : ""}</div>`;
  }
  function flowCard() {
    const f = D.flow;
    if (!f.step)
      return `<div class="card"><div class="row" style="justify-content:space-between"><div><h2>Use your own domain</h2><p class="muted" style="margin:0">${D.old ? `Move from ${esc(D.primary)} to another domain you own.` : `Move from ${esc(D.primary)} to an address such as app.recruitmentos.ae.`}</p></div>
        ${ui.btn("Change domain", { kind: "primary", ic: "globe", attrs: 'data-act="start"' })}</div></div>`;
    const body = [null, stepEnter, stepDns, stepVerify, stepReview][f.step]();
    return `<div class="card"><h2>Change domain${f.domain ? `: <span dir="ltr">${esc(f.domain)}</span>` : ""}</h2>${stepper()}${body}</div>`;
  }

  function hostingCard() {
    const v = D.mode === "vercel";
    const nb = newBase().replace("https://", "");
    const vercelList = [
      ["Domain added to the Vercel project “recruitmentos” (Production)", D.flow.step >= 2 || D.old ? "ok" : ""],
      ["HTTPS certificate issued and renewed by Vercel", D.flow.cert === "issued" || D.old ? "ok" : ""],
      ["APP_BASE_URL updated and the app redeployed when you switch", D.old ? "ok" : ""],
      ["Old *.vercel.app address kept, redirecting to the new one", D.old && D.redirect ? "ok" : ""],
    ];
    const linuxList = [
      ["DNS A record points to the reverse proxy (203.0.113.24)", "ok", "Detected"],
      [`Reverse proxy (Nginx or Caddy) answers for ${nb} and forwards to the app on 127.0.0.1:3000`, "warn", "Not checked"],
      ["TLS certificate from Let's Encrypt with automatic renewal (certbot timer or Caddy)", "warn", "Not checked"],
      ["Proxy sends X-Forwarded-Proto and X-Forwarded-Host; the app trusts only this proxy's IP", "warn", "Not checked"],
      ["Port 80 redirects to 443 and HSTS is sent", "warn", "Not checked"],
      [`APP_BASE_URL=https://${nb} set in /etc/recruitmentos/env, then the service restarted`, "warn", "Not checked"],
      ["Firewall: ports 80 and 443 open; port 3000 closed to the internet", "warn", "Not checked"],
    ];
    const nginx = `server {\n  listen 443 ssl http2;\n  server_name ${nb};\n  ssl_certificate     /etc/letsencrypt/live/${nb}/fullchain.pem;\n  ssl_certificate_key /etc/letsencrypt/live/${nb}/privkey.pem;\n  add_header Strict-Transport-Security "max-age=31536000" always;\n  location / {\n    proxy_pass http://127.0.0.1:3000;\n    proxy_set_header Host $host;\n    proxy_set_header X-Forwarded-Proto https;\n    proxy_set_header X-Forwarded-Host $host;\n  }\n}`;
    return `<div class="card"><div class="row" style="justify-content:space-between;margin-bottom:10px"><h2 style="margin:0">Where it runs</h2>
        <div class="dm-seg" role="group" aria-label="Deployment">${[["vercel", "Hosted on Vercel"], ["linux", "Self-hosted on Linux"]].map(([k, l]) => `<button class="${D.mode === k ? "on" : ""}" data-mode="${k}" aria-pressed="${D.mode === k}">${l}</button>`).join("")}</div></div>
      ${v ? `<p class="small muted" style="margin-top:0">Vercel manages the servers. Adding the domain to the project and issuing certificates is automatic.</p>
          <ul class="list-plain">${vercelList.map(([t, s]) => `<li class="row" style="justify-content:space-between;flex-wrap:nowrap"><span>${esc(t)}</span>${ui.badge(s ? "Done" : "When you switch", s || "")}</li>`).join("")}</ul>`
        : `<p class="small muted" style="margin-top:0">On your own Linux servers, you set up the reverse proxy and certificate. Tick off each step before switching.</p>
          <ul class="list-plain">${linuxList.map(([t, s, l]) => `<li class="row" style="justify-content:space-between;flex-wrap:nowrap"><span>${esc(t)}</span>${ui.badge(l, s)}</li>`).join("")}</ul>
          <details style="margin-top:10px"><summary>Example Nginx configuration</summary><pre class="dm-pre" dir="ltr">${esc(nginx)}</pre>${copyBtn(nginx, "Copy configuration")}</details>
          ${ui.btn("Run server checks", { kind: "sm", attrs: 'data-act="srvcheck"' })}`}</div>`;
  }

  function currentCard() {
    const isVercel = D.primary.endsWith(".vercel.app");
    return `<div class="card"><h2>Current address</h2>
      <div class="row" style="justify-content:space-between"><div class="row"><span class="dm-url" dir="ltr">https://${esc(D.primary)}</span>${copyBtn("https://" + D.primary)}</div>
        <div class="row">${ui.badge("Primary", "info")}${ui.badge("Working", "ok")}${ui.badge(isVercel ? "Vercel address" : "Custom domain", "")}</div></div>
      <ul class="list-plain" style="margin-top:8px">
        <li class="row" style="justify-content:space-between"><span>HTTPS certificate</span><span>${ui.badge("Valid", "ok")} <span class="small muted">until 8 Feb 2027 · renews automatically</span></span></li>
        <li class="row" style="justify-content:space-between"><span>API base URL</span><span class="dm-code" dir="ltr">https://${esc(D.primary)}/api/v1</span></li>
        ${D.old ? `<li class="row" style="justify-content:space-between"><span>Old address</span><span><span class="dm-code" dir="ltr">${esc(D.old)}</span> ${D.redirect ? ui.badge("Redirects here (301)", "ok") : ui.badge("No redirect", "bad")}</span></li>` : ""}
      </ul>
      ${D.old ? `<div class="row" style="margin-top:10px">${ui.btn("Switch back", { kind: "sm", attrs: 'data-act="revert"' })}<span class="small muted">Possible for 7 days. AI apps would need to reconnect again.</span></div>` : ""}</div>`;
  }

  function body() {
    return `${currentCard()}
      <div class="callout" style="margin:16px 0"><b>Security:</b> the address is never taken from a visitor's request. Links in emails, sign-in redirects, OAuth callbacks and API responses are built only from the saved primary address, so a forged Host header cannot send people elsewhere. Requests on any other hostname are redirected to the primary address.</div>
      <div class="dm-grid"><div class="stack">${flowCard()}
        <div class="card"><h2>Address history</h2>${ui.table(["When", "Who", "Change"], D.history.map((h) => h.map(esc)))}</div></div>
        <div>${hostingCard()}</div></div>`;
  }

  const STYLE = `<style>
    .dm-grid{display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:16px;align-items:start}
    .dm-url{font-size:16px;font-weight:700}
    .dm-code{font-family:Consolas,"Courier New",monospace;font-size:12px;background:var(--surface-subtle);border:1px solid var(--border);border-radius:4px;padding:1px 5px;word-break:break-all}
    .dm-steps{display:flex;gap:6px;list-style:none;padding:0;margin:4px 0 16px;flex-wrap:wrap}
    .dm-steps li{display:flex;gap:6px;align-items:center;padding:4px 10px 4px 4px;border-radius:999px;background:var(--surface-subtle);color:var(--muted);font-size:12px;border:1px solid var(--border)}
    .dm-steps li span{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:var(--surface);border:1px solid var(--border-strong);font-weight:700;font-size:11px}
    .dm-steps li.on{background:var(--primary-soft);color:var(--primary-text);font-weight:700;border-color:transparent}.dm-steps li.on span{background:var(--primary);color:var(--surface);border-color:var(--primary)}
    .dm-steps li.done{color:var(--success)}.dm-steps li.done span{background:var(--success-bg);border-color:var(--success)}
    .dm-opt{display:flex;gap:8px;align-items:flex-start;border:1px solid var(--border);border-radius:10px;padding:10px}
    .dm-impact li{padding:10px 0}
    .dm-kv{display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap}.dm-kv>span:first-child{min-width:110px;color:var(--muted)}
    .dm-apps{margin:6px 0;padding-inline-start:18px}
    .dm-seg{display:inline-flex;border:1px solid var(--border-strong);border-radius:8px;overflow:hidden}
    .dm-seg button{border:0;background:var(--surface);padding:5px 10px;cursor:pointer;font-size:12px}
    .dm-seg button.on{background:var(--primary);color:var(--surface);font-weight:700}
    .dm-pre{background:var(--surface-subtle);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:11.5px;overflow:auto;text-align:left}
    @media (max-width:1150px){.dm-grid{grid-template-columns:1fr}}
  </style>`;

  Admin.register({
    id: "domain",
    group: "Look & feel",
    title: "Domain & URL",
    icon: "globe",
    spec: ["SYS-001", "SYS-002", "SYS-003", "SYS-004", "SYS-005", "SYS-006"],
    changes: "New. Today the address is the Vercel preview domain set in code. Admins can now add a custom domain with guided DNS, verification, an impact checklist and a safe switch.",
    render(ctx) {
      const head = ui.pageHeader("Domain & URL", "The web address people use to reach the workspace. Every link the system sends is built from it.");
      if (ctx.state !== "normal")
        return head + ui.stateBlock(ctx.state, { emptyTitle: "No custom domain yet", emptyText: `Everyone uses <b>${esc(D.primary)}</b>. Add your own domain, such as app.recruitmentos.ae.`, emptyAction: ui.btn("Add a domain", { kind: "primary", attrs: "onclick=\"Admin.setState('normal')\"" }), errorText: "We could not load the domain settings." });
      return STYLE + head + `<div id="dm-page">${body()}</div>`;
    },
    mount(root, ctx) {
      if (ctx.state !== "normal") return;
      const page = root.querySelector("#dm-page");
      const draw = () => { page.innerHTML = body(); };
      const runCheck = () => {
        const f = D.flow;
        f.count += 1; f.lastChecked = now();
        const recs = records();
        if (f.fail) {
          f.checks = { a: "failed", b: "verified" };
          f.reasons = { a: `Found ${recs[0].type} pointing to old-proxy.example.net. Expected ${recs[0].value}. Remove the old record and add this one.`, b: "Found and matches." };
          f.cert = "waiting";
        } else if (f.count === 1) {
          f.checks = { a: "verified", b: "pending" }; f.reasons = { a: "Found and matches.", b: "Not found yet. DNS can take up to 48 hours. Check again shortly." }; f.cert = "waiting";
        } else {
          f.checks = { a: "verified", b: "verified" }; f.reasons = { a: "Found and matches.", b: "Found and matches." }; f.cert = "issued";
        }
      };
      page.addEventListener("click", (e) => {
        const c = e.target.closest("[data-copy]");
        if (c) {
          const v = c.dataset.copy;
          const done = () => Admin.toast("Copied: " + (v.length > 48 ? v.slice(0, 48) + "…" : v));
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(done, () => Admin.toast("The browser blocked copying. Select the text instead."));
          else done();
          return;
        }
        const m = e.target.closest("[data-mode]");
        if (m) { D.mode = m.dataset.mode; if (D.flow.step >= 3) { D.flow.checks = { a: "pending", b: "pending" }; D.flow.reasons = {}; D.flow.cert = "waiting"; D.flow.count = 0; D.flow.step = 2; Admin.toast("DNS records changed for self-hosting. Check them again."); } return draw(); }
        const a = e.target.closest("[data-act]");
        if (!a || a.tagName === "INPUT") return;
        const f = D.flow, act = a.dataset.act;
        if (act === "start") { f.step = 1; draw(); const i = page.querySelector("#dm-in"); i.focus(); return; }
        if (act === "cancel") { D.flow = fresh(); return draw(); }
        if (act === "back") { f.step = Math.max(1, f.step - 1); return draw(); }
        if (act === "to-dns") {
          const v = page.querySelector("#dm-in").value.trim().toLowerCase();
          f.input = v;
          if (/^https?:\/\//.test(v) || v.includes("/")) f.err = "Enter only the address, without https:// or a path.";
          else if (!okHost(v)) f.err = "That does not look like a valid address. Example: app.recruitmentos.ae";
          else if (v === D.primary || v.endsWith(".vercel.app")) f.err = "Choose a domain you own, not a vercel.app address.";
          else { f.err = ""; f.domain = v; f.step = 2; }
          return draw();
        }
        if (act === "check") { f.step = 3; runCheck(); return draw(); }
        if (act === "to-review") { f.step = 4; return draw(); }
        if (act === "srvcheck") return Admin.toast("Server checks run from the app server (mockup): 1 passed, 6 not checked");
        if (act === "switch") {
          Admin.modal(`<h2>Switch the primary address to ${esc(f.domain)}?</h2>
            <ul><li>All 19 members sign in once more on the new address.</li><li>${AI_APPS.length} AI apps must re-authorise; their owners get an email.</li>
            <li>${D.redirect ? `${esc(D.primary)} redirects to the new address, so old links keep working.` : `<b>No redirect:</b> links to ${esc(D.primary)} stop working.`}</li>
            <li>The change is recorded in the audit log.</li></ul>
            <div class="row" style="justify-content:flex-end">${ui.btn("Cancel", { attrs: 'onclick="Admin.close()"' })}${ui.btn("Switch now", { kind: "primary", attrs: 'id="dm-sw-ok"' })}</div>`);
          document.getElementById("dm-sw-ok").addEventListener("click", () => {
            D.history.unshift([new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }), "Omar Alshair", `Primary address changed from ${D.primary} to ${f.domain}${D.redirect ? " (old address redirects)" : ""}`]);
            D.old = D.primary; D.primary = f.domain; D.flow = fresh();
            Admin.close(); Admin.toast(`Switched to ${D.primary} (mockup)`); draw();
          });
          return;
        }
        if (act === "revert") {
          Admin.modal(`<h2>Switch back to ${esc(D.old)}?</h2><p>Links built from now on use ${esc(D.old)}. AI apps must re-authorise again. ${esc(D.primary)} stays verified, so you can switch again later.</p>
            <div class="row" style="justify-content:flex-end">${ui.btn("Cancel", { attrs: 'onclick="Admin.close()"' })}${ui.btn("Switch back", { kind: "danger", attrs: 'id="dm-rv-ok"' })}</div>`);
          document.getElementById("dm-rv-ok").addEventListener("click", () => {
            D.history.unshift(["Today", "Omar Alshair", `Primary address changed back from ${D.primary} to ${D.old}`]);
            D.primary = D.old; D.old = null; Admin.close(); Admin.toast("Switched back (mockup)"); draw();
          });
        }
      });
      page.addEventListener("change", (e) => {
        const el = e.target;
        if (el.dataset.review) { D.flow.reviewed[el.dataset.review] = el.checked; return draw(); }
        if (el.dataset.act === "redirect") { D.redirect = el.checked; return draw(); }
        if (el.dataset.act === "fail") { D.flow.fail = el.checked; runCheck(); return draw(); }
      });
      page.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.id === "dm-in") page.querySelector('[data-act="to-dns"]').click(); });
    },
  });
})();
