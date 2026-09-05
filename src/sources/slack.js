// Slack via a user OAuth token (xoxp-...).
//
// Slack does not federate to Google for API access: you authenticate to Slack in
// the browser (where your Google SSO applies), Slack issues its own token, and we
// store that. See README for the five-step app setup.
//
// Unread state: Slack's Web API has no cheap "what's unread" endpoint for
// third-party tokens, so we track a last-seen timestamp per conversation
// ourselves. "New" therefore means "since you last looked at the HUD".
const config = require('../config');

const API = 'https://slack.com/api';
const userCache = new Map();

async function call(method, token, params = {}) {
  const url = `${API}/${method}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Slack ${method}: HTTP ${res.status}`);
  if (!body.ok) {
    const err = new Error(`Slack ${method}: ${body.error || 'unknown error'}`);
    err.slackError = body.error;
    if (body.error === 'missing_scope') err.message += ` (needs ${body.needed || 'more scopes'})`;
    throw err;
  }
  return body;
}

// Run promise-returning tasks a few at a time so a big DM list cannot burst
// through Slack's rate limits.
async function pooled(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx]); } catch { out[idx] = null; }
    }
  }));
  return out.filter(Boolean);
}

async function userName(id, token) {
  if (!id) return 'someone';
  if (userCache.has(id)) return userCache.get(id);
  try {
    const { user } = await call('users.info', token, { user: id });
    const name = user.profile?.display_name || user.profile?.real_name || user.name || id;
    userCache.set(id, name);
    return name;
  } catch {
    return id;
  }
}

async function connect(token) {
  const trimmed = (token || '').trim();
  if (!trimmed) throw new Error('Paste your Slack user token first.');
  if (!trimmed.startsWith('xoxp-')) {
    throw new Error('That does not look like a user token. It must start with "xoxp-" — the bot token (xoxb-) will not show your DMs.');
  }
  const who = await call('auth.test', trimmed);
  config.save({
    slack: {
      token: trimmed,
      teamName: who.team || '',
      teamId: who.team_id || '',
      userId: who.user_id || '',
      userName: who.user || '',
      seen: {},
    },
  });
  return { teamName: who.team, userName: who.user };
}

function disconnect() {
  config.save({ slack: { token: '', teamName: '', teamId: '', userId: '', userName: '', seen: {} } });
}

function markAllSeen(items) {
  const seen = { ...config.load().slack.seen };
  for (const it of items || []) {
    if (!it.channel) continue;
    seen[it.channel] = Math.max(Number(seen[it.channel]) || 0, Number(it.ts) || 0);
  }
  config.save({ slack: { seen } });
}

async function fetch_() {
  const cfg = config.load();
  const { token, userId, teamId } = cfg.slack;
  if (!token) return { ok: false, needsSetup: true, error: 'Not connected', count: 0, items: [] };

  const me = userId || (await call('auth.test', token)).user_id;
  const { channels } = await call('users.conversations', token, {
    types: 'im,mpim',
    exclude_archived: 'true',
    limit: '100',
  });

  const seen = cfg.slack.seen || {};
  const firstRunFloor = (Date.now() - 24 * 3600 * 1000) / 1000; // don't dump history on day one
  const targets = channels.slice(0, cfg.slackMaxChannels || 25);

  const perChannel = await pooled(targets, 4, async (ch) => {
    const { messages } = await call('conversations.history', token, { channel: ch.id, limit: '5' });
    const floor = Number(seen[ch.id]) || firstRunFloor;
    const fresh = (messages || []).filter((m) =>
      Number(m.ts) > floor && m.user !== me && !m.subtype && (m.text || m.files));
    if (!fresh.length) return null;
    const imName = ch.is_im ? await userName(ch.user, token) : null;
    return Promise.all(fresh.map(async (m) => ({
      channel: ch.id,
      ts: m.ts,
      from: imName || await userName(m.user, token),
      where: ch.is_im ? 'DM' : 'Group DM',
      text: (m.text || '(attachment)').replace(/\s+/g, ' ').slice(0, 200),
      tsMs: Number(m.ts) * 1000,
    })));
  });

  let items = perChannel.flat();

  // Channel mentions are a bonus: search.messages needs search:read and is not
  // available on every plan, so a failure here must not sink the whole poll.
  try {
    const { messages } = await call('search.messages', token, {
      query: `<@${me}>`, sort: 'timestamp', sort_dir: 'desc', count: String(cfg.maxItems),
    });
    for (const m of messages?.matches || []) {
      const chId = m.channel?.id;
      if (Number(m.ts) <= (Number(seen[chId]) || firstRunFloor)) continue;
      items.push({
        channel: chId,
        ts: m.ts,
        from: m.username || m.user || 'someone',
        where: `#${m.channel?.name || 'channel'}`,
        text: (m.text || '').replace(/\s+/g, ' ').slice(0, 200),
        tsMs: Number(m.ts) * 1000,
        mention: true,
      });
    }
  } catch (e) {
    if (!['missing_scope', 'not_allowed_token_type', 'plan_upgrade_required'].includes(e.slackError)) throw e;
  }

  items.sort((a, b) => b.tsMs - a.tsMs);
  items = items.slice(0, cfg.maxItems);

  const team = teamId || (await call('auth.test', token)).team_id;
  for (const it of items) {
    it.url = cfg.slackOpenInBrowser
      ? `https://app.slack.com/client/${team}/${it.channel}`
      : `slack://channel?team=${team}&id=${it.channel}&message=${it.ts}`;
  }

  return { ok: true, count: items.length, items, account: cfg.slack.teamName };
}

module.exports = { connect, disconnect, markAllSeen, fetch: fetch_ };
