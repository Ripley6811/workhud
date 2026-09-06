/* eslint-env browser */
const $ = (id) => document.getElementById(id);

let cfg = null;

/* ------------------------------------------------------------- plumbing */

let saveTimer = null;
function save(partial, immediate = false) {
  clearTimeout(saveTimer);
  const run = async () => { cfg = await window.hud.saveConfig(partial); };
  if (immediate) return run();
  saveTimer = setTimeout(run, 250);
  return Promise.resolve();
}

function bindCheckbox(id, key) {
  $(id).addEventListener('change', (e) => save({ [key]: e.target.checked }, true));
}

// Sliders write through on `input` so the window reacts while you drag.
function bindRange(id, key, format, transform = (v) => v) {
  const input = $(id);
  const out = $(`${id}Out`);
  const paint = () => { out.textContent = format(Number(input.value)); };
  input.addEventListener('input', () => { paint(); save({ [key]: transform(Number(input.value)) }); });
  return paint;
}

const paint = {};

/* ---------------------------------------------------------------- fields */

paint.pollMinutes = bindRange('pollMinutes', 'pollMinutes',
  (v) => (v === 1 ? '1 minute' : `${v} minutes`));
paint.activePollSeconds = bindRange('activePollSeconds', 'activePollSeconds',
  (v) => (v >= 60 && v % 60 === 0 ? `${v / 60} min` : `${v} seconds`));
paint.hudHeight = bindRange('hudHeight', 'hudHeight', (v) => `${v} px`);
paint.hudOpacity = bindRange('hudOpacity', 'hudOpacity', (v) => `${v}%`, (v) => v / 100);

for (const key of ['showGmail', 'showSlack', 'showCalendar', 'showMemory', 'showMemoryColumn',
                   'launchAtLogin', 'slackOpenInBrowser', 'pinned', 'expanded', 'hoverPeek', 'showInTaskbar', 'vertical']) {
  bindCheckbox(key, key);
}

$('maxItems').addEventListener('change', (e) => save({ maxItems: Number(e.target.value) }));
$('gmailQuery').addEventListener('change', (e) => save({ gmailQuery: e.target.value.trim() }));

$('googleClientId').addEventListener('change', (e) => save({ google: { clientId: e.target.value.trim() } }));
$('googleClientSecret').addEventListener('change', (e) => {
  const v = e.target.value.trim();
  if (v) save({ google: { clientSecret: v } }); // blank means "keep what is stored"
});

/* --------------------------------------------------------------- actions */

function setStatus(id, text, kind) {
  const n = $(id);
  n.textContent = text;
  n.className = `status${kind ? ` ${kind}` : ''}`;
}

async function withBusy(btn, statusId, working, fn) {
  btn.disabled = true;
  setStatus(statusId, working);
  try {
    return await fn();
  } catch (e) {
    setStatus(statusId, e.message || String(e), 'err');
    return null;
  } finally {
    btn.disabled = false;
  }
}

$('googleConnect').addEventListener('click', async () => {
  const id = $('googleClientId').value.trim();
  const secret = $('googleClientSecret').value.trim();
  if (!id) return setStatus('googleStatus', 'Enter your client ID first.', 'err');
  await save({ google: { clientId: id, ...(secret ? { clientSecret: secret } : {}) } }, true);

  const r = await withBusy($('googleConnect'), 'googleStatus',
    'Waiting for you to finish in the browser...', () => window.hud.googleSignIn());
  if (r) {
    setStatus('googleStatus', `Connected as ${r.email || 'your account'}.`, 'ok');
    $('googleClientSecret').value = '';
    await refresh();
  }
  return undefined;
});

$('googleDisconnect').addEventListener('click', async () => {
  await window.hud.googleSignOut();
  setStatus('googleStatus', 'Disconnected.');
  await refresh();
});

$('slackConnect').addEventListener('click', async () => {
  const token = $('slackToken').value.trim();
  const r = await withBusy($('slackConnect'), 'slackStatus', 'Checking token...',
    () => window.hud.slackConnect(token));
  if (r) {
    setStatus('slackStatus', `Connected to ${r.teamName} as ${r.userName}.`, 'ok');
    $('slackToken').value = '';
    await refresh();
  }
});

