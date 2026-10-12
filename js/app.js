/* Oberfläche der Demo. Fachlogik steht in domain.js, Daten in store.js. */
(function () {
  'use strict';
  const D = window.Domain;
  const H = 3600 * 1000;
  const DAY = 24 * H;

  const USER_STATUS = { aktiv: 'aktiv', wartet: 'wartet auf Freigabe', abgelehnt: 'abgelehnt', gesperrt: 'gesperrt', abgelaufen: 'Saison abgelaufen' };
  const USER_TYPE = { jahreskarte: 'Jahreskarte', registriert: 'Registriert' };
  const LABEL = {
    frei: 'Frei',
    reserviert: 'Reserviert – Ankunft offen',
    anwesend: 'Belegt – Anwesenheit bestätigt',
    gesperrt: 'Gesperrt',
    ungeklaert: 'Belegung ungeklärt',
  };

  const CARD = { tageskarte: 'Tageskarte', '24h': '24-Stunden-Karte', jahreskarte: 'Jahreskarte' };

  let S = window.Store.load(); // { bookings, users, settings, spots, mails, log, clockOffset, who }
  const ui = { tab: 'overview', viewT: null, spotPage: null, from: null, to: null, msg: null, dlg: null, qrBase: null };

  // ---------- Helfer ----------
  const now = () => Date.now() + S.clockOffset;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (ms) => new Date(ms).toLocaleString('de-AT', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const pad = (n) => String(n).padStart(2, '0');
  const inputVal = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const parseVal = (v) => (v ? new Date(v).getTime() : NaN);
  const ceilHour = (ms) => Math.ceil(ms / H) * H;
  const startOfDay = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const newUserId = () => 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  const season = () => new Date(now()).getFullYear(); // Freigabe gilt pro Saison (= Kalenderjahr)
  const effStatus = (u) => (u.status === 'aktiv' && u.season < season() ? 'abgelaufen' : u.status);
  const userById = (id) => S.users.find((u) => u.id === id);
  function whoMap() {
    const m = { gast: { label: 'Gast (nicht angemeldet)' } };
    S.users.forEach((u) => {
      const st = effStatus(u);
      m[u.id] = { id: u.id, name: u.name, status: st, label: `${USER_TYPE[u.type]}: ${u.name}${st === 'aktiv' ? '' : ' (' + USER_STATUS[st] + ')'}` };
    });
    m.betreiber = { operator: true, name: 'Erwin Schuster', label: 'Betreiber: Erwin Schuster' };
    return m;
  }
  const user = () => { const m = whoMap(); return m[S.who] || m.gast; };
  const isOp = () => !!user().operator;
  const uid = () => user().id || null;
  const loggedIn = () => S.who !== 'gast' && (isOp() || user().status === 'aktiv');
  const pending = () => S.who !== 'gast' && !isOp() && user().status && user().status !== 'aktiv';
  const isJK = () => { const u = userById(uid()); return !!u && u.type === 'jahreskarte'; };
  const canManage = (b) => isOp() || (uid() && b.ownerId === uid());
  const spotName = (n) => (S.spots.find((s) => s.id === n) || {}).name || `Platz ${n}`;
  const spotNote = (n) => (S.spots.find((s) => s.id === n) || {}).note || '';

  // ---------- Betriebsregeln (aus den Einstellungen; leer/0 = aus) ----------
  const num = (v) => (v === null || v === undefined || v === '' || !(Number(v) > 0) ? null : Number(v));
  function rules() {
    const s = S.settings;
    const mul = (v, f) => (num(v) == null ? null : num(v) * f);
    const hour = s.changeoverHour === null || s.changeoverHour === '' || s.changeoverHour === undefined ? null : Number(s.changeoverHour);
    return {
      advMs: mul(s.maxAdvanceDays, DAY), advDays: num(s.maxAdvanceDays),
      durMs: mul(s.maxDurationDays, DAY), durDays: num(s.maxDurationDays),
      maxOpen: num(s.maxOpenReservations),
      graceMs: mul(s.graceHours, H), graceH: num(s.graceHours),
      spontMs: mul(s.maxSpontaneousHours, H), spontH: num(s.maxSpontaneousHours),
      lateMs: mul(s.cancelDeadlineHours, H), lateH: num(s.cancelDeadlineHours),
      warn: num(s.warnCount), remindMs: mul(s.reminderHours, H), hour,
    };
  }
  // Kartenarten (Annahmen: Tageskarte im Zeitfenster, 24-Stunden-Karte = Vielfache von 24 h, Jahreskarte jederzeit)
  const cardCfg = () => ({ tagVon: num(S.settings.tageskarteVon) || 5, tagBis: num(S.settings.tageskarteBis) || 22 });
  function cardHint(c) {
    const g = cardCfg();
    return { tageskarte: `Gilt von ${pad(g.tagVon)}:00 bis ${pad(g.tagBis)}:00 Uhr (Fischzeit laut Teichordnung).`, '24h': 'Gilt 24 Stunden ab Beginn (bei mehreren Tagen ein Vielfaches).', jahreskarte: 'Gilt jederzeit.' }[c] || '';
  }
  /** Passt Beginn/Ende an die gewählte Kartenart an (Hilfe im Dialog). */
  function snapCard(d) {
    const n = now(); const g = cardCfg();
    const clamp = (ms) => { const dt = new Date(ms); const m = dt.getHours() * 60 + dt.getMinutes(); if (m < g.tagVon * 60) dt.setHours(g.tagVon, 0, 0, 0); else if (m > g.tagBis * 60) dt.setHours(g.tagBis, 0, 0, 0); return dt.getTime(); };
    if (d.kind === 'spontaneous') {
      const m = D.maxSpontaneousEnd(S.bookings, d.spotId, n);
      let end = n + 4 * H;
      if (d.card === '24h') end = n + DAY;
      else if (d.card === 'tageskarte') { const t = new Date(n); t.setHours(g.tagBis, 0, 0, 0); if (t.getTime() > n) end = t.getTime(); }
      d.end = m.maxEnd ? Math.min(m.maxEnd, end) : end;
    } else if (d.kind === 'reservation') {
      if (d.card === 'tageskarte') {
        d.start = clamp(d.start); d.end = clamp(d.end);
        if (d.end <= d.start) { const t = new Date(d.start); t.setHours(g.tagBis, 0, 0, 0); d.end = t.getTime(); }
      } else if (d.card === '24h') d.end = d.start + Math.max(1, Math.round((d.end - d.start) / DAY)) * DAY;
    }
    return d;
  }
  function cardField(d) {
    if (!['reservation', 'spontaneous', 'edit'].includes(d.kind)) return '';
    if (!isOp() && isJK()) return `<div class="small">Kartenart: <b>${CARD.jahreskarte}</b> – gilt jederzeit</div>`;
    const cards = isOp() ? ['tageskarte', '24h', 'jahreskarte'] : ['tageskarte', '24h'];
    const cur = d.card || 'tageskarte';
    return `<label class="f">Kartenart<select name="card" data-change="dlgCard">${cards.map((c) => `<option value="${c}"${c === cur ? ' selected' : ''}>${CARD[c]}</option>`).join('')}</select></label><div class="small muted">${cardHint(cur)}</div>`;
  }
  function guestOpts() {
    const r = rules();
    return {
      maxAdvanceMs: r.advMs, maxDurationMs: r.durMs, maxOpenPerUser: r.maxOpen, cardCfg: cardCfg(),
      isChangeover: r.hour == null ? null : (ms) => { const d = new Date(ms); return d.getHours() === r.hour && d.getMinutes() === 0; },
      changeoverText: r.hour == null ? '' : `${pad(r.hour)}:00 Uhr`,
    };
  }
  function userStats(u) {
    const n = now();
    const mine = S.bookings.filter((b) => b.ownerId === u.id);
    return { noShows: mine.filter((b) => D.isNoShow(b, n)).length, late: mine.filter((b) => b.lateCancel).length };
  }

  // ---------- Speicher, Protokoll, E-Mail (Demo-Postfach) ----------
  function save() { window.Store.save(S); }
  function logEntry(text, who) { S.log.unshift({ t: now(), who: who || user().name || 'Gast', text }); S.log = S.log.slice(0, 80); }
  function toast(type, text) { ui.msg = { type, text }; }
  function mail(to, subject, body) {
    if (!to) return;
    S.mails.unshift({ t: now(), to, subject, body });
    S.mails = S.mails.slice(0, 100);
  }
  const mailUser = (u, subject, body) => u && mail(u.email, subject, body);
  const mailOperator = (subject, body) => mail(S.settings.operatorEmail, subject, body);
  function apply(res, okText, logText) {
    if (!res.ok) { toast('err', res.error); render(); return false; }
    S.bookings = res.bookings;
    logEntry(logText || okText);
    save();
    toast('ok', okText);
    render();
    return true;
  }

  /** Automatische Vorgänge: Karenzzeit, Erinnerung, Hinweis bei ungeklärter Belegung. */
  function housekeeping() {
    const n = now(); const r = rules(); let changed = false;
    if (r.graceMs) {
      const res = D.applyNoShows(S.bookings, n, r.graceMs);
      if (res.affected.length) {
        S.bookings = res.bookings; changed = true;
        res.affected.forEach((id) => {
          const b = S.bookings.find((x) => x.id === id);
          logEntry(`Automatisch freigegeben (nicht angetreten): ${spotName(b.spotId)} ${fmt(b.start)}`, 'System');
          mailUser(userById(b.ownerId), 'Reservierung freigegeben',
            `Deine Reservierung für ${spotName(b.spotId)} (${fmt(b.start)} – ${fmt(b.plannedEnd)}) wurde freigegeben, weil die Ankunft nicht innerhalb von ${r.graceH} Stunden nach Beginn bestätigt wurde.`);
        });
      }
    }
    S.bookings.forEach((b) => {
      if (b.kind === 'block' || b.cancelledAt != null) return;
      if (r.remindMs && b.ownerId && !b.reminderSent && b.releasedAt == null && b.start > n && b.start - n <= r.remindMs) {
        b.reminderSent = true; changed = true;
        mailUser(userById(b.ownerId), 'Erinnerung an deine Reservierung',
          `Du hast ${spotName(b.spotId)} ab ${fmt(b.start)} bis ${fmt(b.plannedEnd)} reserviert. Bitte nach der Ankunft die Anwesenheit bestätigen.`);
      }
      if (b.releasedAt == null && b.arrivalConfirmedAt != null && b.plannedEnd <= n && !b.unclearNotified) {
        b.unclearNotified = true; changed = true;
        mailOperator('Belegung ungeklärt', `${spotName(b.spotId)}: geplantes Ende (${fmt(b.plannedEnd)}) überschritten, keine Freigabe gemeldet (${b.name || 'unbekannt'}).`);
      }
    });
    if (changed) save();
  }

  // ---------- Kopf, Tabs ----------
  function renderWho() {
    $('#who').innerHTML = `<label class="small">Demo-Ansicht als: <select data-change="who">${Object.entries(whoMap())
      .map(([k, v]) => `<option value="${k}"${k === S.who ? ' selected' : ''}>${esc(v.label)}</option>`).join('')}</select></label>`;
  }
  function tabsForRole() {
    const t = [['overview', 'Übersicht'], ['reserve', 'Reservieren']];
    if (S.who === 'gast') t.push(['register', 'Registrieren']);
    if (loggedIn() && !isOp()) t.push(['mine', 'Meine Buchungen']);
    if (isOp()) {
      const w = S.users.filter((u) => u.status === 'wartet').length;
      t.push(['operator', 'Betreiber'], ['users', 'Benutzer' + (w ? ` (${w} neu)` : '')], ['rules', 'Regeln & Plätze'], ['mail', 'Postfach'], ['qr', 'QR-Codes']);
    }
    return t;
  }
  function renderTabs() {
    const tabs = tabsForRole();
    if (!tabs.some(([k]) => k === ui.tab)) ui.tab = 'overview';
    $('#tabs').innerHTML = tabs.map(([k, l]) => `<button data-action="tab" data-tab="${k}"${!ui.spotPage && k === ui.tab ? ' aria-current="page"' : ''}>${l}</button>`).join('');
  }

  // ---------- Platzkarte ----------
  function spotCard(spotId, t, live) {
    const n = now();
    const st = D.spotStatus(S.bookings, spotId, t, n);
    let info;
    if (st.state === 'frei') info = st.freeUntil ? `Frei bis ${fmt(st.freeUntil)}` : 'Frei, derzeit keine weitere Reservierung';
    else if (st.state === 'ungeklaert') info = `Geplantes Ende war ${fmt(st.overdue.plannedEnd)}. Wer den Platz tatsächlich belegt, ist ungeklärt.`;
    else info = `bis ${fmt(D.effectiveEnd(st.booking))}`;
    const b = st.booking;
    if (b && b.kind !== 'block' && canManage(b)) info += `<br><b>${esc(b.name)}</b>`;
    if (b && b.kind === 'block' && isOp() && b.note) info += `<br>${esc(b.note)}`;
    let extra = '';
    if (st.overdue && st.state !== 'ungeklaert')
      extra = `<div class="warn">Frühere Belegung: geplantes Ende (${fmt(st.overdue.plannedEnd)}) überschritten, Freigabe fehlt.</div>`;
    if (spotNote(spotId)) extra += `<div class="muted small">${esc(spotNote(spotId))}</div>`;

    const act = [];
    if (live && loggedIn()) {
      if (st.state === 'frei') act.push(`<button class="btn sm" data-action="occupy" data-spot="${spotId}">Jetzt belegen</button>`);
      if (b && b.kind !== 'block' && canManage(b)) {
        if (b.arrivalConfirmedAt == null && n >= b.start) act.push(`<button class="btn sm" data-action="arrive" data-id="${b.id}">Ankunft bestätigen</button>`);
        act.push(`<button class="btn sm sec" data-action="extend" data-id="${b.id}">Verlängern</button>`);
        act.push(`<button class="btn sm sec" data-action="release" data-id="${b.id}">Platz freigeben</button>`);
      }
      if (st.overdue && canManage(st.overdue))
        act.push(`<button class="btn sm${st.state === 'ungeklaert' ? '' : ' sec'}" data-action="release" data-id="${st.overdue.id}">Platz ist geräumt</button>`);
    }
    if (loggedIn()) act.push(`<button class="btn sm sec" data-action="reserve" data-spot="${spotId}" data-from="${live ? '' : t}">Reservieren</button>`);

    return `<article class="card st-${st.state}">
      <h3><a href="#/platz/${spotId}">${esc(spotName(spotId))}</a><span class="badge ${st.state}">${LABEL[st.state]}</span></h3>
      <div>${info}</div>${extra}
      <div class="actions">${act.join('')}</div></article>`;
  }

  // ---------- Zeitleiste (14 Tage) ----------
  function timeline(t0) {
    const n = now();
    const d0 = new Date(startOfDay(t0));
    const days = Array.from({ length: 15 }, (_, i) => new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + i).getTime());
    const w0 = days[0], w1 = days[14], span = w1 - w0;
    const pct = (ms) => ((Math.min(Math.max(ms, w0), w1) - w0) / span) * 100;
    const head = days.slice(0, 14).map((d) => `<span>${new Date(d).toLocaleDateString('de-AT', { weekday: 'short' })}<br>${new Date(d).getDate()}.${new Date(d).getMonth() + 1}.</span>`).join('');
    const nowLine = n >= w0 && n <= w1 ? `<div class="nowline" style="left:${pct(n)}%" title="Jetzt"></div>` : '';
    let rows = '';
    for (let s = 1; s <= D.SPOT_COUNT; s++) {
      let segs = '';
      for (const b of S.bookings.filter((x) => x.spotId === s && D.isActive(x))) {
        const e = D.effectiveEnd(b);
        if (e <= w0 || b.start >= w1) continue;
        const cls = b.kind === 'block' ? 'gesperrt' : b.arrivalConfirmedAt != null ? 'anwesend' : 'reserviert';
        const who = b.kind !== 'block' && canManage(b) ? ` – ${b.name}` : '';
        const title = `${spotName(s)}: ${cls === 'gesperrt' ? 'gesperrt' : 'belegt'} ${fmt(b.start)} bis ${fmt(e)}${who}`;
        segs += `<div class="seg ${cls}" style="left:${pct(b.start)}%;width:${pct(e) - pct(b.start)}%" title="${esc(title)}"></div>`;
      }
      for (const b of S.bookings.filter((x) => x.spotId === s && x.cancelledAt == null && x.kind !== 'block' && x.releasedAt == null && x.arrivalConfirmedAt != null && x.plannedEnd <= n)) {
        if (n <= w0 || b.plannedEnd >= w1) continue;
        segs += `<div class="seg ungeklaert" style="left:${pct(b.plannedEnd)}%;width:${pct(n) - pct(b.plannedEnd)}%" title="${esc(`${spotName(s)}: Belegung ungeklärt seit ${fmt(b.plannedEnd)}`)}"></div>`;
      }
      rows += `<div class="tl-row"><div class="tl-label"><a href="#/platz/${s}" style="color:inherit;text-decoration:none">${esc(spotName(s))}</a></div><div class="tl-track">${segs}${nowLine}</div></div>`;
    }
    return `<div class="tl-wrap"><div class="tl"><div class="tl-row tl-head"><div></div><div class="tl-track">${head}</div></div>${rows}</div></div>
      <div class="legend"><span><i style="background:var(--frei-bg);border:1px solid var(--line)"></i>frei</span><span><i style="background:var(--reserviert)"></i>reserviert (Ankunft offen)</span><span><i style="background:var(--anwesend)"></i>Anwesenheit bestätigt</span><span><i style="background:var(--gesperrt)"></i>gesperrt</span><span><i style="background:repeating-linear-gradient(45deg,var(--ungeklaert) 0 4px,transparent 4px 8px)"></i>ungeklärt</span><span>│ jetzt</span></div>`;
  }

  // ---------- Seiten ----------
  function accessHint() {
    if (S.who === 'gast') return `<p class="hint">Öffentlich sichtbar ist nur die Verfügbarkeit. Zum Reservieren bitte <a href="#" data-action="tab" data-tab="register">registrieren</a>; der Betreiber (Erwin Schuster) gibt neue Benutzer frei. Jahreskarten-Besitzer erhalten ihren Zugang vom Betreiber. (Demo: Anmeldung oben rechts wählen.)</p>`;
    if (pending()) return user().status === 'abgelaufen'
      ? `<p class="warn">Dein Zugang war nur für die Saison ${season() - 1} freigegeben. Für ${season()} muss Erwin Schuster ihn erneut freigeben; bis dahin ist Reservieren nicht möglich.</p>`
      : `<p class="warn">Dein Zugang ist „${USER_STATUS[user().status]}“. Reservieren ist erst nach der Freigabe durch Erwin Schuster möglich.</p>`;
    return '';
  }

  function pageRegister() {
    return `<h2>Registrieren</h2>
      <p class="muted small">Für Jahreskarten-Besitzer legt der Betreiber den Zugang an – hier nur für alle anderen. Nach der Registrierung erhält Erwin Schuster eine E-Mail und gibt den Zugang frei, erst dann kann reserviert werden. Die Freigabe gilt für die laufende Saison und läuft mit dem Jahreswechsel automatisch ab.</p>
      <form data-form="register" style="display:flex;flex-direction:column;gap:10px;max-width:380px">
        <label class="f">Vor- und Nachname<input name="name" required></label>
        <label class="f">E-Mail<input name="email" type="email" required></label>
        <label class="f">Telefon (optional)<input name="phone"></label>
        <label class="small" style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" name="consent" required style="margin-top:4px"><span>Ich bin damit einverstanden, dass meine Daten (Name, E-Mail, Telefon, Buchungen) zur Platzreservierung gespeichert werden. <span class="muted">[Datenschutztext des Betreibers – ausstehend]</span></span></label>
        <p class="small muted">Demo: kein Passwort. In der echten Version Anmeldung per E-Mail-Link oder Passwort.</p>
        <button class="btn">Registrieren</button>
      </form>`;
  }

  // Ab 1. Dezember: Liste der Zugänge, die zum Jahreswechsel ablaufen
  function expiringBox() {
    if (new Date(now()).getMonth() < 11) return '';
    const l = S.users.filter((u) => effStatus(u) === 'aktiv');
    return `<h3>Laufen zum Jahreswechsel ab (${l.length})</h3>` + (l.length ? `<p class="small muted">Diese Zugänge enden am 31.12. – für ${season() + 1} neu freigeben.</p><ul class="plain">${l.map((u) => `<li>${esc(u.name)} · ${USER_TYPE[u.type]}</li>`).join('')}</ul>` : '<p class="muted">Keine.</p>');
  }

  function pageUsers() {
    const r = rules();
    const row = (u) => {
      const st = effStatus(u); const stats = userStats(u);
      const btn = (status, label, cls) => `<button class="btn sm ${cls || ''}" data-action="user-set" data-user="${u.id}" data-status="${status}">${label}</button>`;
      const acts = st === 'wartet' ? btn('aktiv', `Freigeben (Saison ${season()})`) + ' ' + btn('abgelehnt', 'Ablehnen', 'danger')
        : st === 'aktiv' ? btn('gesperrt', 'Sperren', 'sec')
        : btn('aktiv', `Freigeben für Saison ${season()}`, st === 'abgelaufen' ? '' : 'sec');
      const flagged = r.warn && stats.noShows + stats.late >= r.warn;
      const marks = stats.noShows || stats.late ? `<span class="${flagged ? 'badge ungeklaert' : 'muted small'}">Nicht angetreten: ${stats.noShows} · Spätes Storno: ${stats.late}</span>` : '<span class="muted small">–</span>';
      return `<tr><td>${esc(u.name)}<br><span class="muted small">${esc(u.email)}${u.phone ? ' · ' + esc(u.phone) : ''}</span></td><td>${USER_TYPE[u.type]}</td><td>${USER_STATUS[st]}${st === 'aktiv' || st === 'abgelaufen' ? `<br><span class="muted small">Saison ${u.season}</span>` : ''}</td><td>${marks}</td><td>${acts}</td></tr>`;
    };
    const tbl = (l) => l.length ? `<div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Art</th><th>Status</th><th>Vermerke</th><th></th></tr></thead><tbody>${l.map(row).join('')}</tbody></table></div>` : '<p class="muted">Keine.</p>';
    const w = S.users.filter((u) => u.status === 'wartet');
    return `<h2>Benutzer</h2>
      <h3>Warten auf Freigabe (${w.length})</h3>${tbl(w)}
      ${expiringBox()}
      <h3>Benutzer anlegen (Saison ${season()}, sofort aktiv)</h3>
      <p class="small muted">Für Jahreskarten-Besitzer oder wenn jemand telefonisch anfragt. Direkt mit Reservierung: Betreiber → „Telefonische Buchung“.</p>
      <form data-form="newuser" class="toolbar"><label class="f">Name<input name="name" required></label><label class="f">E-Mail<input name="email" type="email" required></label><label class="f">Telefon<input name="phone"></label><label class="f">Art<select name="utype"><option value="jahreskarte">Jahreskarte</option><option value="registriert">Registriert</option></select></label><button class="btn">Zugang anlegen</button></form>
      <h3>Alle Benutzer</h3>${tbl(S.users.filter((u) => u.status !== 'wartet'))}`;
  }

  function pageRules() {
    const s = S.settings;
    const field = (name, label, val, hint) => `<label class="f">${label}<input type="number" min="0" step="1" name="${name}" value="${val == null ? '' : esc(val)}" placeholder="aus"><span class="small muted">${hint}</span></label>`;
    return `<h2>Regeln & Plätze</h2>
      <p class="hint">Zahlen sind Vorschläge für die Demo, mit Ausnahme von 14 Tagen Vorlauf und 5 Tagen Dauer (Vorgabe). Leer oder 0 schaltet eine Regel aus. Die Regeln gelten für Gäste und Jahreskarten-Benutzer; der Betreiber ist ausgenommen.</p>
      <form data-form="rules" class="grid" style="align-items:start">
        ${field('maxAdvanceDays', 'Vorlauf (Tage)', s.maxAdvanceDays, 'Beginn höchstens so viele Tage im Voraus')}
        ${field('maxDurationDays', 'Maximale Reservierungsdauer (Tage)', s.maxDurationDays, 'Länge einer Reservierung')}
        ${field('maxOpenReservations', 'Offene Reservierungen pro Person', s.maxOpenReservations, 'gleichzeitig; Betreiber ausgenommen')}
        ${field('graceHours', 'Karenzzeit Ankunft (Stunden)', s.graceHours, 'ohne Bestätigung nach Beginn wird der Platz automatisch freigegeben')}
        ${field('maxSpontaneousHours', 'Spontane Belegung höchstens (Stunden)', s.maxSpontaneousHours, 'bei „Jetzt belegen“')}
        ${field('cancelDeadlineHours', 'Stornofrist (Stunden vor Beginn)', s.cancelDeadlineHours, 'später wird das Storno vermerkt (nicht verhindert)')}
        ${field('warnCount', 'Vermerke bis zur Warnung', s.warnCount, 'Nicht angetreten + spätes Storno, Anzeige bei Benutzer')}
        ${field('tageskarteVon', 'Tageskarte ab (Uhr)', s.tageskarteVon, 'Beginn der Fischzeit (laut Homepage 5)')}
        ${field('tageskarteBis', 'Tageskarte bis (Uhr)', s.tageskarteBis, 'Ende der Fischzeit (laut Homepage 22)')}
        ${field('reminderHours', 'Erinnerung vor Beginn (Stunden)', s.reminderHours, 'E-Mail an den Benutzer')}
        <label class="f">Feste Wechselzeit<select name="changeoverHour"><option value="">aus (freie Uhrzeiten)</option>${Array.from({ length: 24 }, (_, h) => `<option value="${h}"${s.changeoverHour !== null && s.changeoverHour !== '' && Number(s.changeoverHour) === h && s.changeoverHour !== undefined ? ' selected' : ''}>${pad(h)}:00 Uhr</option>`).join('')}</select><span class="small muted">Beginn und Ende nur zu dieser Uhrzeit</span></label>
        <label class="f">E-Mail von Erwin Schuster<input type="email" name="operatorEmail" value="${esc(s.operatorEmail)}"><span class="small muted">Platzhalter – echte Adresse eintragen</span></label>
        <div><button class="btn">Regeln speichern</button></div>
      </form>
      <h3>Plätze: Name und Hinweis</h3>
      <form data-form="spots"><div class="tbl-wrap"><table><thead><tr><th>#</th><th>Name</th><th>Hinweis (öffentlich sichtbar)</th></tr></thead><tbody>${S.spots.map((p) => `<tr><td>${p.id}</td><td><input name="name${p.id}" value="${esc(p.name)}" required></td><td><input name="note${p.id}" value="${esc(p.note)}" style="width:100%" placeholder="z. B. Lage, Zugang"></td></tr>`).join('')}</tbody></table></div>
        <p class="small muted">Fotos der Plätze folgen mit der Datenbank (Schritt 2).</p><button class="btn" style="margin-top:8px">Plätze speichern</button></form>`;
  }

  function pageMail() {
    return `<h2>Postfach (Demo)</h2>
      <p class="hint">In der Demo werden E-Mails nur hier angezeigt, nicht versendet. Im Echtbetrieb versendet der Server sie (Schritt 2/3). Adresse von Erwin Schuster: ${esc(S.settings.operatorEmail)}.</p>
      ${S.mails.length ? S.mails.slice(0, 40).map((m) => `<div class="card" style="margin-bottom:8px;border-left-color:var(--brand)"><div class="small muted">${fmt(m.t)} · an ${esc(m.to)}</div><b>${esc(m.subject)}</b><div style="white-space:pre-wrap">${esc(m.body)}</div></div>`).join('') : '<p class="muted">Noch keine E-Mails.</p>'}`;
  }

  function pageOverview() {
    const n = now();
    const t = ui.viewT == null ? n : ui.viewT;
    const live = ui.viewT == null;
    let h = `<h2>Verfügbarkeit</h2>
      <div class="toolbar">
        <label class="f">Anzeigen für<input type="datetime-local" value="${inputVal(t)}" data-change="viewT"></label>
        <button class="btn sec" data-action="now"${live ? ' disabled' : ''}>Jetzt</button>
        <span class="muted small">${live ? `Stand: jetzt (${fmt(n)})` : 'Zukunftsansicht – Aktionen nur für „jetzt“.'}</span>
      </div>`;
    h += accessHint();
    h += `<div class="grid">${Array.from({ length: D.SPOT_COUNT }, (_, i) => spotCard(i + 1, t, live)).join('')}</div>`;
    h += `<h3>Die nächsten 14 Tage</h3>${timeline(t)}`;
    return h;
  }

  function pageReserve() {
    const n = now(); const r = rules();
    if (ui.from == null) { ui.from = ceilHour(n); ui.to = ui.from + DAY; }
    const valid = ui.to > ui.from;
    let h = `<h2>Zeitraum prüfen und reservieren</h2>
      <div class="toolbar">
        <label class="f">Beginn<input type="datetime-local" value="${inputVal(ui.from)}" data-change="from"></label>
        <label class="f">Ende<input type="datetime-local" value="${inputVal(ui.to)}" data-change="to"></label>
      </div>`;
    if (!valid) return h + `<p class="warn">Das Ende muss nach dem Beginn liegen.</p>`;
    h += accessHint();
    h += `<p class="muted small">Kartenarten: Tageskarte ${pad(cardCfg().tagVon)}–${pad(cardCfg().tagBis)} Uhr · 24-Stunden-Karte · Jahreskarte (jederzeit). Die Kartenart wählst du beim Reservieren.</p>`;
    let tooFar = false, tooLong = false;
    if (!isOp()) {
      const parts = [];
      if (r.advMs) parts.push(`höchstens ${r.advDays} Tage im Voraus (Beginn bis ${fmt(n + r.advMs)})`);
      if (r.durMs) parts.push(`für höchstens ${r.durDays} Tage am Stück`);
      if (r.maxOpen) parts.push(`höchstens ${r.maxOpen} offene Reservierungen gleichzeitig`);
      if (r.hour != null) parts.push(`Beginn und Ende nur um ${pad(r.hour)}:00 Uhr`);
      if (parts.length) h += `<p class="muted small">Reservieren ist möglich: ${parts.join('; ')}.</p>`;
      tooFar = !!r.advMs && ui.from > n + r.advMs;
      tooLong = !!r.durMs && ui.to - ui.from > r.durMs;
      if (tooFar) h += `<p class="warn">Der Beginn liegt mehr als ${r.advDays} Tage in der Zukunft – dafür kann noch nicht reserviert werden.</p>`;
      if (tooLong) h += `<p class="warn">Eine Reservierung darf höchstens ${r.durDays} Tage dauern.</p>`;
    }
    const av = D.availabilityForPeriod(S.bookings, ui.from, ui.to, n);
    h += `<div class="grid">${av.map((a) => {
      const detail = a.free
        ? 'Im gesamten Zeitraum frei.'
        : 'Nicht frei: ' + a.conflicts.map((c) => `${fmt(c.start)} – ${fmt(D.effectiveEnd(c))}${c.kind === 'block' ? ' (gesperrt)' : ''}`).join('; ');
      const unclear = a.unclear ? `<div class="warn">Belegung zurzeit ungeklärt.</div>` : '';
      return `<article class="card st-${a.free ? 'frei' : 'anwesend'}"><h3><a href="#/platz/${a.spotId}">${esc(spotName(a.spotId))}</a><span class="badge ${a.free ? 'frei' : 'anwesend'}">${a.free ? 'Frei' : 'Belegt'}</span></h3>
        <div class="small">${esc(detail)}</div>${unclear}
        <div class="actions">${a.free && loggedIn() && !tooFar && !tooLong ? `<button class="btn sm" data-action="reserve" data-spot="${a.spotId}" data-from="${ui.from}" data-to="${ui.to}">Reservieren</button>` : ''}</div></article>`;
    }).join('')}</div>`;
    return h;
  }

  function statusText(b, n) {
    const e = D.effectiveEnd(b);
    if (b.cancelledAt != null) return b.lateCancel ? 'Storniert (kurzfristig)' : 'Storniert';
    if (b.kind === 'block') return n < b.start ? 'Sperre geplant' : n < e ? 'Sperre aktiv' : 'Sperre beendet';
    if (b.noShow) return `Nicht angetreten – automatisch freigegeben (${fmt(b.releasedAt)})`;
    if (b.releasedAt != null) return `Freigegeben (${fmt(b.releasedAt)})`;
    if (n < b.start) return 'Geplant';
    if (n < e) return b.arrivalConfirmedAt != null ? 'Anwesend (bestätigt)' : 'Läuft – Ankunft nicht bestätigt';
    return b.arrivalConfirmedAt != null ? 'Ungeklärt – Ende überschritten' : 'Beendet (Ankunft nie bestätigt)';
  }
  function bookingActions(b) {
    const n = now(); const e = D.effectiveEnd(b); const a = [];
    if (b.cancelledAt != null) return '';
    if (b.kind !== 'block' && b.releasedAt == null) {
      if (n < b.start) a.push(`<button class="btn sm sec" data-action="cancel" data-id="${b.id}">Stornieren</button>`);
      else {
        if (b.arrivalConfirmedAt == null && n < e) a.push(`<button class="btn sm" data-action="arrive" data-id="${b.id}">Ankunft bestätigen</button>`);
        if (n < e) a.push(`<button class="btn sm sec" data-action="extend" data-id="${b.id}">Verlängern</button>`);
        if (n < e || b.arrivalConfirmedAt != null) a.push(`<button class="btn sm sec" data-action="release" data-id="${b.id}">${n >= e ? 'Platz ist geräumt' : 'Platz freigeben'}</button>`);
      }
    }
    if (b.kind === 'block' && n < e) a.push(`<button class="btn sm sec" data-action="${n < b.start ? 'cancel' : 'release'}" data-id="${b.id}">Sperre aufheben</button>`);
    if (isOp()) a.push(`<button class="btn sm sec" data-action="edit" data-id="${b.id}">Korrigieren</button>`);
    return a.join(' ');
  }
  function bookingRows(list, withOwner) {
    const n = now();
    if (!list.length) return '<p class="muted">Keine Einträge.</p>';
    return `<div class="tbl-wrap"><table><thead><tr><th>Platz</th><th>Zeitraum</th>${withOwner ? '<th>Name</th>' : ''}<th>Status</th><th></th></tr></thead><tbody>${list.map((b) =>
      `<tr><td>${esc(spotName(b.spotId))}</td><td>${fmt(b.start)}<br>– ${fmt(b.plannedEnd)}${b.card ? `<br><span class="muted small">${CARD[b.card]}</span>` : ''}</td>${withOwner ? `<td>${esc(b.kind === 'block' ? 'Sperre: ' + b.note : b.name)}${b.contact ? `<br><span class="muted">${esc(b.contact)}</span>` : ''}<br><span class="muted small">${b.kind === 'spontaneous' ? 'spontan' : b.kind === 'reservation' ? (b.createdBy === 'betreiber' ? 'telefonisch' : 'online') : ''}</span></td>` : ''}<td>${statusText(b, n)}</td><td>${bookingActions(b)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function pageMine() {
    const n = now();
    const mine = S.bookings.filter((b) => b.ownerId === uid() && b.cancelledAt == null).sort((a, b) => b.start - a.start);
    const cur = mine.filter((b) => b.releasedAt == null && (D.effectiveEnd(b) > n || b.arrivalConfirmedAt != null));
    const past = mine.filter((b) => !cur.includes(b));
    const r = rules();
    const open = r.maxOpen ? `<p class="muted small">Offene Reservierungen: ${D.countOpen(S.bookings, uid(), n)} von ${r.maxOpen}.${r.lateH ? ` Storno bis ${r.lateH} Stunden vor Beginn ohne Vermerk.` : ''}</p>` : '';
    return `<h2>Meine Buchungen</h2>${open}${bookingRows(cur, false)}<h3>Vergangene</h3>${bookingRows(past, false)}`;
  }

  function pageOperator() {
    const n = now();
    const unclear = S.bookings.filter((b) => b.kind !== 'block' && b.cancelledAt == null && b.releasedAt == null && b.arrivalConfirmedAt != null && b.plannedEnd <= n);
    const list = S.bookings.filter((b) => b.cancelledAt == null && (D.effectiveEnd(b) > n - 3 * DAY)).sort((a, b) => a.start - b.start);
    return `<h2>Betreiberbereich</h2>
      <div class="toolbar">
        <button class="btn" data-action="op-new">Telefonische Buchung</button>
        <button class="btn sec" data-action="op-block">Platz sperren</button>
      </div>
      <h3>Ungeklärte Belegungen (${unclear.length})</h3>
      ${unclear.length ? bookingRows(unclear, true) : '<p class="muted">Keine – alle beendeten Belegungen sind geklärt.</p>'}
      <h3>Buchungen und Sperren (laufend, kommend, letzte 3 Tage)</h3>${bookingRows(list, true)}
      <h3>Änderungsprotokoll (Demo)</h3>
      ${S.log.length ? `<ul class="plain">${S.log.slice(0, 15).map((l) => `<li><span class="muted">${fmt(l.t)}</span> · ${esc(l.who)}: ${esc(l.text)}</li>`).join('')}</ul>` : '<p class="muted">Noch keine Änderungen.</p>'}`;
  }

  function qrSvg(text) {
    try {
      const q = window.qrcode(0, 'M'); q.addData(text); q.make();
      return q.createSvgTag(4, 2).replace(/<svg([^>]*?)\s(?:width|height)="[^"]*"/g, '<svg$1').replace(/<svg([^>]*?)\s(?:width|height)="[^"]*"/g, '<svg$1');
    } catch (e) { return '<p class="small">QR-Code nicht verfügbar</p>'; }
  }
  function pageQr() {
    if (ui.qrBase == null) ui.qrBase = location.href.split('#')[0];
    return `<h2>QR-Codes für die Plätze</h2>
      <p class="muted small no-print">Jeder Code führt auf die Seite des Platzes. In der Demo ist die Basis-Adresse diese lokale Seite – bei der Einbindung in die Homepage wird hier die echte Adresse eingetragen. Zum Drucken: Strg+P.</p>
      <div class="toolbar no-print"><label class="f" style="flex:1;min-width:260px">Basis-Adresse<input type="text" value="${esc(ui.qrBase)}" data-change="qrBase"></label><button class="btn sec" data-action="print">Drucken</button></div>
      <div class="qr-grid">${Array.from({ length: D.SPOT_COUNT }, (_, i) => {
        const link = `${ui.qrBase}#/platz/${i + 1}`;
        return `<div class="qr"><b>${esc(spotName(i + 1))}</b>${qrSvg(link)}<code>${esc(link)}</code></div>`;
      }).join('')}</div>`;
  }

  function pageSpot(n0) {
    const n = now();
    const upcoming = S.bookings.filter((b) => b.spotId === n0 && D.isActive(b) && D.effectiveEnd(b) > n).sort((a, b) => a.start - b.start);
    return `<p><a href="#/">← Zur Übersicht</a></p><h2>${esc(spotName(n0))}</h2>
      <div style="max-width:420px">${spotCard(n0, n, true)}</div>
      <h3>Belegte Zeiten</h3>
      ${upcoming.length ? `<ul class="plain">${upcoming.map((b) => `<li>${fmt(b.start)} – ${fmt(D.effectiveEnd(b))} · ${b.kind === 'block' ? 'gesperrt' : 'belegt'}${b.kind !== 'block' && canManage(b) ? ` · ${esc(b.name)}` : ''}</li>`).join('')}</ul>` : '<p class="muted">Keine Belegungen oder Reservierungen eingetragen.</p>'}`;
  }

  // ---------- Dialoge ----------
  function openDialog(d) { ui.dlg = d; renderDialog(); const el = $('#dlg'); if (!el.open) el.showModal(); }
  function closeDialog() { ui.dlg = null; const el = $('#dlg'); if (el.open) el.close(); }
  function captureDlg() {
    const form = $('#dlg form'); if (!form || !ui.dlg) return;
    const f = new FormData(form);
    for (const [k, v] of f.entries()) {
      if (k === 'spot') ui.dlg.spotId = Number(v);
      else if (k === 'start' || k === 'end') { const t = parseVal(v); if (Number.isFinite(t)) ui.dlg[k] = t; }
      else if (k !== 'who') ui.dlg[k] = v;
    }
  }
  function renderDialog() {
    const d = ui.dlg; if (!d) return;
    const n = now();
    const titles = { reservation: isOp() ? 'Telefonische Buchung' : 'Reservieren', block: 'Platz sperren', spontaneous: 'Platz jetzt belegen', edit: 'Buchung korrigieren', extend: 'Belegung verlängern' };
    const spotSel = `<label class="f">Platz<select name="spot"${d.kind === 'spontaneous' ? ' disabled' : ''}>${Array.from({ length: D.SPOT_COUNT }, (_, i) => `<option value="${i + 1}"${i + 1 === d.spotId ? ' selected' : ''}>${esc(spotName(i + 1))}</option>`).join('')}</select></label>`;
    let body = '';
    if (d.kind === 'extend') {
      const b = S.bookings.find((x) => x.id === d.id);
      const maxEnd = D.findConflicts(S.bookings, b.spotId, b.plannedEnd, b.plannedEnd + 400 * DAY, b.id).map((c) => c.start).sort((x, y) => x - y)[0];
      body = `<div class="small">${esc(spotName(b.spotId))}, bisheriges Ende: <b>${fmt(b.plannedEnd)}</b></div>
        <label class="f">Neues Ende<input type="datetime-local" name="end" required value="${inputVal(d.end)}" min="${inputVal(b.plannedEnd)}"${maxEnd ? ` max="${inputVal(maxEnd)}"` : ''}></label>
        <div class="${maxEnd ? 'hint' : 'small muted'}">${maxEnd ? `Der Platz ist ab ${fmt(maxEnd)} reserviert – spätestens bis dahin möglich.` : 'Keine spätere Reservierung eingetragen.'}</div>`;
    } else {
      body = spotSel + cardField(d);
      if (d.kind === 'spontaneous') {
        const m = D.maxSpontaneousEnd(S.bookings, d.spotId, n); const r = rules();
        body += `<div class="small">Beginn: <b>jetzt</b> (${fmt(n)})</div>
          <label class="f">Geplantes Ende<input type="datetime-local" name="end" required value="${inputVal(d.end)}" min="${inputVal(n)}"${m.maxEnd ? ` max="${inputVal(m.maxEnd)}"` : ''}></label>
          <div class="${m.maxEnd ? 'hint' : 'small muted'}">${m.maxEnd ? `Der Platz ist ab ${fmt(m.maxEnd)} reserviert – spätestens bis dahin möglich.` : 'Keine spätere Reservierung eingetragen.'}${!isOp() && r.spontH ? ` Höchstens ${r.spontH} Stunden.` : ''}</div>`;
      } else {
        body += `<label class="f">Beginn<input type="datetime-local" name="start" required value="${inputVal(d.start)}"></label>
          <label class="f">Ende<input type="datetime-local" name="end" required value="${inputVal(d.end)}"></label>`;
      }
      if (d.kind === 'block') body += `<label class="f">Grund (nur Betreiber sichtbar)<textarea name="note" rows="2">${esc(d.note || '')}</textarea></label>`;
      else if (d.kind === 'reservation' && isOp()) {
        const who = d.who || '__new';
        body += `<label class="f">Für wen<select name="who" data-change="dlgWho"><option value="__new"${who === '__new' ? ' selected' : ''}>Neuen Benutzer anlegen</option>${S.users.map((u) => { const st = effStatus(u); return `<option value="${u.id}"${who === u.id ? ' selected' : ''}>${esc(u.name)} (${USER_TYPE[u.type]}${st === 'aktiv' ? '' : ', ' + USER_STATUS[st]})</option>`; }).join('')}<option value="__none"${who === '__none' ? ' selected' : ''}>Ohne Benutzerkonto (nur Name)</option></select></label>`;
        if (who === '__new') body += `<label class="f">Name<input name="name" required value="${esc(d.name || '')}"></label>
          <label class="f">E-Mail (für Bestätigung)<input name="email" type="email" required value="${esc(d.email || '')}"></label>
          <label class="f">Telefon<input name="phone" value="${esc(d.phone || '')}"></label>
          <label class="f">Art<select name="utype"><option value="registriert"${d.utype === 'jahreskarte' ? '' : ' selected'}>Registriert</option><option value="jahreskarte"${d.utype === 'jahreskarte' ? ' selected' : ''}>Jahreskarte</option></select></label>
          <div class="hint">Der Zugang wird sofort für die Saison ${season()} freigegeben; die Bestätigung geht per E-Mail an den Gast.</div>`;
        else if (who === '__none') body += `<label class="f">Name<input name="name" required value="${esc(d.name || '')}"></label><label class="f">Telefon / E-Mail<input name="contact" value="${esc(d.contact || '')}"></label>`;
        else { const u = userById(who); const st = u ? effStatus(u) : 'aktiv'; body += `<div class="small muted">${esc(u ? u.email : '')}</div>${st !== 'aktiv' ? `<div class="warn">Zugang: ${USER_STATUS[st]} – der Betreiber darf trotzdem buchen; bitte ggf. unter „Benutzer“ freigeben.</div>` : ''}`; }
        body += `<label class="f">Notiz<input name="note" value="${esc(d.note || '')}"></label>`;
      } else if (d.kind === 'edit' || (d.kind === 'spontaneous' && isOp())) body += `<label class="f">Name<input name="name" required value="${esc(d.name || '')}"></label>
          <label class="f">Telefon / E-Mail<input name="contact" value="${esc(d.contact || '')}"></label>
          <label class="f">Notiz<input name="note" value="${esc(d.note || '')}"></label>`;
      else body += `<div class="small">Auf den Namen: <b>${esc(user().name)}</b></div>`;
    }
    $('#dlg').innerHTML = `<form method="dialog" data-form="1"><h2>${titles[d.kind]}</h2>${body}
      ${d.error ? `<div class="msg err" role="alert">${esc(d.error)}</div>` : ''}
      <div class="row-btns"><button type="button" class="btn sec" data-action="close">Abbrechen</button><button class="btn">${{ edit: 'Speichern', block: 'Sperren', spontaneous: 'Platz belegen', extend: 'Verlängern' }[d.kind] || 'Verbindlich reservieren'}</button></div></form>`;
  }

  function submitDialog(form) {
    const d = ui.dlg; if (!d) return;
    const f = new FormData(form); const n = now(); const r0 = rules();
    const str = (k) => String(f.get(k) || '').trim();

    if (d.kind === 'extend') {
      const b = S.bookings.find((x) => x.id === d.id);
      const end = parseVal(f.get('end'));
      const lim = isOp() ? {} : { cardCfg: cardCfg(), maxDurationMs: b.kind === 'spontaneous' ? r0.spontMs : r0.durMs, maxDurationText: b.kind === 'spontaneous' ? `${r0.spontH} Stunden` : `${r0.durDays} Tage` };
      const r = D.extend(S.bookings, d.id, end, n, lim);
      if (!r.ok) { d.error = r.error; renderDialog(); return; }
      closeDialog(); apply(r, `Verlängert bis ${fmt(end)}.`, `Verlängerung Buchung #${d.id} bis ${fmt(end)}`); return;
    }

    const spotId = d.kind === 'spontaneous' ? d.spotId : Number(f.get('spot'));
    const start = d.kind === 'spontaneous' ? n : parseVal(f.get('start'));
    const end = parseVal(f.get('end'));
    const note = str('note');
    const card = isOp() ? (str('card') || 'tageskarte') : isJK() ? 'jahreskarte' : (str('card') || 'tageskarte');
    let name, contact = str('contact'), owner = null, newUser = null;

    if (d.kind === 'reservation' && isOp()) {
      const w = str('who') || '__new';
      if (w === '__new') {
        name = str('name'); const email = str('email');
        if (S.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) { d.error = 'Diese E-Mail-Adresse gibt es schon – bitte den vorhandenen Benutzer wählen.'; captureDlg(); renderDialog(); return; }
        newUser = { id: newUserId(), name, email, phone: str('phone'), type: str('utype') === 'jahreskarte' ? 'jahreskarte' : 'registriert', status: 'aktiv', season: season(), createdAt: n, consentAt: null, createdBy: 'betreiber' };
        owner = newUser.id; contact = email;
      } else if (w === '__none') { name = str('name'); }
      else { const u = userById(w); owner = u.id; name = u.name; contact = u.email; }
    } else if (isOp()) name = str('name');
    else { name = user().name; owner = uid(); }

    let r, ok, logText;
    if (d.kind === 'reservation') {
      r = D.createBooking(S.bookings, { spotId, kind: 'reservation', card, start, end, ownerId: owner, name, contact, note, createdBy: isOp() ? 'betreiber' : S.who }, n, isOp() ? { allowPast: true } : guestOpts());
      ok = `${spotName(spotId)} reserviert: ${fmt(start)} – ${fmt(end)}.`;
      logText = `Reservierung ${spotName(spotId)} ${fmt(start)}–${fmt(end)} (${name})`;
    } else if (d.kind === 'block') {
      r = D.createBooking(S.bookings, { spotId, kind: 'block', start, end, name: 'Sperre', note, createdBy: 'betreiber' }, n, { allowPast: true });
      ok = `${spotName(spotId)} gesperrt: ${fmt(start)} – ${fmt(end)}.`;
      logText = `Sperre ${spotName(spotId)} ${fmt(start)}–${fmt(end)}`;
    } else if (d.kind === 'spontaneous') {
      r = D.occupyNow(S.bookings, { spotId, plannedEnd: end, card, ownerId: owner, name, contact, createdBy: S.who }, n, isOp() ? {} : { maxDurationMs: r0.spontMs, cardCfg: cardCfg() });
      ok = `${spotName(spotId)} ist jetzt bis ${fmt(end)} belegt. Viel Erfolg!`;
      logText = `Spontane Belegung ${spotName(spotId)} bis ${fmt(end)} (${name})`;
    } else {
      r = D.updateBooking(S.bookings, d.id, { spotId, start, plannedEnd: end, name, contact, note, card }, n);
      ok = 'Buchung korrigiert.';
      logText = `Korrektur Buchung #${d.id}: ${spotName(spotId)} ${fmt(start)}–${fmt(end)}`;
    }
    if (!r.ok) { d.error = r.error; if (d.kind === 'reservation' && isOp()) captureDlg(); renderDialog(); return; }
    closeDialog();
    if (d.kind === 'reservation') {
      let target = owner ? (newUser || userById(owner)) : null;
      if (newUser) {
        S.users.push(newUser);
        logEntry(`Benutzer angelegt: ${newUser.name} (${USER_TYPE[newUser.type]})`);
        mailUser(newUser, 'Dein Zugang zur Platzreservierung', `Hallo ${newUser.name},\nErwin Schuster hat für dich einen Zugang für die Saison ${season()} angelegt.`);
      }
      mailUser(target, 'Reservierung bestätigt', `${spotName(spotId)} (${CARD[card]}): ${fmt(start)} – ${fmt(end)}. Bitte nach der Ankunft die Anwesenheit bestätigen.`);
    }
    apply(r, ok, logText);
  }

  // ---------- Render ----------
  function render() {
    housekeeping();
    renderWho(); renderTabs();
    const spot = ui.spotPage;
    let page;
    if (spot) page = pageSpot(spot);
    else page = { overview: pageOverview, reserve: pageReserve, mine: pageMine, operator: pageOperator, qr: pageQr, register: pageRegister, users: pageUsers, rules: pageRules, mail: pageMail }[ui.tab]();
    const toastHtml = ui.msg ? `<div id="toast"><div class="msg ${ui.msg.type}" role="status">${esc(ui.msg.text)}</div></div>` : '';
    $('#main').innerHTML = toastHtml + page;
    renderTools();
  }
  function renderTools() {
    $('#demoTools').innerHTML = `<summary>Demo-Steuerung (Uhr vorstellen, Daten zurücksetzen)</summary>
      <p class="small muted">Demo-Uhr: <b>${fmt(now())}</b>${S.clockOffset ? ' (vorgestellt)' : ' (echte Zeit)'} – damit lassen sich z. B. „Ende überschritten“, „ungeklärt“, Karenzzeit und Erinnerungen vorführen.</p>
      <div class="toolbar"><button class="btn sec sm" data-action="clock" data-delta="${H}">+1 Stunde</button><button class="btn sec sm" data-action="clock" data-delta="${6 * H}">+6 Stunden</button><button class="btn sec sm" data-action="clock" data-delta="${DAY}">+1 Tag</button><button class="btn sec sm" data-action="clock" data-delta="0">Echte Zeit</button><button class="btn danger sm" data-action="reset">Beispieldaten zurücksetzen</button></div>`;
  }

  // ---------- Ereignisse ----------
  function setUserStatus(u, status) {
    u.status = status;
    if (status === 'aktiv') u.season = season();
    logEntry(`Benutzer ${u.name}: ${USER_STATUS[status]}`);
    const text = { aktiv: `Dein Zugang wurde für die Saison ${season()} freigegeben. Du kannst jetzt reservieren.`, abgelehnt: 'Dein Zugang wurde nicht freigegeben. Bei Fragen bitte Erwin Schuster kontaktieren.', gesperrt: 'Dein Zugang wurde gesperrt. Bitte Erwin Schuster kontaktieren.' }[status];
    if (text) mailUser(u, 'Dein Zugang zur Platzreservierung', `Hallo ${u.name},\n${text}`);
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]'); if (!el) return;
    const a = el.dataset.action; const n = now();
    const id = Number(el.dataset.id);
    ui.msg = null;
    if (a === 'tab') e.preventDefault();
    switch (a) {
      case 'tab': ui.tab = el.dataset.tab; ui.spotPage = null; if (location.hash) history.replaceState(null, '', location.pathname + location.search); render(); break;
      case 'now': ui.viewT = null; render(); break;
      case 'close': closeDialog(); break;
      case 'print': window.print(); break;
      case 'clock': S.clockOffset = el.dataset.delta === '0' ? 0 : S.clockOffset + Number(el.dataset.delta); save(); render(); break;
      case 'user-set': {
        const u = userById(el.dataset.user);
        if (u) { setUserStatus(u, el.dataset.status); save(); toast('ok', `${u.name}: ${USER_STATUS[u.status]}. E-Mail an den Benutzer gesendet (Demo-Postfach).`); }
        render(); break;
      }
      case 'reset': S = window.Store.seed(); ui.from = null; save(); toast('ok', 'Beispieldaten wurden zurückgesetzt.'); render(); break;
      case 'reserve': {
        const spotId = Number(el.dataset.spot);
        const from = el.dataset.from ? Number(el.dataset.from) : ceilHour(n);
        const to = el.dataset.to ? Number(el.dataset.to) : from + DAY;
        openDialog(snapCard({ kind: 'reservation', spotId, start: from, end: to, card: isJK() ? 'jahreskarte' : 'tageskarte' })); break;
      }
      case 'occupy': {
        const spotId = Number(el.dataset.spot);
        const m = D.maxSpontaneousEnd(S.bookings, spotId, n);
        const def = m.maxEnd ? Math.min(m.maxEnd, n + 4 * H) : n + 4 * H;
        openDialog(snapCard({ kind: 'spontaneous', spotId, end: def, card: isJK() ? 'jahreskarte' : 'tageskarte' })); break;
      }
      case 'extend': {
        const b = S.bookings.find((x) => x.id === id);
        const maxEnd = D.findConflicts(S.bookings, b.spotId, b.plannedEnd, b.plannedEnd + 400 * DAY, b.id).map((c) => c.start).sort((x, y) => x - y)[0];
        openDialog({ kind: 'extend', id, end: maxEnd ? Math.min(maxEnd, b.plannedEnd + DAY) : b.plannedEnd + DAY }); break;
      }
      case 'op-new': openDialog({ kind: 'reservation', spotId: 1, start: ceilHour(n), end: ceilHour(n) + DAY, who: '__new' }); break;
      case 'op-block': openDialog({ kind: 'block', spotId: 1, start: ceilHour(n), end: ceilHour(n) + DAY }); break;
      case 'edit': { const b = S.bookings.find((x) => x.id === id); openDialog({ kind: 'edit', id, card: b.card || 'tageskarte', spotId: b.spotId, start: b.start, end: b.plannedEnd, name: b.name, contact: b.contact, note: b.note }); break; }
      case 'arrive': apply(D.confirmArrival(S.bookings, id, n), 'Ankunft bestätigt.', `Ankunft bestätigt (Buchung #${id})`); break;
      case 'release': {
        const b = S.bookings.find((x) => x.id === id);
        const wasOver = b && b.arrivalConfirmedAt != null && b.plannedEnd <= n;
        const r = D.release(S.bookings, id, n, S.who, isOp() ? {} : { lateMs: rules().lateMs });
        apply(r, wasOver ? 'Platz als geräumt gemeldet – die Belegung ist geklärt.' : r.ok && r.late ? 'Storniert – kurzfristige Stornierung wird vermerkt.' : 'Platz freigegeben.', `${wasOver ? 'Geräumt gemeldet' : 'Freigabe'} (Buchung #${id})`); break;
      }
      case 'cancel': {
        const r = D.cancel(S.bookings, id, n, isOp() ? {} : { lateMs: rules().lateMs });
        apply(r, r.ok && r.late ? 'Storniert – kurzfristige Stornierung wird vermerkt.' : 'Storniert.', `Storno (Buchung #${id})`); break;
      }
    }
  });

  document.addEventListener('change', (e) => {
    const k = e.target.dataset.change; if (!k) return;
    const v = e.target.value;
    ui.msg = null;
    if (k === 'dlgWho') {
      captureDlg(); ui.dlg.who = v; ui.dlg.error = null;
      const u = userById(v);
      if (u && u.type === 'jahreskarte') ui.dlg.card = 'jahreskarte'; else if (ui.dlg.card === 'jahreskarte') ui.dlg.card = 'tageskarte';
      renderDialog(); return;
    }
    if (k === 'dlgCard') { captureDlg(); ui.dlg.card = v; ui.dlg.error = null; if (ui.dlg.kind !== 'edit' && !isOp()) snapCard(ui.dlg); renderDialog(); return; }
    if (k === 'who') { S.who = v; save(); }
    else if (k === 'viewT') { const t = parseVal(v); ui.viewT = Number.isFinite(t) ? t : null; }
    else if (k === 'from') { const t = parseVal(v); if (Number.isFinite(t)) { const len = ui.to - ui.from; ui.from = t; if (ui.to <= t) ui.to = t + (len > 0 ? len : DAY); } }
    else if (k === 'to') { const t = parseVal(v); if (Number.isFinite(t)) ui.to = t; }
    else if (k === 'qrBase') ui.qrBase = v.trim();
    render();
  });

  $('#main').addEventListener('submit', (e) => {
    const f = e.target.closest('[data-form]'); if (!f) return;
    e.preventDefault();
    const d = new FormData(f); const str = (k) => String(d.get(k) || '').trim(); const type = f.dataset.form;
    if (type === 'rules') {
      const s = S.settings;
      ['maxAdvanceDays', 'maxDurationDays', 'maxOpenReservations', 'graceHours', 'maxSpontaneousHours', 'cancelDeadlineHours', 'warnCount', 'reminderHours'].forEach((k) => { s[k] = num(str(k)); });
      s.changeoverHour = str('changeoverHour') === '' ? null : Number(str('changeoverHour'));
      s.operatorEmail = str('operatorEmail');
      s.tageskarteVon = num(str('tageskarteVon')) || 5; s.tageskarteBis = num(str('tageskarteBis')) || 22;
      if (s.tageskarteBis > 24 || s.tageskarteVon >= s.tageskarteBis) { s.tageskarteVon = 5; s.tageskarteBis = 22; toast('err', 'Tageskarte: „ab“ muss vor „bis“ liegen (max. 24). Auf 5–22 zurückgesetzt.'); logEntry('Regeln geändert'); save(); render(); return; }
      logEntry('Regeln geändert'); save(); toast('ok', 'Regeln gespeichert.'); render(); return;
    }
    if (type === 'spots') {
      S.spots.forEach((p) => { p.name = str('name' + p.id) || p.name; p.note = str('note' + p.id); });
      logEntry('Plätze geändert'); save(); toast('ok', 'Plätze gespeichert.'); render(); return;
    }
    const name = str('name'); const email = str('email');
    if (S.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) { toast('err', 'Diese E-Mail-Adresse ist bereits registriert.'); render(); return; }
    if (type === 'register') {
      const u = { id: newUserId(), name, email, phone: str('phone'), type: 'registriert', status: 'wartet', season: season(), createdAt: now(), consentAt: now() };
      S.users.push(u); S.who = u.id; ui.tab = 'overview'; logEntry(`Registrierung ${name}`, name);
      mailOperator('Neue Registrierung wartet auf Freigabe', `${name} (${email}${u.phone ? ', ' + u.phone : ''}) hat sich registriert.\nBitte unter „Benutzer“ freigeben oder ablehnen.`);
      mailUser(u, 'Registrierung eingegangen', `Hallo ${name},\ndeine Registrierung ist eingegangen. Erwin Schuster gibt deinen Zugang frei; du erhältst dann eine E-Mail.`);
      save();
      toast('ok', 'Registriert. Erwin Schuster wurde per E-Mail informiert und muss deinen Zugang noch freigeben.');
    } else {
      const u = { id: newUserId(), name, email, phone: str('phone'), type: str('utype') === 'registriert' ? 'registriert' : 'jahreskarte', status: 'aktiv', season: season(), createdAt: now(), consentAt: null, createdBy: 'betreiber' };
      S.users.push(u);
      logEntry(`Benutzer angelegt: ${name} (${USER_TYPE[u.type]})`);
      mailUser(u, 'Dein Zugang zur Platzreservierung', `Hallo ${name},\nErwin Schuster hat für dich einen Zugang für die Saison ${season()} angelegt.`);
      save(); toast('ok', `Zugang für ${name} angelegt.`);
    }
    render();
  });
  $('#dlg').addEventListener('submit', (e) => { e.preventDefault(); submitDialog(e.target); });
  $('#dlg').addEventListener('close', () => { ui.dlg = null; });

  function route() {
    const m = location.hash.match(/^#\/platz\/(\d+)$/);
    const n = m ? Number(m[1]) : null;
    ui.spotPage = n && n >= 1 && n <= D.SPOT_COUNT ? n : null;
    ui.msg = null;
    render();
  }
  window.addEventListener('hashchange', route);
  setInterval(() => {
    if ($('#dlg').open || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
    render();
  }, 30000);
  route();
})();
