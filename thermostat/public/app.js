// Home Climate — phone UI. Plain JS, no build step.

const S = {
  state: null,
  me: null,
  tab: localGet('tab') || 'home',
  sseOk: false,
  draftTarget: null, // target the person is dialing in, not yet sent
  pending: {}, // field -> value being sent (mode, fan, sensors)
  feedback: null, // { state: 'waiting'|'sending'|'sent'|'confirmed'|'saved'|'failed', ... }
  editor: null,
};

const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet-root');
const $toast = document.getElementById('toast');

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MODES = [
  { id: 'off', label: 'Off', icon: 'power' },
  { id: 'heat', label: 'Heat', icon: 'flame' },
  { id: 'cool', label: 'Cool', icon: 'snow' },
  { id: 'smart', label: 'Smart', icon: 'auto' },
];

const ICONS = {
  power: '<path d="M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0" />',
  flame: '<path d="M12 3c1 4 5 5.5 5 10a5 5 0 0 1-10 0c0-2.5 1.5-3.5 2-5 1 1.5 1.5 2 2.5 2 0-2.5-.5-4.5.5-7Z" />',
  snow: '<path d="M12 2v20M4 6.5l16 11M20 6.5l-16 11M9 4l3 2 3-2M9 20l3-2 3 2" />',
  auto: '<path d="M12 3l1.8 4.6L18.5 9l-4.7 1.5L12 15l-1.8-4.5L5.5 9l4.7-1.4Z" /><path d="M18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9Z" />',
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1Z" />',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" />',
  gear: '<circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-3.9M4 4v4h4M4 13a8 8 0 0 0 14.9 3.9M20 20v-4h-4" />',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

// ---------- small helpers ----------

function localGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function localSet(k, v) {
  try { localStorage.setItem(k, v); } catch { /* private mode */ }
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const isC = () => S.state?.settings.unit === 'C';
const toDisp = (f) => (isC() ? (f - 32) / 1.8 : f);
const fromDisp = (d) => (isC() ? d * 1.8 + 32 : d);
const step = () => (isC() ? 0.5 : 1);
const fmtTemp = (f) => (typeof f === 'number' ? toDisp(f).toFixed(1).replace(/\.0$/, '') : '--');
const fmtTarget = (f) => {
  const d = toDisp(f);
  return isC() ? (Math.round(d * 2) / 2).toFixed(1).replace(/\.0$/, '') : String(Math.round(d));
};
const fmtDelta = (fDelta) => {
  const d = isC() ? fDelta / 1.8 : fDelta;
  return `${(Math.round(d * 10) / 10).toString()}°`;
};

function clockTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function whenLabel(ms) {
  const d = new Date(ms);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return clockTime(ms);
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${clockTime(ms)}`;
  return `${DAYS[d.getDay()]} ${clockTime(ms)}`;
}
function ago(ms) {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return whenLabel(ms);
}
function time12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return clockTime(d.getTime());
}
function daysLabel(days) {
  const k = [...days].sort().join('');
  if (k === '0123456') return 'Every day';
  if (k === '12345') return 'Weekdays';
  if (k === '06') return 'Weekends';
  return days.map((d) => DAYS[d]).join(', ');
}

let toastTimer;
function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 2600);
}

function sensorName(id) {
  return S.state?.sensors.find((s) => s.id === id)?.name || 'Sensor';
}
function modeLabel(m) {
  return MODES.find((x) => x.id === m)?.label || m;
}

// ---------- server calls ----------

async function api(method, path, body, { timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      credentials: 'same-origin',
    });
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'Home server took too long to answer' : 'Can’t reach your home server');
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') {
    S.me = null;
    renderLogin();
    throw new Error('Please sign in');
  }
  if (!res.ok) {
    if (data.state) S.state = data.state;
    throw new Error(data.error || `Error ${res.status}`);
  }
  return data;
}

// Send a change and walk the feedback chip through sending → sent → confirmed.
async function sendChange(changes, label) {
  S.feedback = { state: 'sending', label, changes };
  render();
  try {
    const r = await api('POST', '/api/control', changes);
    S.state = r.state;
    applyResults(r.results, label, changes);
  } catch (err) {
    S.feedback = { state: 'failed', label, changes, error: err.message };
  } finally {
    for (const k of Object.keys(changes)) delete S.pending[k];
    if ('target' in changes) S.draftTarget = null;
    render();
  }
}

function applyResults(results, label, changes) {
  const failed = results.find((c) => c.state === 'failed');
  if (failed) {
    S.feedback = { state: 'failed', label, changes, error: friendlyError(failed.error) };
  } else if (results.length) {
    S.feedback = { state: 'sent', label, ids: results.map((c) => c.id), at: Date.now() };
  } else {
    S.feedback = { state: 'saved', label, at: Date.now() };
    clearFeedbackSoon();
  }
}

function friendlyError(e) {
  if (!e) return 'The thermostat didn’t accept it';
  if (/ENDPOINT_UNREACHABLE/i.test(e)) return 'Thermostat is offline';
  if (/15 s|timed? ?out/i.test(e)) return 'Amazon didn’t answer in time';
  return e;
}

let feedbackTimer;
function clearFeedbackSoon(ms = 3500) {
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => {
    if (S.feedback && ['saved', 'confirmed'].includes(S.feedback.state)) {
      S.feedback = null;
      render();
    }
  }, ms);
}

function checkConfirmed() {
  const f = S.feedback;
  if (f?.state !== 'sent' || !S.state) return;
  const cmds = S.state.commands.filter((c) => f.ids.includes(c.id));
  if (cmds.some((c) => c.state === 'failed')) {
    S.feedback = { state: 'failed', label: f.label, error: friendlyError(cmds.find((c) => c.state === 'failed').error) };
  } else if (cmds.length && cmds.every((c) => c.state === 'confirmed' || c.state === 'superseded')) {
    S.feedback = { state: 'confirmed', label: f.label };
    clearFeedbackSoon();
  }
}

// ---------- live updates ----------

let es;
function connectLive() {
  es?.close();
  es = new EventSource('/api/events');
  es.addEventListener('open', () => {
    S.sseOk = true;
    render();
  });
  es.addEventListener('state', (e) => {
    S.sseOk = true;
    S.state = JSON.parse(e.data);
    checkConfirmed();
    render();
  });
  es.addEventListener('error', () => {
    S.sseOk = false;
    render();
    // EventSource retries by itself; make sure we're still signed in.
    api('GET', '/api/state').catch(() => {});
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !S.me) return;
  if (!es || es.readyState === EventSource.CLOSED) connectLive();
  api('POST', '/api/refresh').then((r) => {
    S.state = r.state;
    render();
  }).catch(() => {});
});

// Keeps "updated 12s ago" honest.
setInterval(() => S.state && renderPill(), 5000);

// ---------- rendering ----------

function currentProgram() {
  const p = { ...S.state.program };
  for (const [k, v] of Object.entries(S.pending)) p[k] = v;
  if (S.draftTarget != null) p.target = S.draftTarget;
  return p;
}

function connectionInfo() {
  const st = S.state;
  const c = st.connection;
  if (!S.sseOk) return { cls: 'warn', text: 'Reconnecting…' };
  if (c.state === 'needs-login') return { cls: 'bad', text: 'Amazon sign-in needed' };
  if (c.state !== 'connected') return { cls: 'warn', text: c.message || 'Connecting…' };
  if (c.pollError) return { cls: 'warn', text: 'Thermostat not answering' };
  const stale = Date.now() - c.lastPollAt > c.pollSeconds * 2500;
  if (!c.lastPollAt) return { cls: 'warn', text: 'Reading thermostat…' };
  return { cls: stale ? 'warn' : '', text: `Live · ${ago(c.lastPollAt)}` };
}

function renderPill() {
  const el = document.getElementById('pill');
  if (!el) return;
  const info = connectionInfo();
  el.innerHTML = `<span class="dot ${info.cls}"></span>${esc(info.text)}`;
}

function render() {
  if (!S.me) return;
  if (!S.state) {
    $app.innerHTML = `<div class="boot"><div class="spinner"></div><p>Connecting to your thermostat…</p></div>`;
    return;
  }
  // Don't redraw under someone's fingers while they type.
  const a = document.activeElement;
  if (a && $app.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT')) {
    renderPill();
    return;
  }
  const p = currentProgram();
  $app.className = `app mode-${p.mode}`;
  document.body.className = `mode-${p.mode}`;
  const view = S.tab === 'schedule' ? viewSchedule() : S.tab === 'settings' ? viewSettings() : viewHome(p);
  $app.innerHTML = `
    <div class="topbar">
      <h1>${S.tab === 'schedule' ? 'Schedule' : S.tab === 'settings' ? 'Settings' : 'Home'}</h1>
      <button class="pill" id="pill" data-act="refresh" aria-label="Refresh now"></button>
    </div>
    ${alerts()}
    ${view}
    ${tabbar()}`;
  renderPill();
}

function alerts() {
  const c = S.state.connection;
  const out = [];
  if (c.state === 'needs-login') {
    out.push(`<div class="alert bad"><div><b>Link your Amazon account</b>${esc(c.message)}
      <div><button class="btn small" data-act="link-amazon">Link Amazon account</button></div></div></div>`);
  } else if (c.pollError) {
    out.push(`<div class="alert"><div><b>Can’t read the thermostat right now</b>${esc(friendlyError(c.pollError))}. Retrying automatically — your last settings are still in effect.</div></div>`);
  }
  if (S.state.status.fallback) {
    out.push(`<div class="alert"><div><b>Chosen sensor isn’t reporting</b>Using the thermostat’s own sensor until it’s back.</div></div>`);
  }
  return out.join('');
}

function tabbar() {
  const t = (id, label, ic) =>
    `<button data-tab="${id}" ${S.tab === id ? 'aria-current="page"' : ''}>${icon(ic)}${label}</button>`;
  return `<div class="tabbar"><nav>${t('home', 'Home', 'home')}${t('schedule', 'Schedule', 'calendar')}${t('settings', 'Settings', 'gear')}</nav></div>`;
}

function viewHome(p) {
  const st = S.state;
  const status = st.status;
  const used = status.used?.length ? status.used : p.sensors;
  const sourceText = used.length > 1 ? `Average of ${used.length} sensors` : sensorName(used[0]);
  const hum = used.length === 1 ? st.sensors.find((s) => s.id === used[0])?.humidity : null;
  const actionText = {
    heating: `Heating to ${fmtTarget(p.target)}°`,
    cooling: `Cooling to ${fmtTarget(p.target)}°`,
    idle: p.mode === 'smart' ? 'Comfortable' : 'Idle',
    off: 'System off',
    unknown: 'Waiting for readings',
  }[status.action] || 'Idle';

  return `
    <section class="hero">
      <div class="now-label">Inside now</div>
      <div class="now-temp">${fmtTemp(status.measured)}<sup>°${isC() ? 'C' : 'F'}</sup></div>
      <div class="now-source">${esc(sourceText)}${typeof hum === 'number' ? ` · ${Math.round(hum)}% humidity` : ''}</div>
      ${p.mode === 'off'
        ? `<div class="stepper"><span></span><div class="target"><div class="target-off">Off</div></div><span></span></div>`
        : `<div class="stepper">
            <button class="step-btn" data-step="-1" aria-label="Lower temperature">−</button>
            <div class="target"><small>Set to</small><div class="target-value ${S.draftTarget != null ? 'pending' : ''}">${fmtTarget(p.target)}°</div></div>
            <button class="step-btn" data-step="1" aria-label="Raise temperature">+</button>
          </div>`}
      <div class="action-line action-${status.action}"><span class="action-icon"></span>${esc(actionText)}</div>
      <div class="reason">${esc(reasonText(p, status, actionText))}</div>
      ${thermostatLine(p)}
      <div class="feedback" aria-live="polite">${feedbackChip()}</div>
    </section>
    ${scheduleBanner()}
    <div class="section"><h2>Mode</h2></div>
    <div class="seg" data-k="mode" role="group" aria-label="Mode">
      ${MODES.map((m) => `<button data-mode="${m.id}" aria-pressed="${p.mode === m.id}" class="${S.pending.mode === m.id ? 'sending' : ''} ${'mode-' + m.id}">${icon(m.icon)}${m.label}</button>`).join('')}
    </div>
    ${p.mode === 'smart' ? `
      <div class="smart-row">
        <div><b>Switch range</b><div class="small muted">A/C at ${fmtTarget(p.target + st.settings.smart.threshold)}°, heat at ${fmtTarget(p.target - st.settings.smart.threshold)}°</div></div>
        <div class="mini-step"><button data-threshold="-1" aria-label="Narrower">−</button><span>±${fmtDelta(st.settings.smart.threshold)}</span><button data-threshold="1" aria-label="Wider">+</button></div>
      </div>` : ''}
    ${st.fan.supported ? `
      <div class="section"><h2>Fan</h2></div>
      <div class="seg" data-k="fan" role="group" aria-label="Fan">
        ${st.fan.modes.map((m) => `<button data-fan="${esc(m.value)}" aria-pressed="${p.fan === m.value}" class="${S.pending.fan === m.value ? 'sending' : ''}">${esc(m.label)}</button>`).join('')}
      </div>` : ''}
    <div class="section"><h2>Temperature from</h2><span class="hint">${p.sensors.length > 1 ? 'Averaging' : 'Tap to switch · + to combine'}</span></div>
    <div class="sensors">
      ${st.sensors.map((s) => sensorCard(s, p)).join('') || '<div class="muted small">No sensors found yet.</div>'}
    </div>
    ${recentActivity()}`;
}

// What Amazon says the thermostat itself is set to, so the app and the
// thermostat's display can be compared at a glance.
function thermostatLine(p) {
  const t = S.state.thermostat;
  if (!t?.mode) return '';
  const modeName = { HEAT: 'Heat', COOL: 'Cool', OFF: 'Off', AUTO: 'Auto', ECO: 'Eco' }[t.mode] || t.mode;
  const sp = t.mode !== 'OFF' && typeof t.setpoint === 'number' ? ` ${fmtTarget(t.setpoint)}°` : '';
  let note = '';
  if (S.state.status.driven && t.mode !== 'OFF' && typeof t.setpoint === 'number' && Math.abs(t.setpoint - p.target) >= 0.5) {
    const src = (S.state.status.used || []).length > 1 ? 'your sensors' : sensorName(S.state.status.used?.[0]);
    note = ` · adjusted on purpose so it follows ${esc(src)}`;
  } else if (S.state.commands.some((c) => c.state === 'sent')) {
    note = ' · waiting for the thermostat to report back';
  }
  return `<div class="thermo-line">On the thermostat: <b>${esc(modeName)}${sp}</b>${note}</div>`;
}

function reasonText(p, status, actionText) {
  if (p.mode === 'smart' && status.action === 'idle') return smartHint(p);
  const r = status.reason || '';
  return r === actionText ? '' : r;
}

function smartHint(p) {
  const t = S.state.settings.smart.threshold;
  return `A/C turns on at ${fmtTarget(p.target + t)}°, heat at ${fmtTarget(p.target - t)}°`;
}

function sensorCard(s, p) {
  const on = p.sensors.includes(s.id);
  const offline = s.reachable === false || typeof s.temp !== 'number';
  const kind = s.kind === 'thermostat' ? 'Thermostat' : s.kind === 'air-quality' ? 'Air monitor' : 'Sensor';
  return `
    <button class="sensor ${offline ? 'offline' : ''}" data-sensor="${esc(s.id)}" aria-pressed="${on}" aria-label="Use ${esc(s.name)}">
      <span class="combine" data-combine="${esc(s.id)}" role="button" aria-label="${on ? 'Remove from' : 'Add to'} average">${on ? '✓' : '+'}</span>
      <span class="name">${esc(s.name)}</span>
      <span class="temp">${offline ? 'Offline' : `${fmtTemp(s.temp)}°`}</span>
      <span class="meta"><span class="tag">${kind}</span>${typeof s.humidity === 'number' ? `<span>${Math.round(s.humidity)}%</span>` : ''}</span>
    </button>`;
}

function feedbackChip() {
  const f = S.feedback;
  if (!f) return '';
  const label = f.label ? esc(f.label) : '';
  switch (f.state) {
    case 'waiting':
      return `<span class="chip">Release to send ${label}</span>`;
    case 'sending':
      return `<span class="chip"><span class="spinner sm"></span>Sending ${label}…</span>`;
    case 'sent':
      return `<span class="chip"><span class="spinner sm"></span>Sent · waiting for thermostat to confirm</span>`;
    case 'confirmed':
      return `<span class="chip ok">✓ Thermostat confirmed ${label}</span>`;
    case 'saved':
      return `<span class="chip ok">✓ Saved ${label}</span>`;
    case 'failed':
      return `<span class="chip bad">⚠ ${esc(f.error)} ${f.changes ? '<button data-act="retry">Retry</button>' : ''}</span>`;
  }
  return '';
}

function scheduleBanner() {
  const st = S.state;
  if (st.override) {
    const until = st.override.until ? `until ${whenLabel(st.override.until)}` : 'until you resume';
    return `<div class="banner hold"><div><b>Holding ${until}</b><div class="t small">Set by ${esc(st.override.by)}${st.next ? ` · then ${esc(st.next.entry.name || modeLabel(st.next.entry.mode))} ${fmtTarget(st.next.entry.target)}°` : ''}</div></div>
      <button class="btn small" data-act="resume">Resume schedule</button></div>`;
  }
  if (st.source === 'schedule') {
    return `<div class="banner"><div><b>On schedule${st.entry?.name ? ` · ${esc(st.entry.name)}` : ''}</b>
      <div class="t small">${st.next ? `Next: ${esc(st.next.entry.name || modeLabel(st.next.entry.mode))} ${fmtTarget(st.next.entry.target)}° at ${whenLabel(st.next.at)}` : ''} · Changes here hold until then</div></div></div>`;
  }
  return '';
}

function recentActivity() {
  const items = S.state.activity.slice(0, 3);
  if (!items.length) return '';
  return `<div class="section"><h2>Recent</h2></div>
    <div class="list activity">${items.map(activityRow).join('')}</div>`;
}
function activityRow(a) {
  return `<div class="row"><div class="row-main"><div>${esc(a.by)}</div><div class="sub" style="white-space:normal">${esc(a.text)}</div></div><div class="right small">${esc(ago(a.at))}</div></div>`;
}

// ---------- schedule ----------

function entryAt(entries, when) {
  let best = null;
  for (const e of entries) {
    for (let back = 0; back < 8; back++) {
      const d = new Date(when);
      d.setDate(d.getDate() - back);
      if (!e.days.includes(d.getDay())) continue;
      const [h, m] = e.time.split(':').map(Number);
      d.setHours(h, m, 0, 0);
      if (d <= when) {
        if (!best || d > best.at) best = { e, at: d };
        break;
      }
    }
  }
  return best?.e || null;
}

function timeline(entries) {
  if (!entries.length) return '';
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  const points = [{ min: 0, e: entryAt(entries, day) }];
  for (const e of entries.filter((x) => x.days.includes(day.getDay())).sort((a, b) => a.time.localeCompare(b.time))) {
    const [h, m] = e.time.split(':').map(Number);
    points.push({ min: h * 60 + m, e });
  }
  const segs = points.map((pt, i) => {
    const end = points[i + 1]?.min ?? 1440;
    const w = ((end - pt.min) / 1440) * 100;
    const mode = pt.e?.mode || 'off';
    const label = pt.e ? (mode === 'off' ? 'Off' : `${fmtTarget(pt.e.target)}°`) : '';
    return `<div class="seg-block mode-${mode}" style="width:${w}%">${w > 9 ? esc(label) : ''}</div>`;
  });
  const now = new Date();
  const pct = ((now.getHours() * 60 + now.getMinutes()) / 1440) * 100;
  return `<div class="section"><h2>Today</h2></div>
    <div class="timeline">${segs.join('')}<span class="now" style="left:${pct}%"></span></div>
    <div class="timeline-labels"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>12a</span></div>`;
}

function viewSchedule() {
  const st = S.state;
  const sch = st.schedule;
  const entries = [...sch.entries].sort((a, b) => a.time.localeCompare(b.time) || a.days[0] - b.days[0]);
  const activeId = st.entry?.id;
  return `
    <div class="list">
      <label class="row"><div class="row-main"><div>Use schedule</div><div class="sub">${sch.enabled ? 'Manual changes hold until the next scheduled time' : 'Off — the thermostat stays where you set it'}</div></div>
        <span class="switch"><input type="checkbox" data-act="toggle-schedule" ${sch.enabled ? 'checked' : ''} aria-label="Use schedule"><span></span></span></label>
    </div>
    ${sch.enabled ? timeline(entries) : ''}
    <div class="section"><h2>Times</h2><button class="btn small secondary" data-act="add-entry">+ Add time</button></div>
    <div class="list">
      ${entries.length ? entries.map((e) => `
        <button class="row entry mode-${e.mode} ${e.id === activeId && sch.enabled ? 'active' : ''}" data-edit="${esc(e.id)}">
          <span class="entry-time">${esc(time12(e.time))}</span>
          <span class="row-main" style="flex:1">
            <div>${esc(e.name || modeLabel(e.mode))} <span class="badge">${e.mode === 'off' ? 'Off' : `${modeLabel(e.mode)} ${fmtTarget(e.target)}°`}</span></div>
            <div class="sub">${esc(daysLabel(e.days))} · ${esc(e.sensors.map(sensorName).join(' + '))}</div>
          </span>
          <span class="right">›</span>
        </button>`).join('') : `<div class="empty">No times yet.<br>Add one, like “Night · 10:00 PM · 66° · Bedroom”.</div>`}
    </div>
    <p class="small muted">Each time switches the temperature, mode, fan and which sensor to follow. If anyone changes something by hand, it holds until the next time on the list, then the schedule picks back up.</p>`;
}

function blankEntry() {
  const p = S.state.program;
  return { id: null, name: '', time: '22:00', days: [0, 1, 2, 3, 4, 5, 6], mode: p.mode, target: p.target, fan: p.fan, sensors: [...p.sensors] };
}

function openEditor(entry) {
  S.editor = structuredClone(entry || blankEntry());
  S.editor.isNew = !entry;
  renderEditor();
}

function closeEditor() {
  S.editor = null;
  $sheet.innerHTML = '';
}

function renderEditor() {
  const e = S.editor;
  if (!e) return;
  const st = S.state;
  $sheet.innerHTML = `
    <div class="sheet-backdrop" data-act="close-editor"></div>
    <div class="sheet mode-${e.mode}" role="dialog" aria-modal="true" aria-label="Edit scheduled time">
      <div class="grab"></div>
      <header><h3>${e.isNew ? 'New time' : 'Edit time'}</h3><button class="btn small secondary" data-act="close-editor">Cancel</button></header>
      <div class="group">
        <label for="ed-time">Starts at</label>
        <input id="ed-time" class="time-input" type="time" value="${esc(e.time)}" data-ed="time">
        <input class="input" placeholder="Name (optional), e.g. Night" value="${esc(e.name)}" data-ed="name" maxlength="40">
      </div>
      <div class="group">
        <div class="lbl">Days</div>
        <div class="days">${DAYS.map((d, i) => `<button data-day="${i}" aria-pressed="${e.days.includes(i)}">${d[0]}</button>`).join('')}</div>
        <div class="presets"><button data-days="0123456">Every day</button><button data-days="12345">Weekdays</button><button data-days="06">Weekends</button></div>
      </div>
      <div class="group">
        <div class="lbl">Mode</div>
        <div class="seg" style="box-shadow:none;background:var(--card-2)">${MODES.map((m) => `<button data-ed-mode="${m.id}" aria-pressed="${e.mode === m.id}">${icon(m.icon)}${m.label}</button>`).join('')}</div>
        ${e.mode !== 'off' ? `<div class="settings-num"><span>Temperature</span>
          <div class="mini-step"><button data-ed-step="-1">−</button><span>${fmtTarget(e.target)}°</span><button data-ed-step="1">+</button></div></div>` : ''}
      </div>
      <div class="group">
        <div class="lbl">Temperature from</div>
        <div class="chips">${st.sensors.map((s) => `<button data-ed-sensor="${esc(s.id)}" aria-pressed="${e.sensors.includes(s.id)}">${esc(s.name)}</button>`).join('')}</div>
        ${e.sensors.length > 1 ? '<div class="small muted">Averaging the selected sensors.</div>' : ''}
      </div>
      ${st.fan.supported ? `<div class="group"><div class="lbl">Fan</div>
        <div class="chips">${st.fan.modes.map((m) => `<button data-ed-fan="${esc(m.value)}" aria-pressed="${e.fan === m.value}">${esc(m.label)}</button>`).join('')}</div></div>` : ''}
      <div class="actions">
        ${e.isNew ? '<span></span>' : '<button class="btn danger" data-act="delete-entry">Delete</button>'}
        <button class="btn" data-act="save-entry">Save</button>
      </div>
    </div>`;
}

async function saveSchedule(entries, enabled, msg) {
  try {
    const r = await api('PUT', '/api/schedule', { enabled, entries });
    S.state = r.state;
    if (msg) toast(msg);
    const failed = r.results.find((c) => c.state === 'failed');
    if (failed) toast(`Saved, but the thermostat didn’t respond: ${friendlyError(failed.error)}`);
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  } finally {
    render();
  }
}

// ---------- settings ----------

function numRow(label, sub, key, value, display) {
  return `<div class="row"><div class="row-main"><div>${label}</div><div class="sub">${sub}</div></div>
    <div class="mini-step"><button data-set="${key}" data-dir="-1" aria-label="Decrease">−</button><span>${display(value)}</span><button data-set="${key}" data-dir="1" aria-label="Increase">+</button></div></div>`;
}

function viewSettings() {
  const st = S.state;
  const s = st.settings;
  const c = st.connection;
  return `
    <div class="section"><h2>Smart mode</h2></div>
    <div class="list">
      ${numRow('Switch range', `A/C turns on at set + this, heat at set − this`, 'threshold', s.smart.threshold, (v) => `±${fmtDelta(v)}`)}
      ${numRow('Changeover wait', 'Minimum gap between heating and cooling', 'changeover', s.smart.changeoverDelayMin, (v) => `${v}m`)}
    </div>
    <div class="section"><h2>Air-monitor control</h2></div>
    <div class="list">
      ${numRow('Swing', 'How far from set before Heat/Cool kicks in', 'swing', s.swing, (v) => `±${fmtDelta(v)}`)}
      ${numRow('Safety band', 'The thermostat never goes further than this from your set temp, even if this server stops', 'maxOffset', s.maxOffset, (v) => fmtDelta(v))}
    </div>
    <div class="section"><h2>Display</h2></div>
    <div class="list"><div class="row"><div>Units</div>
      <div class="seg" style="box-shadow:none;background:var(--card-2);width:140px">
        <button data-unit="F" aria-pressed="${s.unit === 'F'}">°F</button><button data-unit="C" aria-pressed="${s.unit === 'C'}">°C</button></div></div></div>
    <div class="list" style="margin-top:10px"><div class="row"><div class="row-main"><div>Time zone</div><div class="sub">Schedules follow this clock: ${esc(s.timeZone || 'not set')}</div></div>
      ${phoneTz() && phoneTz() !== s.timeZone ? `<button class="btn small secondary" data-act="use-phone-tz">Use ${esc(phoneTz())}</button>` : ''}</div></div>
    <div class="section"><h2>Sensor names</h2></div>
    <div class="list">
      ${st.sensors.map((x) => `<div class="row"><input class="input" data-rename="${esc(x.id)}" value="${esc(x.name)}" placeholder="${esc(x.originalName)}" aria-label="Name for ${esc(x.originalName)}" maxlength="30"></div>`).join('')}
    </div>
    ${st.thermostats.length > 1 ? `<div class="section"><h2>Thermostat</h2></div>
      <div class="list"><div class="row"><select class="input" data-act="thermostat">${st.thermostats.map((t) => `<option value="${esc(t.id)}" ${t.id === s.thermostatId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div></div>` : ''}
    <div class="section"><h2>Amazon</h2></div>
    <div class="list">
      <div class="row"><div class="row-main"><div>${c.state === 'connected' ? 'Connected' : esc(c.message || c.state)}</div><div class="sub">Last reading ${esc(ago(c.lastPollAt))} · checks every ${s.pollSeconds}s</div></div></div>
      <button class="row" data-act="rediscover"><div>Re-scan devices</div><span class="right">${icon('refresh')}</span></button>
      <button class="row" data-act="link-amazon"><div>${c.state === 'connected' ? 'Re-link Amazon account' : 'Link Amazon account'}</div><span class="right">›</span></button>
      <button class="row" data-act="probe"><div class="row-main"><div>Sensor API probe</div><div class="sub">Asks Amazon how sensor selection works, for troubleshooting</div></div><span class="right">›</span></button>
      <a class="row" href="/api/debug/devices" target="_blank" rel="noopener"><div class="row-main"><div>Device inspector</div><div class="sub">Raw data from Amazon, for troubleshooting</div></div><span class="right">›</span></a>
    </div>
    <div class="section"><h2>Household</h2></div>
    <div class="list">
      <div class="row"><div>Signed in as <b>${esc(S.me)}</b></div><button class="btn small secondary" data-act="logout">Sign out</button></div>
      <button class="row" data-act="change-passcode"><div class="row-main"><div>Change household passcode</div><div class="sub">Signs out every phone</div></div><span class="right">›</span></button>
      <button class="row" data-act="signout-everyone"><div class="row-main"><div style="color:var(--bad)">Sign out every phone</div><div class="sub">Everyone will need the passcode again</div></div></button>
    </div>
    <div class="section"><h2>Activity</h2></div>
    <div class="list activity">${st.activity.map(activityRow).join('') || '<div class="empty">Nothing yet</div>'}</div>`;
}

const phoneTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const SETTING_STEPS = {
  threshold: { get: (s) => s.smart.threshold, step: 0.5, body: (v) => ({ smart: { threshold: v } }) },
  changeover: { get: (s) => s.smart.changeoverDelayMin, step: 5, body: (v) => ({ smart: { changeoverDelayMin: v } }) },
  swing: { get: (s) => s.swing, step: 0.25, body: (v) => ({ swing: v }) },
  maxOffset: { get: (s) => s.maxOffset, step: 1, body: (v) => ({ maxOffset: v }) },
};

async function saveSettings(body) {
  try {
    const r = await api('PUT', '/api/settings', body);
    S.state = r.state;
  } catch (err) {
    toast(err.message);
  }
  render();
}

// ---------- login ----------

let needsSetup = false;

function renderLogin(error = '') {
  $app.className = 'app mode-smart';
  $app.innerHTML = needsSetup
    ? `
    <form class="login" id="login">
      <h1>Welcome</h1>
      <p>Choose a household passcode. Everyone in your home will use it to sign in, so share it only with them.</p>
      <label class="field"><span>Your name</span><input class="input" name="name" autocomplete="given-name" value="${esc(localGet('name') || '')}" required></label>
      <label class="field"><span>New household passcode (6+ characters)</span><input class="input" name="passcode" autocomplete="new-password" type="password" minlength="6" required></label>
      <div class="error-text">${esc(error)}</div>
      <button class="btn" type="submit">Create household</button>
    </form>`
    : `
    <form class="login" id="login">
      <h1>Home Climate</h1>
      <p>Enter the household passcode. Your name shows up next to the changes you make.</p>
      <label class="field"><span>Your name</span><input class="input" name="name" autocomplete="given-name" value="${esc(localGet('name') || '')}" required></label>
      <label class="field"><span>Household passcode</span><input class="input" name="passcode" autocomplete="current-password" type="password" required></label>
      <div class="error-text">${esc(error)}</div>
      <button class="btn" type="submit">Sign in</button>
    </form>`;
}

$app.addEventListener('submit', async (ev) => {
  if (ev.target.id !== 'login') return;
  ev.preventDefault();
  const fd = new FormData(ev.target);
  localSet('name', fd.get('name'));
  try {
    await api('POST', needsSetup ? '/api/setup' : '/api/login', { name: fd.get('name'), passcode: fd.get('passcode') });
    needsSetup = false;
    await boot();
  } catch (err) {
    renderLogin(err.message);
  }
});

// ---------- Amazon linking ----------
// Amazon's sign-in ends on a page whose address carries a one-time code.
// The person copies that address and pastes it here; the server does the rest.

const LINK = { url: null, error: '', busy: false };

async function openLinkSheet() {
  Object.assign(LINK, { url: null, error: '', busy: false });
  renderLinkSheet();
  try {
    LINK.url = (await api('POST', '/api/amazon/start')).url;
  } catch (err) {
    LINK.error = err.message;
  }
  renderLinkSheet();
}

function renderLinkSheet() {
  $sheet.innerHTML = `
    <div class="sheet-backdrop" data-act="close-link"></div>
    <div class="sheet mode-smart" role="dialog" aria-modal="true" aria-label="Link Amazon account">
      <div class="grab"></div>
      <header><h3>Link Amazon account</h3><button class="btn small secondary" data-act="close-link">Cancel</button></header>
      <div class="group">
        <div class="lbl">Step 1</div>
        <div>Sign in on Amazon’s own page. It opens in a new tab.</div>
        ${LINK.url
          ? `<a class="btn" href="${esc(LINK.url)}" target="_blank" rel="noopener noreferrer">Open Amazon sign-in</a>`
          : `<button class="btn" disabled><span class="spinner sm"></span>Preparing…</button>`}
      </div>
      <div class="group">
        <div class="lbl">Step 2</div>
        <div>After signing in, Amazon shows a page that may say <b>“Page not found”</b>. That’s expected. Copy that page’s full address: tap the address bar, then <b>Copy</b> (or Share → Copy).</div>
      </div>
      <div class="group">
        <div class="lbl">Step 3</div>
        <div>Come back to this tab and paste it here:</div>
        <textarea class="input" id="link-url" rows="3" placeholder="https://www.amazon.com/ap/maplanding?…" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
        ${navigator.clipboard?.readText ? '<button class="btn secondary small" data-act="paste-link">Paste from clipboard</button>' : ''}
        <div class="error-text">${esc(LINK.error)}</div>
        <button class="btn" data-act="finish-link" ${LINK.busy || !LINK.url ? 'disabled' : ''}>${LINK.busy ? '<span class="spinner sm"></span>Linking…' : 'Link account'}</button>
      </div>
      <p class="small muted">Your Amazon password never touches this app. It only keeps the device token Amazon issues, the same way the Alexa app does on a new phone. The code in the address works once and expires within a few minutes.</p>
    </div>`;
}

$sheet.addEventListener('click', async (ev) => {
  const act = ev.target.closest('[data-act]')?.dataset.act;
  if (act === 'copy-probe') {
    const ta = document.getElementById('probe-text');
    try {
      await navigator.clipboard.writeText(ta.value);
      toast('Copied');
    } catch {
      ta.focus();
      ta.select();
      toast('Selected. Tap Copy.');
    }
    return;
  }
  if (act === 'close-link') {
    $sheet.innerHTML = '';
    return;
  }
  if (act === 'paste-link') {
    try {
      document.getElementById('link-url').value = await navigator.clipboard.readText();
    } catch {
      toast('Couldn’t read the clipboard. Long-press the box and choose Paste.');
    }
    return;
  }
  if (act === 'finish-link') {
    const value = document.getElementById('link-url').value;
    LINK.busy = true;
    LINK.error = '';
    renderLinkSheet();
    document.getElementById('link-url').value = value;
    try {
      const r = await api('POST', '/api/amazon/finish', { url: value }, { timeout: 45000 });
      S.state = r.state;
      $sheet.innerHTML = '';
      toast('Amazon linked. Finding your thermostat…');
      render();
    } catch (err) {
      LINK.busy = false;
      LINK.error = err.message;
      renderLinkSheet();
      document.getElementById('link-url').value = value;
    }
  }
});

// ---------- interactions ----------

let debounceTimer;
function nudgeTarget(dir) {
  const p = currentProgram();
  if (p.mode === 'off') return;
  const s = S.state.settings;
  const cur = toDisp(S.draftTarget ?? S.state.program.target);
  const snapped = isC() ? Math.round(cur * 2) / 2 : Math.round(cur);
  const next = fromDisp(snapped + dir * step());
  S.draftTarget = Math.min(s.maxTarget, Math.max(s.minTarget, next));
  S.feedback = { state: 'waiting', label: `${fmtTarget(S.draftTarget)}°` };
  render();
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const t = S.draftTarget;
    if (t != null) sendChange({ target: t }, `${fmtTarget(t)}°`);
  }, 700);
}

// Press and hold +/− to move quickly.
let holdTimer;
let holdInterval;
function stopHold() {
  clearTimeout(holdTimer);
  clearInterval(holdInterval);
}
$app.addEventListener('pointerdown', (ev) => {
  const b = ev.target.closest('[data-step]');
  if (!b) return;
  ev.preventDefault();
  const dir = Number(b.dataset.step);
  nudgeTarget(dir);
  holdTimer = setTimeout(() => {
    holdInterval = setInterval(() => nudgeTarget(dir), 140);
  }, 450);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => $app.addEventListener(t, stopHold));
window.addEventListener('blur', stopHold);
$app.addEventListener('keydown', (ev) => {
  const b = ev.target.closest('[data-step]');
  if (b && (ev.key === 'Enter' || ev.key === ' ')) {
    ev.preventDefault();
    nudgeTarget(Number(b.dataset.step));
  }
});

$app.addEventListener('click', async (ev) => {
  const t = ev.target;
  const tab = t.closest('[data-tab]');
  if (tab) {
    S.tab = tab.dataset.tab;
    localSet('tab', S.tab);
    render();
    window.scrollTo(0, 0);
    return;
  }

  const mode = t.closest('[data-mode]');
  if (mode) {
    const m = mode.dataset.mode;
    if (m === currentProgram().mode) return;
    S.pending.mode = m;
    return sendChange({ mode: m }, modeLabel(m));
  }

  const fan = t.closest('[data-fan]');
  if (fan) {
    const f = fan.dataset.fan;
    if (f === currentProgram().fan) return;
    S.pending.fan = f;
    return sendChange({ fan: f }, `fan ${S.state.fan.modes.find((x) => x.value === f)?.label || f}`);
  }

  const combine = t.closest('[data-combine]');
  if (combine) {
    ev.stopPropagation();
    const id = combine.dataset.combine;
    const cur = currentProgram().sensors;
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    if (!next.length) {
      combine.closest('.sensor').classList.add('shake');
      return toast('At least one sensor is needed');
    }
    S.pending.sensors = next;
    return sendChange({ sensors: next }, next.length > 1 ? `· averaging ${next.length} sensors` : `· using ${sensorName(next[0])}`);
  }

  const sensor = t.closest('[data-sensor]');
  if (sensor) {
    const id = sensor.dataset.sensor;
    const cur = currentProgram().sensors;
    if (cur.length === 1 && cur[0] === id) return;
    S.pending.sensors = [id];
    return sendChange({ sensors: [id] }, `· using ${sensorName(id)}`);
  }

  const thr = t.closest('[data-threshold]');
  if (thr) {
    const v = Math.min(5, Math.max(0.5, S.state.settings.smart.threshold + Number(thr.dataset.threshold) * 0.5));
    return saveSettings({ smart: { threshold: v } });
  }

  const set = t.closest('[data-set]');
  if (set) {
    const def = SETTING_STEPS[set.dataset.set];
    const v = Math.round((def.get(S.state.settings) + Number(set.dataset.dir) * def.step) * 100) / 100;
    return saveSettings(def.body(v));
  }

  const unit = t.closest('[data-unit]');
  if (unit) return saveSettings({ unit: unit.dataset.unit });

  const edit = t.closest('[data-edit]');
  if (edit) return openEditor(S.state.schedule.entries.find((e) => e.id === edit.dataset.edit));

  const act = t.closest('[data-act]')?.dataset.act;
  switch (act) {
    case 'refresh': {
      const pill = document.getElementById('pill');
      pill.innerHTML = '<span class="spinner sm"></span>Checking…';
      try {
        const r = await api('POST', '/api/refresh');
        S.state = r.state;
      } catch (err) {
        toast(err.message);
      }
      return render();
    }
    case 'retry':
      if (S.feedback?.changes) {
        const ch = S.feedback.changes;
        Object.assign(S.pending, Object.fromEntries(Object.entries(ch).filter(([k]) => k !== 'target')));
        return sendChange(ch, S.feedback.label);
      }
      return;
    case 'resume':
      S.feedback = { state: 'sending', label: 'schedule' };
      render();
      try {
        const r = await api('POST', '/api/resume');
        S.state = r.state;
        applyResults(r.results, 'schedule', {});
      } catch (err) {
        S.feedback = { state: 'failed', error: err.message };
      }
      return render();
    case 'add-entry':
      return openEditor(null);
    case 'rediscover':
      toast('Scanning…');
      try {
        const r = await api('POST', '/api/rediscover', null, { timeout: 45000 });
        S.state = r.state;
        toast(`Found ${r.state.sensors.length} sensors`);
      } catch (err) {
        toast(err.message);
      }
      return render();
    case 'logout':
      await api('POST', '/api/logout').catch(() => {});
      S.me = null;
      es?.close();
      return renderLogin();
    case 'use-phone-tz':
      return saveSettings({ timeZone: phoneTz() });
    case 'probe': {
      $sheet.innerHTML = `<div class="sheet-backdrop" data-act="close-link"></div><div class="sheet"><div class="grab"></div>
        <header><h3>Sensor API probe</h3><button class="btn small secondary" data-act="close-link">Close</button></header>
        <div class="group"><div><span class="spinner sm"></span> Asking Amazon… this can take up to a minute.</div></div></div>`;
      let text;
      try {
        const r = await api('POST', '/api/debug/probe', null, { timeout: 90000 });
        text = JSON.stringify(r.probe);
      } catch (err) {
        text = `Probe failed: ${err.message}`;
      }
      $sheet.innerHTML = `<div class="sheet-backdrop" data-act="close-link"></div><div class="sheet"><div class="grab"></div>
        <header><h3>Sensor API probe</h3><button class="btn small secondary" data-act="close-link">Close</button></header>
        <div class="group"><div>Copy this and paste it into your chat. It has device names and Amazon’s API layout, but no passwords or tokens.</div>
        <button class="btn" data-act="copy-probe">Copy result</button>
        <textarea class="input" id="probe-text" rows="10" readonly></textarea></div></div>`;
      document.getElementById('probe-text').value = text;
      return;
    }
    case 'link-amazon':
      return openLinkSheet();
    case 'change-passcode': {
      const p = prompt('New household passcode (6+ characters). Every phone will need to sign in again.');
      if (!p) return;
      try {
        await api('POST', '/api/passcode', { passcode: p });
        S.me = null;
        es?.close();
        return renderLogin();
      } catch (err) {
        return toast(err.message);
      }
    }
    case 'signout-everyone':
      if (!confirm('Sign out every phone in the household?')) return;
      await api('POST', '/api/signout-everyone').catch(() => {});
      S.me = null;
      es?.close();
      return renderLogin();
  }
});

$app.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.dataset.act === 'toggle-schedule') {
    const sch = S.state.schedule;
    t.blur();
    return saveSchedule(sch.entries, t.checked, t.checked ? 'Schedule on' : 'Schedule off — current settings stay');
  }
  if (t.dataset.rename) {
    t.blur();
    return saveSettings({ sensorNames: { [t.dataset.rename]: t.value.trim() } });
  }
  if (t.dataset.act === 'thermostat') {
    t.blur();
    return saveSettings({ thermostatId: t.value });
  }
});
$app.addEventListener('focusout', () => setTimeout(() => {
  const a = document.activeElement;
  if (!a || !$app.contains(a) || !['INPUT', 'SELECT'].includes(a.tagName)) render();
}, 0));

