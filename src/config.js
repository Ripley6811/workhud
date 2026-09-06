// Persistent settings. Secrets (OAuth tokens, client secrets, Slack token) are
// encrypted at rest with Electron's safeStorage, which is DPAPI on Windows and
// the Keychain on macOS. If safeStorage is unavailable we still run, but we
// refuse to write secrets in the clear and say so.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const SECRET_KEYS = [
  'google.clientSecret', 'google.tokens',
  'slack.clientSecret', 'slack.token',
];

const DEFAULTS = {
  pollMinutes: 3,           // cadence while collapsed
  activePollSeconds: 60,    // faster cadence while the dashboard is open
  showGmail: true,
  showSlack: true,
  showMemory: true,
  showCalendar: true,
  showMemoryColumn: false,  // the rail's detail panel, opened by clicking it
  diskFilter: [],           // drives to list; empty means every one found
  gmailQuery: 'is:unread in:inbox',
  maxItems: 25,
  slackMaxChannels: 25,
  slackOpenInBrowser: false,
  hudHeight: 44,            // thickness of the bar, whichever way it runs
  hudOpacity: 0.97,
  expanded: false,
  vertical: false,          // stand the bar on its end against a screen edge
  hoverPeek: true,          // collapsed, hovering the bar peeks the dashboard open
  pinned: true,
  showInTaskbar: true,      // taskbar button on Windows, Dock icon on macOS
  bounds: null,             // {x,y,width,height} of the expanded window; null = pick a default
  launchAtLogin: false,
  google: { clientId: '', clientSecret: '', tokens: null, email: '' },
  slack: { token: '', teamName: '', teamId: '', userId: '', userName: '', seen: {} },
};

let cache = null;
let filePath = null;

function file() {
  if (!filePath) filePath = path.join(app.getPath('userData'), 'config.json');
  return filePath;
}

function canEncrypt() {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

function get(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function set(obj, dotted, value) {
  const parts = dotted.split('.');
  const last = parts.pop();
  const target = parts.reduce((o, k) => (o[k] = o[k] || {}), obj);
  target[last] = value;
}

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && base[k] !== null
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

function encodeSecrets(plain) {
  const out = JSON.parse(JSON.stringify(plain));
  if (!canEncrypt()) {
    // Never persist a secret unencrypted. Blank them and flag it.
    for (const key of SECRET_KEYS) set(out, key, get(DEFAULTS, key));
    out._secretsDropped = true;
    return out;
  }
  for (const key of SECRET_KEYS) {
    const v = get(plain, key);
    if (v === undefined || v === null || v === '' ) continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    set(out, key, { __enc: safeStorage.encryptString(s).toString('base64') });
  }
  return out;
}

function decodeSecrets(stored) {
  const out = JSON.parse(JSON.stringify(stored));
  for (const key of SECRET_KEYS) {
    const v = get(stored, key);
    if (!v || typeof v !== 'object' || !v.__enc) continue;
    try {
      const s = safeStorage.decryptString(Buffer.from(v.__enc, 'base64'));
      // Token bundles are JSON; client secrets are plain strings.
      set(out, key, key.endsWith('tokens') ? JSON.parse(s) : s);
    } catch {
      set(out, key, get(DEFAULTS, key)); // wrong machine / rotated key
    }
  }
  return out;
}

function load() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch { /* first run */ }
  cache = deepMerge(DEFAULTS, decodeSecrets(stored));
  return cache;
}

function save(partial) {
  const next = deepMerge(load(), partial || {});
  const clamp = (v, lo, hi, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  next.pollMinutes = clamp(next.pollMinutes, 1, 60, DEFAULTS.pollMinutes);
  next.activePollSeconds = clamp(next.activePollSeconds, 15, 600, DEFAULTS.activePollSeconds);
  next.maxItems = Math.round(clamp(next.maxItems, 1, 100, DEFAULTS.maxItems));
  next.hudHeight = Math.round(clamp(next.hudHeight, 28, 120, DEFAULTS.hudHeight));
  next.hudOpacity = clamp(next.hudOpacity, 0.3, 1, DEFAULTS.hudOpacity);
  cache = next;
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(encodeSecrets(next), null, 2), { mode: 0o600 });
  return cache;
}

// What the settings window is allowed to see: never ship secrets to a renderer,
// only whether each one is present.
function redacted() {
  const c = load();
  return {
    ...c,
    google: {
      clientId: c.google.clientId,
      hasClientSecret: !!c.google.clientSecret,
      connected: !!(c.google.tokens && c.google.tokens.refresh_token),
      email: c.google.email,
      clientSecret: undefined, tokens: undefined,
    },
    slack: {
      connected: !!c.slack.token,
      teamName: c.slack.teamName,
      userName: c.slack.userName,
      token: undefined, seen: undefined,
    },
    encryptionAvailable: canEncrypt(),
    configPath: file(),
  };
}

module.exports = { load, save, redacted, canEncrypt, DEFAULTS };
