// Development only: derive renderer/preview.html from hud.html by injecting the
// stub bridge ahead of hud.js, so the HUD can be opened in a normal browser.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'renderer');
const src = fs.readFileSync(path.join(dir, 'hud.html'), 'utf8');

// Every regeneration gets its own cache-busting query on every local asset.
// A plain `<script src>`/`<link href>` was silently served stale by the
// browser across regenerations more than once - the page itself reloading
// with a new URL query doesn't make the browser re-fetch its script/style
// sub-resources, only navigations do that reliably.
const bust = Date.now();
const out = src
  .replace('<title>WorkHUD</title>', '<title>WorkHUD preview</title>')
  .replace('href="hud.css"', `href="hud.css?b=${bust}"`)
  .replace('<script src="hud.js"></script>',
           `<script src="preview-stub.js?b=${bust}"></script>\n  <script src="hud.js?b=${bust}"></script>`);

if (out === src) {
  console.error('[preview] could not find the hud.js script tag in hud.html');
  process.exit(1);
}
fs.writeFileSync(path.join(dir, 'preview.html'), out);
console.log('[preview] wrote renderer/preview.html — open it with #gmail, #slack or #memory');