// Schedule editor sheet
$sheet.addEventListener('click', async (ev) => {
  const e = S.editor;
  if (!e) return;
  const t = ev.target;
  const pick = (sel) => t.closest(sel);
  let b;
  if ((b = pick('[data-day]'))) {
    const d = Number(b.dataset.day);
    e.days = e.days.includes(d) ? e.days.filter((x) => x !== d) : [...e.days, d].sort();
  } else if ((b = pick('[data-days]'))) {
    e.days = b.dataset.days.split('').map(Number);
  } else if ((b = pick('[data-ed-mode]'))) {
    e.mode = b.dataset.edMode;
  } else if ((b = pick('[data-ed-step]'))) {
    const cur = toDisp(e.target);
    const snapped = isC() ? Math.round(cur * 2) / 2 : Math.round(cur);
    e.target = Math.min(S.state.settings.maxTarget, Math.max(S.state.settings.minTarget, fromDisp(snapped + Number(b.dataset.edStep) * step())));
  } else if ((b = pick('[data-ed-sensor]'))) {
    const id = b.dataset.edSensor;
    const next = e.sensors.includes(id) ? e.sensors.filter((x) => x !== id) : [...e.sensors, id];
    if (!next.length) return toast('Pick at least one sensor');
    e.sensors = next;
  } else if ((b = pick('[data-ed-fan]'))) {
    e.fan = b.dataset.edFan;
  } else {
    const act = pick('[data-act]')?.dataset.act;
    if (act === 'close-editor') return closeEditor();
    if (act === 'save-entry') {
      if (!e.days.length) return toast('Pick at least one day');
      const { isNew, ...entry } = e;
      const others = S.state.schedule.entries.filter((x) => x.id !== e.id);
      const enable = S.state.schedule.enabled || !S.state.schedule.entries.length;
      const ok = await saveSchedule([...others, entry], enable, !S.state.schedule.enabled && enable ? 'Saved · schedule turned on' : 'Saved');
      if (ok) closeEditor();
      return;
    }
    if (act === 'delete-entry') {
      const ok = await saveSchedule(S.state.schedule.entries.filter((x) => x.id !== e.id), S.state.schedule.enabled, 'Deleted');
      if (ok) closeEditor();
      return;
    }
    return;
  }
  renderEditor();
});
$sheet.addEventListener('input', (ev) => {
  const k = ev.target.dataset.ed;
  if (k && S.editor) S.editor[k] = ev.target.value;
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && S.editor) closeEditor();
});

// ---------- start ----------

async function boot() {
  try {
    const hello = await api('GET', '/api/hello');
    needsSetup = hello.needsSetup;
    if (!hello.me) {
      S.me = null;
      return renderLogin();
    }
    const r = await api('GET', '/api/state');
    S.me = r.me;
    S.state = r.state;
    render();
    connectLive();
    // Schedules run in the household's time zone; take it from the first phone.
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!S.state.settings.timeZone && tz) saveSettings({ timeZone: tz });
  } catch (err) {
    if (!S.me) {
      if (err.message !== 'Please sign in') {
        $app.innerHTML = `<div class="boot"><p>${esc(err.message)}</p><button class="btn" id="retry-boot">Try again</button></div>`;
        document.getElementById('retry-boot').onclick = boot;
      }
    }
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
