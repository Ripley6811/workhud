// Loopback-redirect OAuth for a desktop app: spin up a throwaway HTTP server on
// 127.0.0.1, send the user to the provider in their real browser (so existing
// SSO sessions apply), and catch the redirect back.
const http = require('http');
const crypto = require('crypto');
const { shell } = require('electron');

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function pkce() {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function page(title, body, ok) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px/1.6 -apple-system,Segoe UI,system-ui,sans-serif;background:#12141a;color:#e6e9ef;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.c{text-align:center;max-width:32rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem;color:${ok ? '#5fd08a' : '#ff7a7a'}}
p{margin:0;color:#a5adbb}</style>
<div class="c"><h1>${title}</h1><p>${body}</p></div>`;
}

/**
 * @param {object} opts
 * @param {(redirectUri:string, state:string, challenge:string)=>string} opts.buildAuthUrl
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{code:string, redirectUri:string, verifier:string}>}
 */
function authorize({ buildAuthUrl, timeoutMs = 5 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const state = b64url(crypto.randomBytes(16));
    const { verifier, challenge } = pkce();
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      fn(arg);
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const err = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const gotState = url.searchParams.get('state');

      if (err) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
           .end(page('Sign-in cancelled', 'You can close this tab and try again from WorkHUD settings.', false));
        return finish(reject, new Error(`Authorisation denied: ${err}`));
      }
      if (gotState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
           .end(page('Sign-in failed', 'The security check did not match. Close this tab and try again.', false));
        return finish(reject, new Error('OAuth state mismatch — request rejected'));
      }
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
           .end(page('Sign-in failed', 'No authorisation code came back.', false));
        return finish(reject, new Error('No authorisation code in redirect'));
      }
      res.writeHead(200, { 'Content-Type': 'text/html' })
         .end(page('Connected', 'WorkHUD is signed in. You can close this tab.', true));
      finish(resolve, { code, redirectUri: `http://127.0.0.1:${server.address().port}/callback`, verifier });
    });

    const timer = setTimeout(
      () => finish(reject, new Error('Timed out waiting for sign-in')),
      timeoutMs
    );

    server.on('error', (e) => finish(reject, e));
    // Port 0 = let the OS pick a free one.
    server.listen(0, '127.0.0.1', () => {
      const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      shell.openExternal(buildAuthUrl(redirectUri, state, challenge))
        .catch((e) => finish(reject, e));
    });
  });
}

module.exports = { authorize };
