/* Look & feel: white-label editor with live, scoped previews (light + dark), WCAG contrast checks,
   sign-in page, email header, announcement banner, draft / preview / publish / reset, version history.
   Brand colours only ever change CSS variables on the preview containers, never the mockup itself. */
(function () {
  const ui = Admin.ui, esc = ui.esc;
  const clone = (o) => JSON.parse(JSON.stringify(o));

  const DEFAULTS = {
    name: "RecruitmentOS", showName: true, primary: "#4338CA", accent: "#0E7490", header: "plain", density: "comfortable",
    logo: null, logoName: "", logoDark: null, logoDarkName: "", favicon: null, faviconName: "",
    signHeading: "Welcome to RecruitmentOS", signText: "Sign in with your work email. Need access? Ask your team owner.", signBg: "gradient", signImage: null, signForgot: true,
    emailHeader: "white", emailSender: "RecruitmentOS", emailFooter: "Sent by RecruitmentOS. You get this email because you have an account.",
    banner: { on: false, text: "", tone: "info", colour: "#1D4ED8", start: "2026-11-12T08:00", end: "2026-11-14T23:00", audience: "Everyone signed in", dismiss: true },
  };
  const PUBLISHED_V7 = Object.assign(clone(DEFAULTS), {
    name: "Al Noor Talent", primary: "#4338CA", accent: "#0E7490",
    signHeading: "Welcome to Al Noor Talent", signText: "Sign in with your @example.test work email. Need access? Ask your team owner.",
    emailSender: "Al Noor Talent", emailFooter: "Al Noor Holding (fictional) · PO Box 0000, Abu Dhabi, UAE. You get this email because you have an account.",
  });
  let published = clone(PUBLISHED_V7);
  // the current draft: new accent (fails contrast on tints) and a scheduled maintenance banner
  let B = Object.assign(clone(PUBLISHED_V7), {
    accent: "#0EA5E9",
    banner: { on: true, text: "Planned maintenance on Saturday 14 November, 22:00 to 23:00 (UAE time). Saving may pause for a few minutes.", tone: "warning", colour: "#B45309", start: "2026-11-12T08:00", end: "2026-11-14T23:00", audience: "Everyone signed in", dismiss: true },
  });
  let version = 7, previewAsMe = false, ackFails = false;
  const HISTORY = [
    { v: 7, when: "3 Nov 2026 09:12", who: "Omar Alshair", what: "Product name “Al Noor Talent”, sign-in text, email footer", snap: { name: "Al Noor Talent", primary: "#4338CA", accent: "#0E7490" } },
    { v: 6, when: "21 Oct 2026 15:40", who: "Omar Alshair", what: "Brand colour #4338CA", snap: { name: "RecruitmentOS", primary: "#4338CA", accent: "#0E7490" } },
    { v: 5, when: "2 Sep 2026 11:05", who: "Mariam Al Suwaidi", what: "Accent #0F766E, new favicon", snap: { name: "RecruitmentOS", primary: "#3730A3", accent: "#0F766E" } },
    { v: 4, when: "18 Aug 2026 10:22", who: "Omar Alshair", what: "Sign-in background image", snap: { name: "RecruitmentOS", primary: "#3730A3", accent: "#0F766E" } },
  ];
  const TONES = { info: "#1D4ED8", warning: "#B45309", critical: "#B91C1C" };

  // ---------- colour maths ----------
  const isHex = (h) => /^#[0-9a-f]{6}$/i.test(h);
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const hex = (c) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("").toUpperCase();
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
  const lum = (h) => { const [r, g, b] = rgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const onColour = (bg) => (ratio("#FFFFFF", bg) >= ratio("#11131C", bg) ? "#FFFFFF" : "#11131C");
  const LIGHT = { bg: "#F5F6FA", surface: "#FFFFFF", text: "#191C28", muted: "#606B7D", border: "#E1E5ED" };
  const DARK = { bg: "#11131C", surface: "#1B1E2A", text: "#F0F2FA", muted: "#B0B9CD", border: "#343B50" };

  function tokens(s) {
    const P = isHex(s.primary) ? s.primary : DEFAULTS.primary, A = isHex(s.accent) ? s.accent : DEFAULTS.accent;
    const dP = mix(P, "#FFFFFF", 0.55);
    const t = {
      light: { primary: P, hover: mix(P, "#000000", 0.15), soft: mix(P, "#FFFFFF", 0.9), on: onColour(P), focus: mix(P, "#FFFFFF", 0.3), link: P, accent: A, accentSoft: mix(A, "#FFFFFF", 0.88) },
      dark: { primary: dP, hover: mix(P, "#FFFFFF", 0.68), soft: mix(P, DARK.surface, 0.72), on: onColour(dP), focus: mix(P, "#FFFFFF", 0.45), link: mix(P, "#FFFFFF", 0.62), accent: mix(A, "#FFFFFF", 0.45), accentSoft: mix(A, DARK.surface, 0.75) },
    };
    t.scale = [[50, 0.92], [100, 0.84], [200, 0.68], [300, 0.5], [400, 0.25], [500, 0], [600, -0.15], [700, -0.3], [800, -0.45], [900, -0.6]].map(([k, f]) => [k, f >= 0 ? mix(P, "#FFFFFF", f) : mix(P, "#000000", -f)]);
    return t;
  }
  // each check: which input it depends on, how to compute the pair from a candidate input colour, and the minimum ratio
  function checks(s) {
    const list = [
      { key: "primary", label: "Button text on primary colour (light)", min: 4.5, pair: (c) => { const t = tokens({ ...s, primary: c }).light; return [t.on, t.primary]; } },
      { key: "primary", label: "Links and selected text on white (light)", min: 4.5, pair: (c) => [tokens({ ...s, primary: c }).light.link, LIGHT.surface] },
      { key: "primary", label: "Selected sidebar item on its tint (light)", min: 4.5, pair: (c) => { const t = tokens({ ...s, primary: c }).light; return [t.primary, t.soft]; } },
      { key: "primary", label: "Focus ring against white (UI component)", min: 3, pair: (c) => [tokens({ ...s, primary: c }).light.focus, LIGHT.surface] },
      { key: "primary", label: "Button text on primary colour (dark)", min: 4.5, pair: (c) => { const t = tokens({ ...s, primary: c }).dark; return [t.on, t.primary]; } },
      { key: "primary", label: "Links on dark surface", min: 4.5, pair: (c) => [tokens({ ...s, primary: c }).dark.link, DARK.surface] },
      { key: "accent", label: "Accent badge text on its tint (light)", min: 4.5, pair: (c) => { const t = tokens({ ...s, accent: c }).light; return [t.accent, t.accentSoft]; } },
      { key: "accent", label: "Accent badge text on its tint (dark)", min: 4.5, pair: (c) => { const t = tokens({ ...s, accent: c }).dark; return [t.accent, t.accentSoft]; } },
    ];
    if (s.banner.on) list.push({ key: "banner.colour", label: "Announcement banner text", min: 4.5, pair: (c) => [onColour(c), c] });
    return list.map((c) => {
      const base = c.key === "banner.colour" ? s.banner.colour : s[c.key];
      const [fg, bg] = c.pair(isHex(base) ? base : "#000000");
      const r = ratio(fg, bg);
      let fix = null;
      if (r < c.min && isHex(base)) {
        for (let k = 1; k <= 30 && !fix; k++)
          for (const dir of ["#000000", "#FFFFFF"]) { const cand = mix(base, dir, k * 0.03); const [f2, b2] = c.pair(cand); const r2 = ratio(f2, b2); if (r2 >= c.min) { fix = { hex: cand, r: r2 }; break; } }
      }
      return { ...c, fg, bg, r, ok: r >= c.min, fix };
    });
  }

  const getPath = (o, p) => p.split(".").reduce((a, k) => (a == null ? a : a[k]), o);
  const setPath = (o, p, v) => { const k = p.split("."), l = k.pop(); k.forEach((x) => (o = o[x])); o[l] = v; };
  const dirty = () => JSON.stringify(B) !== JSON.stringify(published);

  // ---------- previews (scoped CSS variables on .bp-prev only) ----------
  function varStyle(mode) {
    const t = tokens(B)[mode], base = mode === "light" ? LIGHT : DARK;
    const brandHeader = B.header === "brand";
    const hb = brandHeader ? t.primary : base.surface, hf = brandHeader ? t.on : base.text;
    const bc = isHex(B.banner.colour) ? B.banner.colour : TONES.info;
    return [["bg", base.bg], ["surface", base.surface], ["text", base.text], ["muted", base.muted], ["border", base.border],
      ["primary", t.primary], ["hover", t.hover], ["soft", t.soft], ["on", t.on], ["focus", t.focus], ["link", t.link], ["accent", t.accent], ["accent-soft", t.accentSoft],
      ["header-bg", hb], ["header-fg", hf], ["banner", bc], ["banner-fg", onColour(bc)], ["radius", B.density === "compact" ? "6px" : "10px"]]
      .map(([k, v]) => `--bp-${k}:${v}`).join(";");
  }
  const logoFor = (mode, size = 22) => {
    const src = mode === "dark" ? B.logoDark || B.logo : B.logo;
    return src ? `<img src="${src}" alt="" style="height:${size}px;max-width:${size * 4}px;object-fit:contain">` : `<span class="bp-mark" style="width:${size}px;height:${size}px">${esc((B.name || "R").trim()[0] || "R")}</span>`;
  };
  function bannerHtml() {
    if (!B.banner.on || !B.banner.text.trim()) return "";
    return `<div class="bp-banner" role="status">${ui.icon(B.banner.tone === "info" ? "info" : "alert", 'width="14" height="14"')}<span>${esc(B.banner.text)}</span>${B.banner.dismiss ? `<span class="bp-x" aria-hidden="true">×</span>` : ""}</div>`;
  }
  function appPreview(mode) {
    return `<div class="bp-prev" data-mode="${mode}" style="${varStyle(mode)}">
      <div class="bp-cap">${mode === "light" ? "Light" : "Dark"}</div>
      ${bannerHtml()}
      <div class="bp-head">${logoFor(mode)}${B.showName || !B.logo ? `<b class="bp-name">${esc(B.name || "Untitled")}</b>` : ""}<span class="bp-search">Search candidates…</span><span class="bp-av">OA</span></div>
      <div class="bp-body"><div class="bp-side"><div class="bp-item on">Candidates</div><div class="bp-item">Vacancies</div><div class="bp-item">Interviews</div><div class="bp-item">Offers</div></div>
        <div class="bp-main"><div class="bp-card"><div class="bp-row"><b>Senior Backend Engineer</b><span class="bp-badge">Interview</span></div>
          <div class="bp-muted">Platform Engineering · 12 applications</div>
          <label class="bp-lbl">Candidate name</label><div class="bp-input focus">Fatima Al Zahra</div>
          <div class="bp-row" style="margin-top:10px"><span class="bp-btn pri">Move to offer</span><span class="bp-btn">Add note</span></div>
          <div style="margin-top:8px"><span class="bp-link">View CV</span></div></div></div></div></div>`;
  }
  function signinPreview(mode) {
    const bg = B.signBg === "image" && B.signImage ? `background-image:url(${B.signImage});background-size:cover;background-position:center` : "";
    return `<div class="bp-prev bp-sign bg-${esc(B.signBg)}" data-mode="${mode}" style="${varStyle(mode)};${bg}">
      <div class="bp-cap">${mode === "light" ? "Light" : "Dark"}</div>
      <div class="bp-signcard">${logoFor(mode, 30)}<h3>${esc(B.signHeading || "Sign in")}</h3><p class="bp-muted">${esc(B.signText)}</p>
        <label class="bp-lbl">Work email</label><div class="bp-input">name@example.test</div><label class="bp-lbl">Password</label><div class="bp-input">••••••••</div>
        <span class="bp-btn pri" style="display:block;text-align:center;margin-top:10px">Sign in</span>
        ${B.signForgot ? `<div style="margin-top:8px;font-size:11px"><span class="bp-link">Forgot your password?</span></div>` : ""}
        <div class="bp-muted" style="margin-top:8px;font-size:10px">Privacy · Terms · Help</div></div></div>`;
  }
  function emailPreview(mode) {
    const brandHead = B.emailHeader === "brand";
    return `<div class="bp-prev bp-mail" data-mode="${mode}" style="${varStyle(mode)}">
      <div class="bp-cap">${mode === "light" ? "Light mail app" : "Dark mail app"}</div>
      <div class="bp-mailmeta"><div><b>${esc(B.emailSender || B.name)}</b> &lt;no-reply@recruitmentos.ae&gt;</div><div>You're invited to join Talent Acquisition</div></div>
      <div class="bp-mailhead ${brandHead ? "brand" : ""}">${logoFor(mode, 24)}${B.showName || !B.logo ? `<b>${esc(B.name)}</b>` : ""}</div>
      <div class="bp-mailbody"><p>Hello Aisha,</p><p>Omar Alshair invited you to join <b>Talent Acquisition</b> as a Viewer.</p>
        <span class="bp-btn pri">Accept invitation</span><p class="bp-muted" style="font-size:11px;margin-top:10px">This link works for 7 days.</p></div>
      <div class="bp-mailfoot">${esc(B.emailFooter)}</div></div>`;
  }
  function contrastHtml() {
    const cs = checks(B), fails = cs.filter((c) => !c.ok).length;
    return `<div class="row" style="justify-content:space-between"><h2 style="margin:0">Contrast checks (WCAG 2.2 AA)</h2>${ui.badge(fails ? fails + " failing" : "All pass", fails ? "bad" : "ok")}</div>
      <p class="small muted" style="margin:4px 0 8px">Text needs 4.5:1, focus rings and other UI parts 3:1. Checked on every change, for light and dark.</p>
      <ul class="list-plain">${cs.map((c, i) => `<li class="row" style="justify-content:space-between;flex-wrap:nowrap">
        <span class="row" style="flex-wrap:nowrap"><span class="bp-pair" style="background:${c.bg};color:${c.fg}">Aa</span><span>${esc(c.label)}<br><span class="small muted">${c.r.toFixed(2)}:1 · needs ${c.min}:1</span></span></span>
        <span class="row" style="flex-wrap:nowrap">${ui.badge(c.ok ? "Pass" : "Fail", c.ok ? "ok" : "bad")}${!c.ok && c.fix ? ui.btn("Use " + c.fix.hex, { kind: "sm", attrs: `data-fix="${i}" title="Gives ${c.fix.r.toFixed(2)}:1"` }) : ""}</span></li>`).join("")}</ul>`;
  }
  function tokensHtml() {
    const t = tokens(B);
    const sw = (label, v) => `<div class="bp-tok"><span class="bp-sw" style="background:${v}"></span><span>${esc(label)}</span><code>${v}</code></div>`;
    return `<div class="bp-scale" aria-label="Tonal scale">${t.scale.map(([k, v]) => `<span style="background:${v};color:${onColour(v)}" title="${k}: ${v}">${k}</span>`).join("")}</div>
      <div class="bp-toks"><div><div class="small muted">Light</div>${sw("Primary", t.light.primary)}${sw("Hover", t.light.hover)}${sw("Tint", t.light.soft)}${sw("Text on primary", t.light.on)}${sw("Focus ring", t.light.focus)}${sw("Accent", t.light.accent)}</div>
        <div><div class="small muted">Dark</div>${sw("Primary", t.dark.primary)}${sw("Hover", t.dark.hover)}${sw("Tint", t.dark.soft)}${sw("Text on primary", t.dark.on)}${sw("Focus ring", t.dark.focus)}${sw("Accent", t.dark.accent)}</div></div>`;
  }
  function previewsHtml(tab) {
    const pair = tab === "signin" ? [signinPreview("light"), signinPreview("dark")] : tab === "email" ? [emailPreview("light"), emailPreview("dark")] : [appPreview("light"), appPreview("dark")];
    return `<div class="card"><div class="row" style="justify-content:space-between;margin-bottom:8px"><h2 style="margin:0">Live preview</h2><span class="small muted">Only this preview changes until you publish.</span></div>
      <div class="bp-pair2">${pair.join("")}</div></div>
      <div class="card" style="margin-top:16px" id="bp-contrast">${contrastHtml()}</div>`;
  }

  // ---------- editor tabs ----------
  const colourField = (label, key, hint) => {
    const v = getPath(B, key);
    return ui.field(label, `<div class="row" style="flex-wrap:nowrap"><input type="color" class="bp-color" data-b="${key}" value="${isHex(v) ? v.toLowerCase() : "#000000"}" aria-label="${esc(label)} picker">
      <input class="input" data-b="${key}" data-hex="1" value="${esc(v)}" maxlength="7" style="width:110px" aria-label="${esc(label)} hex"></div>`, hint);
  };
  const upload = (label, key, accept, hint) => `<div class="field"><label>${esc(label)}</label><div class="row">
      <div class="bp-drop">${B[key] ? `<img src="${B[key]}" alt="${esc(label)} preview">` : `<span class="muted small">No file</span>`}</div>
      <label class="btn sm">${ui.icon("inbox", 'width="14" height="14"')}Upload<input type="file" accept="${accept}" data-up="${key}" hidden></label>
      ${B[key] ? ui.btn("Remove", { kind: "ghost sm", attrs: `data-rm="${key}"` }) + `<span class="small muted">${esc(B[key + "Name"] || "")}</span>` : ""}</div><div class="hint">${hint}</div></div>`;
  function brandTab() {
    return `<div class="card"><h2>Name and logo</h2>
        ${ui.field("Product name", `<input class="input" data-b="name" maxlength="60" value="${esc(B.name)}">`, "Up to 60 characters. Used in the browser tab, header, sign-in page and emails.")}
        <label class="check" style="margin-bottom:12px"><input type="checkbox" data-b="showName" ${B.showName ? "checked" : ""}> Show the name next to the logo</label>
        ${upload("Logo (light background)", "logo", ".svg,.png", "SVG or PNG, up to 1 MB, about 240 × 48. Shown 32 px high. SVGs are cleaned before saving: scripts and outside links are removed.")}
        ${upload("Logo for dark mode (optional)", "logoDark", ".svg,.png", "Used on dark headers. If empty, the main logo is used.")}
        ${upload("Favicon", "favicon", ".svg,.png", "Square SVG or PNG. Browser, bookmark and home-screen icons are made from it.")}
        <div class="bp-tab" aria-label="Browser tab preview"><span class="bp-fav">${B.favicon ? `<img src="${B.favicon}" alt="">` : esc((B.name || "R")[0])}</span><span>${esc(B.name)} · Candidates</span><span class="muted">×</span></div>
      </div>
      <div class="card" style="margin-top:16px"><h2>Colours</h2>
        <div class="grid g2" style="gap:12px">${colourField("Primary colour", "primary", "Buttons, links, focus rings and selected items.")}${colourField("Accent colour", "accent", "Badges, highlights and chart series 2.")}</div>
        ${ui.field("Header style", `<select class="input" data-b="header">${[["plain", "Plain (surface colour)"], ["brand", "Brand colour"]].map(([v, l]) => `<option value="${v}" ${B.header === v ? "selected" : ""}>${l}</option>`).join("")}</select>`)}
        ${ui.field("Density", `<select class="input" data-b="density">${[["comfortable", "Comfortable"], ["compact", "Compact"]].map(([v, l]) => `<option value="${v}" ${B.density === v ? "selected" : ""}>${l}</option>`).join("")}</select>`)}
        <h3>Derived tokens</h3><p class="small muted" style="margin-top:0">Worked out from your colours for both themes. Status colours (To do, In progress, Done) stay fixed for accessibility.</p>
        <div id="bp-tokens">${tokensHtml()}</div></div>`;
  }
  function signinTab() {
    const bgs = [["gradient", "Brand gradient"], ["plain", "Plain"], ["pattern", "Pattern"], ["image", "Your image"]];
    return `<div class="card"><h2>Sign-in page</h2>
      <p class="small muted" style="margin-top:0">Shown before anyone signs in, so never put private information here.</p>
      ${ui.field("Heading", `<input class="input" data-b="signHeading" maxlength="80" value="${esc(B.signHeading)}">`)}
      ${ui.field("Message", `<textarea class="input" rows="3" data-b="signText">${esc(B.signText)}</textarea>`, "Add an Arabic version on the Localisation page.")}
      <div class="field"><label>Background</label><div class="row">${bgs.map(([v, l]) => `<label class="check"><input type="radio" name="bp-bg" data-b="signBg" value="${v}" ${B.signBg === v ? "checked" : ""}> ${l}</label>`).join("")}</div></div>
      ${B.signBg === "image" ? upload("Background image", "signImage", ".png,.jpg,.jpeg,.webp", "JPG, PNG or WebP up to 2 MB. Photo details (EXIF) are removed.") : ""}
      <label class="check"><input type="checkbox" data-b="signForgot" ${B.signForgot ? "checked" : ""}> Show “Forgot your password?” link</label></div>`;
  }
  function emailTab() {
    return `<div class="card"><h2>Email branding</h2><p class="small muted" style="margin-top:0">Used by every email: invitations, password resets, interview invites and digests.</p>
      ${ui.field("Sender name", `<input class="input" data-b="emailSender" value="${esc(B.emailSender)}">`, `Sender address is set on the <a href="#/mail">Outgoing mail</a> page.`)}
      ${ui.field("Header", `<select class="input" data-b="emailHeader">${[["white", "Logo on white"], ["brand", "Logo on brand colour"]].map(([v, l]) => `<option value="${v}" ${B.emailHeader === v ? "selected" : ""}>${l}</option>`).join("")}</select>`)}
      ${ui.field("Footer text", `<textarea class="input" rows="3" data-b="emailFooter">${esc(B.emailFooter)}</textarea>`, "Company address and why people get the email.")}
      ${ui.btn("Send test email to me", { kind: "sm", attrs: 'data-act="testmail"' })}</div>`;
  }
  function bannerTab() {
    const bad = B.banner.end && B.banner.start && B.banner.end <= B.banner.start;
    return `<div class="card"><h2>Announcement banner</h2>
      <label class="check" style="margin-bottom:12px"><input type="checkbox" data-b="banner.on" ${B.banner.on ? "checked" : ""}> Show a banner at the top of every page</label>
      ${ui.field("Text", `<textarea class="input" rows="3" maxlength="200" data-b="banner.text">${esc(B.banner.text)}</textarea>`, "Up to 200 characters. Plain text and links only.")}
      <div class="grid g2" style="gap:12px">${ui.field("Type", `<select class="input" data-b="banner.tone">${[["info", "Information"], ["warning", "Warning"], ["critical", "Critical"]].map(([v, l]) => `<option value="${v}" ${B.banner.tone === v ? "selected" : ""}>${l}</option>`).join("")}</select>`)}
        ${colourField("Colour", "banner.colour", "")}</div>
      <div class="grid g2" style="gap:12px">${ui.field("Starts", `<input class="input" type="datetime-local" data-b="banner.start" value="${esc(B.banner.start)}">`)}${ui.field("Ends", `<input class="input" type="datetime-local" data-b="banner.end" value="${esc(B.banner.end)}">`)}</div>
      <div id="bp-sched">${bad ? `<div class="callout bad">The end is before the start.</div>` : `<p class="small muted">Shows from ${esc(B.banner.start.replace("T", " "))} to ${esc(B.banner.end.replace("T", " "))} (UAE time).</p>`}</div>
      ${ui.field("Who sees it", `<select class="input" data-b="banner.audience">${["Everyone signed in", "Everyone, including the sign-in page", "Company admins only", "Group: recruiters"].map((v) => `<option ${B.banner.audience === v ? "selected" : ""}>${v}</option>`).join("")}</select>`)}
      <label class="check"><input type="checkbox" data-b="banner.dismiss" ${B.banner.dismiss ? "checked" : ""}> People can close it (it shows again if the text changes)</label></div>`;
  }
  function historyTab() {
    return `<div class="card"><h2>Versions</h2><p class="small muted" style="margin-top:0">Every publish is kept. Reverting creates a draft from that version; nothing changes until you publish.</p>
      ${ui.table(["Version", "Published", "By", "Changes", ""], [
        ...(dirty() ? [[ui.badge("Draft", "warn"), "Not published", "Omar Alshair", "Unpublished changes", ""]] : []),
        ...HISTORY.map((h) => [`v${h.v} ${h.v === version ? ui.badge("Live", "ok") : ""}`, esc(h.when), esc(h.who), esc(h.what), h.v === version ? "" : ui.btn("Revert", { kind: "sm", attrs: `data-revert="${h.v}"` })]),
      ])}</div>`;
  }

  const STYLE = `<style>
    .bp-layout{display:grid;grid-template-columns:minmax(0,400px) minmax(0,1fr);gap:16px;align-items:start}
    .bp-right{position:sticky;top:0}
    .bp-pair2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .bp-prev{background:var(--bp-bg);color:var(--bp-text);border:1px solid var(--border);border-radius:12px;overflow:hidden;font-size:12px;position:relative}
    .bp-cap{position:absolute;inset-block-end:6px;inset-inline-end:8px;font-size:10px;color:var(--bp-muted);text-transform:uppercase;letter-spacing:.06em}
    .bp-head{display:flex;align-items:center;gap:6px;padding:8px 10px;background:var(--bp-header-bg);color:var(--bp-header-fg);border-bottom:1px solid var(--bp-border)}
    .bp-mark{display:inline-grid;place-items:center;border-radius:6px;background:var(--bp-primary);color:var(--bp-on);font-weight:700;font-size:11px;flex:none}
    .bp-name{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px}
    .bp-search{flex:1;margin-inline-start:6px;padding:3px 8px;border-radius:6px;border:1px solid var(--bp-border);background:var(--bp-surface);color:var(--bp-muted);font-size:10px;white-space:nowrap;overflow:hidden}
    .bp-av{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;background:var(--bp-soft);color:var(--bp-link);font-size:9px;font-weight:700;flex:none}
    .bp-body{display:grid;grid-template-columns:96px 1fr;min-height:200px}
    .bp-side{background:var(--bp-surface);border-inline-end:1px solid var(--bp-border);padding:8px 6px}
    .bp-item{padding:5px 8px;border-radius:var(--bp-radius);margin-bottom:2px}
    .bp-item.on{background:var(--bp-soft);color:var(--bp-link);font-weight:700}
    .bp-main{padding:10px}
    .bp-card{background:var(--bp-surface);border:1px solid var(--bp-border);border-radius:var(--bp-radius);padding:10px}
    .bp-row{display:flex;gap:6px;align-items:center;justify-content:space-between;flex-wrap:wrap}
    .bp-muted{color:var(--bp-muted)}
    .bp-badge{background:var(--bp-accent-soft);color:var(--bp-accent);border-radius:999px;padding:1px 7px;font-weight:700;font-size:10px}
    .bp-lbl{display:block;font-weight:700;font-size:11px;margin:8px 0 3px}
    .bp-input{border:1px solid var(--bp-border);background:var(--bp-surface);border-radius:calc(var(--bp-radius) - 3px);padding:5px 8px}
    .bp-input.focus{outline:2px solid var(--bp-focus);outline-offset:1px}
    .bp-btn{display:inline-block;border:1px solid var(--bp-border);background:var(--bp-surface);color:var(--bp-text);border-radius:calc(var(--bp-radius) - 3px);padding:4px 10px;font-weight:700}
    .bp-btn.pri{background:var(--bp-primary);border-color:var(--bp-primary);color:var(--bp-on)}
    .bp-link{color:var(--bp-link);text-decoration:underline}
    .bp-banner{display:flex;gap:6px;align-items:center;background:var(--bp-banner);color:var(--bp-banner-fg);padding:6px 10px;font-size:11px}
    .bp-banner span:nth-child(2){flex:1}.bp-x{font-size:14px;line-height:1}
    .bp-sign{min-height:330px;display:grid;place-items:center;padding:20px 10px}
    .bp-sign.bg-gradient{background:linear-gradient(135deg,var(--bp-primary),var(--bp-accent))}
    .bp-sign.bg-pattern{background-color:var(--bp-soft);background-image:radial-gradient(var(--bp-primary) 1px,transparent 1.5px);background-size:14px 14px}
    .bp-signcard{background:var(--bp-surface);border:1px solid var(--bp-border);border-radius:var(--bp-radius);padding:14px;width:min(220px,100%)}
    .bp-signcard h3{margin:8px 0 4px;font-size:14px}.bp-signcard p{margin:0;font-size:11px}
    .bp-mail{padding-bottom:22px}.bp-mailmeta{padding:8px 10px;border-bottom:1px solid var(--bp-border);font-size:11px;color:var(--bp-muted)}.bp-mailmeta b{color:var(--bp-text)}
    .bp-mailhead{display:flex;gap:6px;align-items:center;padding:12px;background:var(--bp-surface);border-bottom:3px solid var(--bp-primary)}
    .bp-mailhead.brand{background:var(--bp-primary);color:var(--bp-on)}
    .bp-mailbody{padding:10px 12px;background:var(--bp-surface)}.bp-mailbody p{margin:0 0 8px}
    .bp-mailfoot{padding:8px 12px;font-size:10px;color:var(--bp-muted)}
    .bp-pair{display:inline-grid;place-items:center;width:34px;height:26px;border-radius:6px;font-weight:700;border:1px solid var(--border);flex:none}
    .bp-color{width:42px;height:34px;padding:2px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface);cursor:pointer;flex:none}
    .bp-scale{display:grid;grid-template-columns:repeat(10,1fr);border-radius:8px;overflow:hidden;margin-bottom:10px;border:1px solid var(--border)}
    .bp-scale span{font-size:10px;text-align:center;padding:8px 0}
    .bp-toks{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .bp-tok{display:flex;gap:6px;align-items:center;font-size:12px;margin:4px 0}.bp-tok code{margin-inline-start:auto}
    .bp-sw{width:16px;height:16px;border-radius:4px;border:1px solid var(--border-strong);flex:none}
    .bp-drop{width:120px;height:44px;border:1px dashed var(--border-strong);border-radius:8px;display:grid;place-items:center;background:var(--surface-subtle);overflow:hidden}
    .bp-drop img{max-width:110px;max-height:36px}
    .bp-tab{display:inline-flex;gap:8px;align-items:center;border:1px solid var(--border);border-bottom:0;border-radius:8px 8px 0 0;padding:6px 12px;background:var(--surface-subtle);font-size:12px}
    .bp-fav{width:16px;height:16px;border-radius:4px;display:grid;place-items:center;background:var(--primary);color:var(--surface);font-size:10px;font-weight:700;overflow:hidden}.bp-fav img{width:16px;height:16px}
    @media (max-width:1200px){.bp-layout{grid-template-columns:1fr}.bp-right{position:static}}
  </style>`;

  function headActions() {
    return [ui.btn("Save draft", { attrs: 'data-act="save"' }), ui.btn(previewAsMe ? "Stop preview" : "Preview as me", { attrs: 'data-act="preview"' }),
      ui.btn("Publish", { kind: "primary", attrs: 'data-act="publish"' }), ui.btn("Reset to default", { kind: "danger", attrs: 'data-act="reset"' })].join("");
  }
  function headDesc() {
    return `White-label the workspace for every team: name, logo, colours, sign-in page, emails and banner. ${ui.badge("Live: v" + version, "ok")} ${dirty() ? ui.badge("Draft has unpublished changes", "warn") : ""}`;
  }

  Admin.register({
    id: "branding",
    group: "Look & feel",
    title: "Look & feel",
    icon: "palette",
    spec: ["BRD-001", "BRD-002", "BRD-003", "BRD-005", "BRD-010", "BRD-011", "BRD-030"],
    changes: "New. Today the brand colour and logo are fixed in code. Admins can now white-label the app with a live light/dark preview, contrast checks, draft and publish, and version history.",
    render(ctx) {
      const head = ui.pageHeader("Look & feel", headDesc(), headActions());
      if (ctx.state !== "normal")
        return head + ui.stateBlock(ctx.state, { emptyTitle: "Using the RecruitmentOS defaults", emptyText: "No custom branding yet. Start with your product name, logo and colours.", emptyAction: ui.btn("Start branding", { kind: "primary", attrs: "onclick=\"Admin.setState('normal')\"" }) });
      const tab = ctx.query.get("tab") || "brand";
      const tabs = ui.tabs("bp", [{ id: "brand", label: "Brand" }, { id: "signin", label: "Sign-in page" }, { id: "email", label: "Emails" }, { id: "banner", label: "Announcement" }, { id: "history", label: "Versions" }], tab);
      const left = { brand: brandTab, signin: signinTab, email: emailTab, banner: bannerTab, history: historyTab }[tab] || brandTab;
      return STYLE + `<div id="bp-page" data-tab="${esc(tab)}"><div id="bp-head">${head}</div>
        ${previewAsMe ? `<div class="callout warn" style="margin-bottom:12px"><b>Previewing the draft as you.</b> Only you see the draft look for the next 30 minutes; everyone else sees v${version}. <a href="javascript:void 0" data-act="preview">Stop preview</a></div>` : ""}
        ${tabs}<div class="bp-layout"><div id="bp-left">${left()}</div><div class="bp-right" id="bp-right">${previewsHtml(tab)}</div></div></div>`;
    },
    mount(root, ctx) {
      if (ctx.state !== "normal") { root.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => Admin.toast("Not available while the page is " + ctx.state))); return; }
      const page = root.querySelector("#bp-page");
      const tab = page.dataset.tab;
      const refresh = () => {
        page.querySelector("#bp-right").innerHTML = previewsHtml(tab);
        const tk = page.querySelector("#bp-tokens"); if (tk) tk.innerHTML = tokensHtml();
        const sc = page.querySelector("#bp-sched");
        if (sc) sc.innerHTML = B.banner.end <= B.banner.start ? `<div class="callout bad">The end is before the start.</div>` : `<p class="small muted">Shows from ${esc(B.banner.start.replace("T", " "))} to ${esc(B.banner.end.replace("T", " "))} (UAE time).</p>`;
        page.querySelector("#bp-head").innerHTML = ui.pageHeader("Look & feel", headDesc(), headActions());
      };
      const syncColour = (key) => page.querySelectorAll(`[data-b="${key}"]`).forEach((el) => { const v = getPath(B, key); if (el.type === "color") { if (isHex(v)) el.value = v.toLowerCase(); } else if (el !== document.activeElement) el.value = v; });
      const onEdit = (e) => {
        const el = e.target, key = el.dataset.b;
        if (!key) return;
        let v = el.type === "checkbox" ? el.checked : el.value;
        if (el.type === "radio" && !el.checked) return;
        if (el.type === "color") v = v.toUpperCase();
        if (el.dataset.hex) { v = v.trim(); if (!v.startsWith("#")) v = "#" + v; el.style.borderColor = isHex(v) ? "" : "var(--danger)"; if (!isHex(v)) return; v = v.toUpperCase(); }
        setPath(B, key, v);
        if (key === "banner.tone") { B.banner.colour = TONES[v]; syncColour("banner.colour"); }
        if (/primary|accent|colour/.test(key)) syncColour(key);
        if (key === "signBg") { page.querySelector("#bp-left").innerHTML = signinTab(); }
        refresh();
      };
      page.addEventListener("input", onEdit);
      page.addEventListener("change", (e) => {
        const el = e.target;
        if (el.dataset.up) {
          const f = el.files && el.files[0];
          if (!f) return;
          const max = el.dataset.up === "signImage" ? 2 : 1;
          if (f.size > max * 1024 * 1024) return Admin.toast(`That file is over ${max} MB. Choose a smaller one.`);
          const r = new FileReader();
          r.onload = () => { B[el.dataset.up] = r.result; B[el.dataset.up + "Name"] = f.name; page.querySelector("#bp-left").innerHTML = tab === "signin" ? signinTab() : brandTab(); refresh(); Admin.toast(f.name.endsWith(".svg") ? "Uploaded. SVG cleaned: scripts and outside links removed (mockup)." : "Uploaded (stays in this browser, mockup)."); };
          r.readAsDataURL(f);
          return;
        }
      });
      page.addEventListener("click", (e) => {
        const fix = e.target.closest("[data-fix]"), rm = e.target.closest("[data-rm]"), rv = e.target.closest("[data-revert]"), act = e.target.closest("[data-act]");
        if (fix) {
          const c = checks(B)[+fix.dataset.fix];
          setPath(B, c.key, c.fix.hex); syncColour(c.key); refresh();
          return Admin.toast(`Changed to ${c.fix.hex}. Check the other results.`);
        }
        if (rm) { B[rm.dataset.rm] = null; B[rm.dataset.rm + "Name"] = ""; page.querySelector("#bp-left").innerHTML = tab === "signin" ? signinTab() : brandTab(); return refresh(); }
        if (rv) {
          const h = HISTORY.find((x) => x.v === +rv.dataset.revert);
          Admin.modal(`<h2>Revert to version ${h.v}?</h2><p>This replaces your draft with version ${h.v} (${esc(h.what)}). Nothing changes for users until you publish.</p>
            <div class="row" style="justify-content:flex-end">${ui.btn("Cancel", { attrs: 'onclick="Admin.close()"' })}${ui.btn("Create draft from v" + h.v, { kind: "primary", attrs: 'id="bp-rv-ok"' })}</div>`);
          document.getElementById("bp-rv-ok").addEventListener("click", () => { Object.assign(B, h.snap); Admin.close(); Admin.toast(`Draft created from version ${h.v}`); Admin.rerender(); });
          return;
        }
        if (!act) return;
        const a = act.dataset.act;
        if (a === "save") return Admin.toast("Draft saved (mockup). Only admins see it.");
        if (a === "testmail") return Admin.toast("Test email sent to omar.alshair@example.test (mockup)");
        if (a === "preview") { previewAsMe = !previewAsMe; Admin.toast(previewAsMe ? "Previewing the draft as you (mockup)" : "Preview stopped"); return Admin.rerender(); }
        if (a === "reset") {
          Admin.modal(`<h2>Reset to RecruitmentOS defaults?</h2><ul><li>Name, logo, favicon, colours, sign-in page and email branding go back to the product defaults.</li>
            <li>This only changes the draft. Everyone keeps seeing v${version} until you publish.</li><li>The banner is turned off.</li></ul>
            <div class="row" style="justify-content:flex-end">${ui.btn("Cancel", { attrs: 'onclick="Admin.close()"' })}${ui.btn("Reset draft", { kind: "danger", attrs: 'id="bp-reset-ok"' })}</div>`);
          document.getElementById("bp-reset-ok").addEventListener("click", () => { B = clone(DEFAULTS); Admin.close(); Admin.toast("Draft reset to defaults"); Admin.rerender(); });
          return;
        }
        if (a === "publish") {
          const fails = checks(B).filter((c) => !c.ok);
          ackFails = false;
          Admin.modal(`<h2>Publish look &amp; feel as version ${version + 1}?</h2>
            <ul><li>Applies to all 3 teams (19 members), the sign-in page and every email.</li><li>People see it on their next page load. No cache clearing needed.</li>
            <li>Version ${version} is kept so you can revert.</li></ul>
            ${fails.length ? `<div class="callout bad"><b>${fails.length} contrast ${fails.length === 1 ? "check fails" : "checks fail"}:</b><ul style="margin:6px 0">${fails.map((f) => `<li>${esc(f.label)} (${f.r.toFixed(2)}:1)</li>`).join("")}</ul>
              <label class="check"><input type="checkbox" id="bp-ack"> I am a company owner and accept publishing with failing contrast. This is recorded in the audit log.</label></div>` : `<div class="callout ok">All contrast checks pass.</div>`}
            <div class="row" style="justify-content:flex-end;margin-top:12px">${ui.btn("Cancel", { attrs: 'onclick="Admin.close()"' })}${ui.btn("Publish", { kind: "primary", attrs: `id="bp-pub-ok" ${fails.length ? "disabled" : ""}` })}</div>`);
          const ok = document.getElementById("bp-pub-ok"), ack = document.getElementById("bp-ack");
          if (ack) ack.addEventListener("change", () => { ackFails = ack.checked; ok.disabled = !ackFails; });
          ok.addEventListener("click", () => {
            version += 1; published = clone(B);
            HISTORY.unshift({ v: version, when: "Today, just now", who: "Omar Alshair", what: `Colours ${B.primary} / ${B.accent}${B.banner.on ? ", banner" : ""}`, snap: { name: B.name, primary: B.primary, accent: B.accent } });
            Admin.close(); Admin.toast(`Published version ${version} (mockup)`); Admin.rerender();
          });
        }
      });
    },
  });
})();