$('slackDisconnect').addEventListener('click', async () => {
  await window.hud.slackDisconnect();
  setStatus('slackStatus', 'Disconnected.');
  await refresh();
});

// Drive checkboxes are built from whatever is actually mounted. All ticked is
// stored as an empty filter, so a drive plugged in later shows up on its own.
async function renderDisks() {
  const box = $('diskList');
  const drives = await window.hud.listDisks();
  box.replaceChildren();
  if (!drives.length) {
    const none = document.createElement('span');
    none.className = 'none';
    none.textContent = 'No drives detected.';
    box.appendChild(none);
    return;
  }
  const filter = new Set(cfg.diskFilter || []);
  for (const d of drives) {
    const wrap = document.createElement('span');
    wrap.className = 'drive';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = `disk-${d.name}`;
    input.checked = !filter.size || filter.has(d.name);
    input.addEventListener('change', () => {
      const checked = [...box.querySelectorAll('input:checked')].map((n) => n.dataset.name);
      save({ diskFilter: checked.length === drives.length ? [] : checked }, true);
    });
    input.dataset.name = d.name;
    const label = document.createElement('label');
    label.htmlFor = input.id;
    label.textContent = d.name;
    const cap = document.createElement('span');
    cap.className = 'cap';
    const gb = d.total / 1024 ** 3;
    cap.textContent = gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${Math.round(gb)} GB`;
    wrap.append(input, label, cap);
    box.appendChild(wrap);
  }
}

$('resetPosition').addEventListener('click', () => window.hud.resetPosition());
$('refreshNow').addEventListener('click', () => window.hud.pollNow());
$('quitApp').addEventListener('click', () => window.hud.quit());

// Links must leave the app rather than navigating this window.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-ext]');
  if (!a) return;
  e.preventDefault();
  window.hud.openExternal(a.href);
});

/* ---------------------------------------------------------------- render */

async function refresh() {
  cfg = await window.hud.getConfig();

  $('pollMinutes').value = cfg.pollMinutes;
  $('activePollSeconds').value = cfg.activePollSeconds;
  $('maxItems').value = cfg.maxItems;
  $('gmailQuery').value = cfg.gmailQuery;
  $('hudHeight').value = cfg.hudHeight;
  $('hudOpacity').value = Math.round(cfg.hudOpacity * 100);
  for (const fn of Object.values(paint)) fn();

  for (const key of ['showGmail', 'showSlack', 'showCalendar', 'showMemory', 'showMemoryColumn',
                     'launchAtLogin', 'slackOpenInBrowser', 'pinned', 'expanded', 'hoverPeek', 'showInTaskbar', 'vertical']) {
    $(key).checked = !!cfg[key];
  }

  $('googleClientId').value = cfg.google.clientId || '';
  $('googleClientSecret').placeholder = cfg.google.hasClientSecret
    ? 'saved - leave blank to keep it'
    : 'from your Desktop app OAuth client';

  const gBadge = $('googleBadge');
  gBadge.textContent = cfg.google.connected ? (cfg.google.email || 'Connected') : 'Not connected';
  gBadge.classList.toggle('on', !!cfg.google.connected);
  $('googleConnect').textContent = cfg.google.connected ? 'Reconnect' : 'Sign in with Google';
  $('googleDisconnect').hidden = !cfg.google.connected;

  const sBadge = $('slackBadge');
  sBadge.textContent = cfg.slack.connected ? (cfg.slack.teamName || 'Connected') : 'Not connected';
  sBadge.classList.toggle('on', !!cfg.slack.connected);
  $('slackToken').placeholder = cfg.slack.connected ? 'saved - paste a new token to replace it' : 'xoxp-...';
  $('slackDisconnect').hidden = !cfg.slack.connected;

  $('configPath').textContent = cfg.configPath;
  $('encryptionNote').textContent = cfg.encryptionAvailable
    ? 'Tokens are encrypted at rest with your operating system keychain.'
    : 'Warning: no OS keychain is available, so tokens will not be saved between launches.';

  await renderDisks();
}

// Surface poll errors here too, so a broken connection is visible where you fix it.
window.hud.onState((s) => {
  if (s.gmail && s.gmail.error) setStatus('googleStatus', s.gmail.error, 'err');
  if (s.slack && s.slack.error) setStatus('slackStatus', s.slack.error, 'err');
});

refresh();
