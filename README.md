# WorkHUD

A floating desktop HUD for work email, Slack and memory pressure. Runs on
Windows and macOS from the same source.

Two modes:

- **Collapsed** — a single bar showing unread counts and the newest item from each source.
- **Expanded** — mail and Slack side by side in two columns, both refreshing on the
  same timer.

Memory lives in a narrow vertical rail on the right edge, which reads
bottom-to-top. Clicking the rail opens a detail panel with system memory, free
space on every drive, and the heaviest processes.
While collapsed, hovering the **top bar** previews the dashboard, and leaving the
bar closes it again immediately. The preview is a glance: to interact with it,
click the chevron or the rail to expand properly. A peek never overwrites the
mode you chose, nor the saved window size.

It runs either way up: a bar across the top of a wide window with the columns
side by side, or — with **Stand the bar on its end** in Settings — a narrow strip
down the left with the columns stacked. Collapsing and peeking then grow the
window sideways rather than downward.

Drag it anywhere, resize it from any edge, pin it on top or let it fall behind.
Position, size and mode are remembered per orientation; switching orientation
starts from a fresh default, because bounds saved for one are nonsense in the
other.

## Running it

```bash
npm install
npm start
```

Node 18+ is required for `npm install`; the app itself runs on the Node that
ships inside Electron.

To build an installer for the machine you are on:

```bash
npm run dist
```

Cross-building a signed macOS app from Windows is not possible — run
`npm run dist:mac` on the MacBook.

## The window

| Control | What it does |
| --- | --- |
| The bar, or any column heading | Drag to move the window |
| Any edge or corner (expanded) | Resize |
| ▼ / ▲ | Expand to the two-column dashboard, or collapse back to the bar |
| Pin | Keep the window above everything else |
| ↻ | Refresh now |
| ⚙ | Settings |
| Memory rail (right edge) | Click to open the memory detail panel; hover for a summary |
| Hovering the bar, while collapsed | Previews the dashboard; closes as soon as you leave the bar (Settings can turn this off) |

The bar itself is the title bar, so the counts and previews on it are readouts
rather than buttons — that is what keeps the whole width grabbable.

The tray icon has the same controls plus **Reset window position**, which is the
way back if the window ends up off-screen.

## Connecting Gmail

Google's API needs an OAuth client that belongs to you. Once, in the browser:

