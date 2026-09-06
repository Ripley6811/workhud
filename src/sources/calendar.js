// Google Calendar. Shares the Gmail OAuth client and token - no separate
// sign-in - but needs the calendar.readonly scope, which is only present on
// tokens issued after that scope was added to google.js. An older token will
// fail here with insufficient scope; that surfaces as needsReconsent so the
// UI can point back at "Sign in with Google" rather than a raw error.
const config = require('../config');
const google = require('./google');

const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

function startOf(ev) {
  const dt = ev.start?.dateTime;
  if (dt) return { ms: Date.parse(dt), allDay: false };
  // All-day events carry a bare date; treat it as local midnight so it still
  // sorts correctly against timed events without a fabricated countdown.
  if (ev.start?.date) return { ms: new Date(`${ev.start.date}T00:00:00`).getTime(), allDay: true };
  return { ms: Infinity, allDay: false };
}

function summarize(ev) {
  const { ms, allDay } = startOf(ev);
  const endDt = ev.end?.dateTime || (ev.end?.date ? `${ev.end.date}T00:00:00` : null);
  return {
    id: ev.id,
    title: ev.summary || '(no title)',
    startMs: ms,
    endMs: endDt ? Date.parse(endDt) : ms,
    allDay,
    location: ev.location || '',
    attendeeCount: (ev.attendees || []).length,
    url: ev.htmlLink || '',
  };
}

async function fetch_() {
  const cfg = config.load();
  if (!cfg.google.tokens) return { ok: false, needsSetup: true, error: 'Not connected', next: null, following: null };

  let token;
  try {
    token = await google.accessToken();
  } catch (e) {
    return { ok: false, needsSetup: true, error: e.message, next: null, following: null };
  }

  const params = new URLSearchParams({
    timeMin: new Date().toISOString(),
    maxResults: '10',
    singleEvents: 'true',
    orderBy: 'startTime',
  });
  const res = await fetch(`${EVENTS_URL}?${params}`, { headers: { Authorization: `Bearer ${token}` } });

  if (res.status === 403 || res.status === 401) {
    const body = await res.json().catch(() => ({}));
    const msg = body.error?.message || '';
    // A token from before calendar.readonly was added still authenticates
    // fine for Gmail, so this only ever shows up here, not as a sign-in error.
    if (/insufficient|scope/i.test(msg) || res.status === 403) {
      return {
        ok: false, needsReconsent: true,
        error: 'Calendar access needs a fresh sign-in (new permission added).',
        next: null, following: null,
      };
    }
    return { ok: false, error: msg || `HTTP ${res.status}`, next: null, following: null };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: false, error: body.error?.message || `HTTP ${res.status}`, next: null, following: null };
  }

  const body = await res.json();
  const events = (body.items || [])
    .filter((e) => e.status !== 'cancelled')
    .map(summarize)
    .filter((e) => Number.isFinite(e.startMs))
    .sort((a, b) => a.startMs - b.startMs);

  return { ok: true, next: events[0] || null, following: events[1] || null };
}

module.exports = { fetch: fetch_ };
