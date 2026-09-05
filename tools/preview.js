// Development only: derive renderer/preview.html from hud.html by injecting the
// stub bridge ahead of hud.js, so the HUD can be opened in a normal browser.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'renderer');
const src = fs.readFileSync(path.join(dir, 'hud.html'), 'utf8');
const out = src
  .replace('<title>WorkHUD</title>', '<title>WorkHUD preview</title>')
  .replace('<script src="hud.js"></script>',
           '<script src="preview-stub.js"></script>\n  <script src="hud.js"></script>');

if (out === src) {
  console.error('[preview] could not find the hud.js script tag in hud.html');
  process.exit(1);
}
fs.writeFileSync(path.join(dir, 'preview.html'), out);
console.log('[preview] wrote renderer/preview.html — open it with #gmail, #slack or #memory');