1. [console.cloud.google.com](https://console.cloud.google.com/) → create a project.
2. **APIs & Services → Library** → enable **Gmail API**.
3. **OAuth consent screen** → *Internal* if your work account allows it, otherwise
   *External* with your own address under **Test users**.
4. **Credentials → Create credentials → OAuth client ID** → application type
   **Desktop app**. A *Web application* client will not work.
5. Paste the client ID and secret into Settings, then **Sign in with Google**.

Sign-in happens in your real browser, so your existing Google session applies.
The scope requested is `gmail.readonly` — WorkHUD cannot send or delete anything.

## Connecting Slack

**Slack does not accept Google as a login for API access.** You authenticate to
Slack in the browser (where your Google SSO applies), Slack issues its own token,
and you paste that in once:

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**.
2. **OAuth & Permissions** → add these under **User Token Scopes** (not *Bot* Token Scopes):
   `channels:history`, `groups:history`, `im:history`, `mpim:history`,
   `channels:read`, `groups:read`, `im:read`, `mpim:read`, `users:read`, `search:read`
3. **Install to Workspace** and approve. If your workspace requires admin approval
   for apps, the request goes to your Slack admin here.
4. Copy the **User OAuth Token** — it starts with `xoxp-`, not `xoxb-`.
5. Paste it into Settings → Connect.

`search:read` is only used to pick up channel mentions and is skipped
automatically on plans without search.

### What "new" means in Slack

The Web API has no cheap unread endpoint for third-party tokens, so WorkHUD keeps
its own last-seen timestamp per conversation. "New" therefore means *since you
last pressed Mark all seen*, not Slack's own unread badge. On first run it only
looks back 24 hours rather than dumping history at you.

## Calendar

A narrow column between mail and Slack in the expanded dashboard, three
stacked panels: a countdown to your next meeting, the meeting itself, then
the one after that. It shares the Gmail sign-in - no separate connection -
but needs the `calendar.readonly` scope, which is only present on tokens
issued after this existed. An older connection will ask you to sign in again
once; that is the new permission being granted, not a broken connection.

## Polling, not push

Both sources are polled, so nothing appears sooner than the next check:

- **Collapsed:** every `pollMinutes` (default 3).
- **Expanded:** every `activePollSeconds` (default 60) — a window you are watching
  earns a faster cadence.
- **Peeking:** no extra polling unless the data is already older than
  `activePollSeconds`, in which case one refresh fires.
- **Memory:** sampled locally every 5 seconds regardless.

Don't push the expanded interval below about 30 seconds. Each Slack check costs
roughly one API call per conversation and Slack throttles at around 50 a minute.

## Memory and disk numbers

Everything is expressed as **headroom**, not consumption: the figures are free
space and free percentage, and every meter reads as a fuel gauge that drains as
you run out. Colour follows how little is left — amber under 25% free, red under
10%.

Disk space comes from `fs.statfs`, which needs no shell-out and works the same on
both platforms. Windows drives are found by probing letters (a drive that is not
mounted simply throws and is skipped); macOS reads `/` plus anything in
`/Volumes`. Settings has a tick box per drive, and leaving them all ticked means
a drive plugged in later shows up on its own.

`os.freemem()` means different things per platform, so each gets a real reading:

- **macOS** — parsed from `vm_stat`, mirroring Activity Monitor's *Memory Used*
  (app memory + wired + compressed). Plain `freemem()` would report ~95% used on an idle Mac.
- **Linux** — `MemAvailable` from `/proc/meminfo`.
- **Windows** — `os.freemem()`, which is already close to "available".

Per-process figures come from `tasklist` on Windows and `ps` elsewhere, summed by
name so a browser's fifty processes appear once.

Processes and disks are only sampled on the slow poll, while memory itself
refreshes every 5 seconds. `sample()` therefore **omits** those keys rather than
setting them to `undefined`: the caller merges each reading over the last one,
and an explicit `undefined` overwrites, which is what once made the process list
appear on every poll and vanish five seconds later. The panel also updates its
numbers in place rather than rebuilding its DOM, for the same reason.

## Where things live

```
main.js              window, tray, polling, IPC
preload.js           the only renderer bridge - a fixed list of calls, no Node
src/config.js        settings; secrets encrypted via safeStorage (DPAPI / Keychain)
src/oauth-loopback.js  throwaway 127.0.0.1 server for the OAuth redirect
src/sources/         google.js, slack.js, memory.js
renderer/            hud.* (the window), settings.* (the settings screen)
tools/make-icons.js  generates the tray PNGs, so no binaries are committed
tools/preview.js     writes renderer/preview.html for designing without live accounts
```

Settings and tokens are stored per-user:

- Windows — `%APPDATA%\WorkHUD\config.json`
- macOS — `~/Library/Application Support/WorkHUD/config.json`

Tokens are encrypted at rest with the OS keychain. If no keychain is available
the app still runs but refuses to write secrets in the clear, and says so.

## Previewing the UI without accounts

```bash
npm run icons && node tools/preview.js
```

Then serve the folder and open `renderer/preview.html` (add `#compact` for the
collapsed bar). It loads `preview-stub.js` in place of the preload bridge with
representative fake data — useful for design work.

## Debugging

`WORKHUD_DEBUG=1` makes the main process log hover-peek edges and every window
resize (requested size versus what the OS actually gave back). That second
number matters on Windows: `setBounds` is silently ignored on a non-resizable
window, which is why `applyWindowMode` re-enables resizing before it moves
anything and locks it again afterwards.

## Notes

- Renderers run with `contextIsolation` on, no Node integration, and a strict CSP.
  All remote text is inserted with `textContent`, never `innerHTML`.
- `openExternal` only accepts `https:`, `http:`, `slack:` and `mailto:`.
- If your taskbar auto-hides, Windows reports the work area as the whole screen,
  so a window parked at the very bottom will be overlapped when the taskbar
  slides up. Move the window up a little, or turn auto-hide off.
