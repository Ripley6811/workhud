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
  if (!cfg.google.tokens) return { ok: false, needsSetup: true, error: 'Not connected', upcoming: [] };

  let token;
  try {
    token = await google.accessToken();
  } catch (e) {
    return { ok: false, needsSetup: true, error: e.message, upcoming: [] };
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
    // Google Calendar returns 403 for two unrelated problems, and only one of
    // them is fixed by signing in again:
    //   - a token from before calendar.readonly was added: "insufficient
    //     authentication scopes" / "insufficient permission"
    //   - the Calendar API simply isn't enabled on this Cloud project: "has
    //     not been used in project ... or it is disabled" (reason
    //     accessNotConfigured) - re-consenting changes nothing here; the fix
    //     is enabling the API in Cloud Console, same as Gmail needed.
    // Treating every 403 as the first case (as this once did) hid the real
    // message for the second and told people to "sign in again" for
    // something sign-in cannot fix.
    if (/insufficient.{0,20}(scope|permission)/i.test(msg)) {
      return {
        ok: false, needsReconsent: true,
        error: 'Calendar access needs a fresh sign-in (new permission added).',
        upcoming: [],
      };
    }
    return { ok: false, error: msg || `HTTP ${res.status}`, upcoming: [] };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: false, error: body.error?.message || `HTTP ${res.status}`, upcoming: [] };
  }

  const body = await res.json();
  const events = (body.items || [])
    .filter((e) => e.status !== 'cancelled')
    .map(summarize)
    .filter((e) => Number.isFinite(e.startMs))
    .sort((a, b) => a.startMs - b.startMs);

  // The UI shows up to 4 panels; fetch a couple extra so back-to-back or
  // just-ended events don't leave a panel empty when one gets filtered out.
  return { ok: true, upcoming: events.slice(0, 6) };
}

module.exports = { fetch: fetch_ };
