// Gmail via Google OAuth 2.0 (desktop / installed-app flow with PKCE).
const config = require('../config');
const { authorize } = require('../oauth-loopback');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'].join(' ');

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error_description || body.error || `HTTP ${res.status} from ${url}`);
  }
  return body;
}

async function signIn() {
  const { clientId, clientSecret } = config.load().google;
  if (!clientId) throw new Error('Add your Google OAuth client ID in Settings first.');

  const { code, redirectUri, verifier } = await authorize({
    buildAuthUrl: (redirect, state, challenge) => {
      const p = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        response_type: 'code',
        scope: SCOPES,
        access_type: 'offline',
        prompt: 'consent',          // force a refresh_token even on re-auth
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      return `${AUTH_URL}?${p}`;
    },
  });

  const tok = await postForm(TOKEN_URL, {
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });

  const tokens = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + (tok.expires_in || 3600) * 1000,
  };
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh token. Revoke WorkHUD at myaccount.google.com/permissions and connect again.');
  }

  let email = '';
  try {
    const who = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } })
      .then((r) => r.json());
    email = who.email || '';
  } catch { /* non-fatal */ }

  config.save({ google: { tokens, email } });
  return { email };
}

function signOut() {
  config.save({ google: { tokens: null, email: '' } });
}

async function accessToken() {
  const g = config.load().google;
  if (!g.tokens || !g.tokens.refresh_token) throw new Error('Not connected to Google');
  if (g.tokens.access_token && Date.now() < g.tokens.expires_at - 60_000) return g.tokens.access_token;

  const tok = await postForm(TOKEN_URL, {
    client_id: g.clientId,
    ...(g.clientSecret ? { client_secret: g.clientSecret } : {}),
    refresh_token: g.tokens.refresh_token,
    grant_type: 'refresh_token',
  });
  const tokens = {
    access_token: tok.access_token,
    // Google usually omits refresh_token on refresh — keep the one we have.
    refresh_token: tok.refresh_token || g.tokens.refresh_token,
    expires_at: Date.now() + (tok.expires_in || 3600) * 1000,
  };
  config.save({ google: { tokens } });
  return tokens.access_token;
}

async function api(pathAndQuery, token) {
  const res = await fetch(`${GMAIL}${pathAndQuery}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = body.error?.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function headerOf(msg, name) {
  const h = msg.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function displayName(from) {
  // `"Jane Doe" <jane@x.com>` -> `Jane Doe`; bare address -> local part.
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m && m[1].trim()) return m[1].trim();
  const addr = (m ? m[2] : from).trim();
  return addr.split('@')[0] || addr;
}

async function fetch_() {
  const cfg = config.load();
  if (!cfg.google.tokens) return { ok: false, needsSetup: true, error: 'Not connected', count: 0, items: [] };

  const token = await accessToken();
  const query = cfg.gmailQuery;
  const list = await api(`/messages?q=${encodeURIComponent(query)}&maxResults=${cfg.maxItems}`, token);

  let count = list.resultSizeEstimate || 0;
  if (query === config.DEFAULTS.gmailQuery) {
    // Exact unread count is cheaper and more accurate off the label itself.
    try {
      const label = await api('/labels/INBOX', token);
      if (typeof label.messagesUnread === 'number') count = label.messagesUnread;
    } catch { /* fall back to the estimate */ }
  }

  const ids = (list.messages || []).slice(0, cfg.maxItems);
  const items = await Promise.all(ids.map(async ({ id }) => {
    const m = await api(
      `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      token
    );
    return {
      id,
      from: displayName(headerOf(m, 'From')),
      subject: headerOf(m, 'Subject') || '(no subject)',
      snippet: m.snippet || '',
      ts: Number(m.internalDate) || Date.parse(headerOf(m, 'Date')) || Date.now(),
      url: `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(cfg.google.email)}#all/${m.threadId}`,
    };
  }));

  items.sort((a, b) => b.ts - a.ts);
  return { ok: true, count, items, account: cfg.google.email };
}

module.exports = { signIn, signOut, fetch: fetch_ };
