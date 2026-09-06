const path = require('path');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen, shell,
  nativeImage, powerMonitor, dialog,
} = require('electron');

const config = require('./src/config');
const google = require('./src/sources/google');
const slack = require('./src/sources/slack');
const memory = require('./src/sources/memory');
const calendar = require('./src/sources/calendar');

const isMac = process.platform === 'darwin';

let hud = null;
let settings = null;
let tray = null;
let pollTimer = null;
let memTimer = null;
let saveBoundsTimer = null;
// A peek is a temporary expand driven by the mouse. It deliberately does not
// touch cfg.expanded, so whatever mode you chose survives it.
//
// Hover has to be detected from the real cursor position rather than DOM events:
// the bar is a -webkit-app-region drag handle, and drag regions swallow mouse
// events before the page sees them, so a renderer-side mouseenter only ever
// fired over the few no-drag buttons.
const HOVER_TICK_MS = 60;
let peeking = false;
// Set when you deliberately collapse. Without it the pointer is still on the bar,
// so hover-peek would reopen instantly and the click would look like it had done
// nothing. Cleared as soon as the pointer leaves the bar.
let peekSuppressed = false;
let hoverTimer = null;
let hoverLogged = null; // WORKHUD_DEBUG only: log edges, not every tick
let windowHovered = false; // cursor anywhere over the window, not just the bar


const state = {
  gmail: { ok: false, count: 0, items: [], error: null, needsSetup: true },
  slack: { ok: false, count: 0, items: [], error: null, needsSetup: true },
  calendar: { ok: false, upcoming: [], error: null, needsSetup: true },
  memory: { ok: false, pct: 0, used: 0, total: 0, history: [] },
  lastPoll: 0,
  polling: false,
};

/* ------------------------------------------------------------------ window */

// Where the window sits when it has never been placed: a wide, short dashboard
// resting near the bottom of the primary screen, but free to be dragged anywhere.
function defaultBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  if (config.load().vertical) {
    // Standing on its end: tall and narrow, resting against the left edge.
    const height = Math.min(820, Math.max(320, wa.height - 120));
    const width = 420;
    return {
      x: wa.x + 60,
      y: wa.y + Math.round((wa.height - height) / 2),
      width,
      height,
    };
  }
  const width = Math.min(1180, Math.max(640, wa.width - 160));
  const height = 380;
  return {
    x: wa.x + Math.round((wa.width - width) / 2),
    y: wa.y + Math.max(0, wa.height - height - 80),
    width,
    height,
  };
}

function storedBounds() {
  const b = config.load().bounds;
  if (!b || !Number.isFinite(b.width) || !Number.isFinite(b.height)) return defaultBounds();
  return { ...b };
}

// Collapsed, the window is just the bar; expanded, it is whatever size the user
// last dragged it to. Either way the top-left corner stays put.
function applyWindowMode() {
  if (!hud || hud.isDestroyed()) return;
  const cfg = config.load();
  const b = storedBounds();
  const open = cfg.expanded || peeking;
  // The window grows away from its top-left corner - downward when the bar runs
  // across, rightward when it stands on end - so the bar stays put under the
  // pointer. Clamp to the screen it is on, or a bar parked against an edge would
  // open off the side of it.
  const area = screen.getDisplayMatching(
    { x: b.x, y: b.y, width: cfg.hudHeight, height: cfg.hudHeight }
  ).workArea;
  const roomRight = Math.max(cfg.hudHeight, area.x + area.width - b.x - 8);
  const roomBelow = Math.max(cfg.hudHeight, area.y + area.height - b.y - 8);

  const width = cfg.vertical
    ? (open ? Math.min(b.width, roomRight) : cfg.hudHeight)
    : b.width;
  const height = cfg.vertical
    ? Math.min(b.height, roomBelow)
    : (open ? Math.min(b.height, roomBelow) : cfg.hudHeight);

  // Windows ignores setBounds on a non-resizable window, so the resize has to
  // happen while the window still allows it. Getting this order wrong makes
  // collapsing look like a dead click: the state changes, the window does not.
  hud.setResizable(true);
  hud.setMinimumSize(
    cfg.vertical ? cfg.hudHeight : 420,
    cfg.vertical ? 240 : cfg.hudHeight
  );
  hud.setBounds({ x: b.x, y: b.y, width, height });
  hud.setResizable(cfg.expanded); // a peek is transient, so not resizable
  if (process.env.WORKHUD_DEBUG) {
    console.log('[mode] want', b.width + 'x' + height, 'open', open,
      'got', JSON.stringify(hud.getBounds()));
  }
  hud.setSkipTaskbar(!cfg.showInTaskbar);
  // macOS has no taskbar; the Dock icon is the equivalent presence.
  if (isMac && app.dock) {
    if (cfg.showInTaskbar) app.dock.show(); else app.dock.hide();
  }
  hud.setAlwaysOnTop(!!cfg.pinned, 'floating');
  if (cfg.pinned) hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  else hud.setVisibleOnAllWorkspaces(false);
  hud.setOpacity(cfg.hudOpacity);
}

// Remember wherever the user drags or resizes to. Only the height is mode
// specific: collapsed height is the bar and must not overwrite the stored one.
function rememberBounds() {
  if (!hud || hud.isDestroyed() || hud.isMinimized()) return;
  clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    if (!hud || hud.isDestroyed()) return;
    const cfg = config.load();
    const now = hud.getBounds();
    const kept = storedBounds();
    // Only the axis the window opens along is mode specific; the other one is
    // whatever the user dragged. A peeked window is temporarily open, so its
    // size must never be written back as the collapsed one.
    const open = cfg.expanded && !peeking;
    config.save({
      bounds: {
        x: now.x,
        y: now.y,
        width: cfg.vertical ? (open ? now.width : kept.width) : now.width,
        height: cfg.vertical ? now.height : (open ? now.height : kept.height),
      },
    });
  }, 400);
}

function setPeek(on) {
  if (peeking === !!on) return;
  peeking = !!on;
  applyWindowMode();
  if (hud && !hud.isDestroyed()) hud.webContents.send('peek', peeking);
  // Peeking at stale data is the one case worth an off-schedule refresh, and the
  // user's own active interval keeps that from becoming a hammer.
  const cfg = config.load();
  if (peeking && Date.now() - state.lastPoll > cfg.activePollSeconds * 1000) poll('peek');
}

function checkHover() {
  if (!hud || hud.isDestroyed() || !hud.isVisible()) return;
  const cfg = config.load();
  const p = screen.getCursorScreenPoint();
  const b = hud.getBounds();

  // Whether the pointer is anywhere over the window at all, independent of
  // hover-peek or expanded/collapsed mode - the renderer uses this only to
  // know "the user looked", e.g. to stop a pulsing new-item dot the way a
  // phone's badge clears when you open the app. Computed unconditionally, so
  // it still works with hover-peek switched off or while expanded, unlike the
  // bar-only peek check below.
  const overWindow = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
  if (overWindow !== windowHovered) {
    windowHovered = overWindow;
    hud.webContents.send('hover', windowHovered);
  }

  if (!cfg.hoverPeek || cfg.expanded) { setPeek(false); return; }
  // Only the bar strip peeks, and it closes the moment you leave it. The
  // dashboard it reveals is a glance, not somewhere to wander into - clicking
  // is what makes it stay.
  const onBar = cfg.vertical
    ? (p.x >= b.x && p.x < b.x + cfg.hudHeight && p.y >= b.y && p.y < b.y + b.height)
    : (p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + cfg.hudHeight);

  if (process.env.WORKHUD_DEBUG && onBar !== hoverLogged) {
    hoverLogged = onBar;
    console.log('[hover]', onBar ? 'on bar' : 'off bar',
      'cursor', p.x, p.y, 'bar', b.x, b.y, b.width, cfg.hudHeight,
      'peeking', peeking, 'suppressed', peekSuppressed);
  }

  if (!onBar) { peekSuppressed = false; setPeek(false); return; }
  if (!peekSuppressed) setPeek(true);
}

function createHud() {
  const cfg = config.load();
  const b = storedBounds();

  hud = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: cfg.expanded ? b.height : cfg.hudHeight,
    minWidth: 420,
    minHeight: cfg.hudHeight,
    frame: false,
    // Opaque plus setOpacity, rather than a transparent window: transparent
    // frameless windows lose their OS resize border on Windows.
    transparent: false,
    backgroundColor: '#111319',
    resizable: cfg.expanded,
    movable: true,
    // Minimizable so the taskbar button behaves like every other app's when
    // the window is shown there.
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: !cfg.showInTaskbar,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false,
    ...(isMac ? { type: 'panel' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  hud.loadFile(path.join(__dirname, 'renderer', 'hud.html'));
  hud.once('ready-to-show', () => { applyWindowMode(); hud.show(); });
  hud.on('move', rememberBounds);
  hud.on('resize', rememberBounds);
  hud.on('closed', () => { hud = null; });
}

function createSettings() {
  if (settings && !settings.isDestroyed()) { settings.show(); settings.focus(); return; }
  settings = new BrowserWindow({
    width: 760,
    height: 820,
    minWidth: 600,
    minHeight: 520,
    title: 'WorkHUD Settings',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false,
    backgroundColor: '#12141a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  settings.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settings.once('ready-to-show', () => { settings.show(); settings.focus(); });
  settings.on('closed', () => { settings = null; });
}

/* -------------------------------------------------------------------- tray */

function trayIcon() {
  const name = isMac ? 'trayTemplate.png' : 'tray.png';
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', name));
  if (isMac) img.setTemplateImage(true);
  return img;
}

function buildTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('WorkHUD');
  const menu = Menu.buildFromTemplate([
    { label: 'Refresh now', click: () => poll('manual') },
    {
      label: 'Expand',
      type: 'checkbox',
      checked: config.load().expanded,
      click: (item) => {
        if (!item.checked) peekSuppressed = true;
        config.save({ expanded: item.checked });
        peeking = false;
        applyWindowMode();
        broadcast();
        schedulePoll();
      },
    },
    {
      label: 'Keep on top',
      type: 'checkbox',
      checked: config.load().pinned,
      click: (item) => { config.save({ pinned: item.checked }); applyWindowMode(); broadcast(); },
    },
    { type: 'separator' },
    { label: 'Reset window position', click: () => { config.save({ bounds: defaultBounds() }); applyWindowMode(); } },
    { label: 'Settings...', click: createSettings },
    { type: 'separator' },
    { label: 'Quit WorkHUD', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (!hud) return;
    if (hud.isVisible()) hud.hide(); else hud.show();
  });
}

/* ----------------------------------------------------------------- polling */

function broadcast() {
  for (const w of [hud, settings]) {
    if (w && !w.isDestroyed()) w.webContents.send('state', state);
  }
}

async function poll(reason = 'timer') {
  if (state.polling) return;
  state.polling = true;
  broadcast();

  const cfg = config.load();
  const jobs = [];

  jobs.push(
    (cfg.showGmail
      ? google.fetch().catch((e) => ({ ok: false, count: 0, items: [], error: e.message }))
      : Promise.resolve({ ok: false, disabled: true, count: 0, items: [] })
    ).then((r) => { state.gmail = r; })
  );

  jobs.push(
    (cfg.showSlack
      ? slack.fetch().catch((e) => ({ ok: false, count: 0, items: [], error: e.message }))
      : Promise.resolve({ ok: false, disabled: true, count: 0, items: [] })
    ).then((r) => { state.slack = r; })
  );

  jobs.push(
    (cfg.showCalendar
      ? calendar.fetch().catch((e) => ({ ok: false, upcoming: [], error: e.message }))
      : Promise.resolve({ ok: false, disabled: true, upcoming: [] })
    ).then((r) => { state.calendar = r; })
  );

  jobs.push(
    memory.sample({ withDetail: true, processCount: cfg.processCount })
      .then((r) => { state.memory = r; })
      .catch((e) => { state.memory = { ok: false, error: e.message, pct: 0, history: [] }; })
  );

  await Promise.all(jobs);
  state.lastPoll = Date.now();
  state.polling = false;
  state.reason = reason;
  broadcast();
  updateTray();
  schedulePoll();
}

function updateTray() {
  if (!tray) return;
  const n = (state.gmail.count || 0) + (state.slack.count || 0);
  // Only macOS shows text beside a tray icon.
  if (isMac) tray.setTitle(n ? ` ${n}` : '');
  tray.setToolTip(
    `WorkHUD - ${state.gmail.count || 0} mail, ${state.slack.count || 0} slack, ` +
    `${Math.round((state.memory.pct || 0) * 100)}% memory`
  );
}

// Expanded means you are watching it, so it refreshes on the faster cadence.
function schedulePoll() {
  clearTimeout(pollTimer);
  const cfg = config.load();
  const ms = cfg.expanded ? cfg.activePollSeconds * 1000 : cfg.pollMinutes * 60 * 1000;
  pollTimer = setTimeout(() => poll('timer'), ms);
}

/* --------------------------------------------------------------------- IPC */

const SAFE_PROTOCOLS = new Set(['https:', 'http:', 'slack:', 'mailto:']);

function registerIpc() {
  ipcMain.handle('config:get', () => config.redacted());

  ipcMain.handle('config:save', (_e, partial) => {
    const before = config.load();
    const next = config.save(partial);
    // Bounds saved for one orientation are nonsense in the other, so start the
    // new one from a sensible default rather than a transposed leftover.
    if (next.vertical !== before.vertical) config.save({ bounds: defaultBounds() });
    if (next.expanded) peeking = false;             // a real expand supersedes a peek
    if (before.expanded && !next.expanded) peekSuppressed = true;
    applyWindowMode();
    if (next.pollMinutes !== before.pollMinutes
        || next.activePollSeconds !== before.activePollSeconds
        || next.expanded !== before.expanded) {
      schedulePoll();
    }
    if (next.launchAtLogin !== before.launchAtLogin) {
      app.setLoginItemSettings({ openAtLogin: next.launchAtLogin, openAsHidden: true });
    }
    // A source switched back on should fill in without waiting for the timer.
    if ((next.showGmail && !before.showGmail) || (next.showSlack && !before.showSlack)) poll('settings');
    broadcast();
    return config.redacted();
  });

  ipcMain.handle('state:get', () => state);
  ipcMain.handle('poll:now', () => poll('manual'));
  ipcMain.handle('settings:open', () => createSettings());
  ipcMain.handle('app:quit', () => app.quit());
  ipcMain.handle('hud:resetPosition', () => { config.save({ bounds: defaultBounds() }); applyWindowMode(); });

  ipcMain.handle('google:signin', async () => {
    const r = await google.signIn();
    poll('after-signin');
    return r;
  });

  ipcMain.handle('google:signout', () => {
    google.signOut();
    state.gmail = { ok: false, needsSetup: true, count: 0, items: [] };
    broadcast();
    updateTray();
  });

  ipcMain.handle('slack:connect', async (_e, token) => {
    const r = await slack.connect(token);
    poll('after-signin');
    return r;
  });

  ipcMain.handle('slack:disconnect', () => {
    slack.disconnect();
    state.slack = { ok: false, needsSetup: true, count: 0, items: [] };
    broadcast();
    updateTray();
  });

  ipcMain.handle('slack:markSeen', (_e, items) => {
    slack.markAllSeen(items && items.length ? items : state.slack.items);
    state.slack = { ...state.slack, count: 0, items: [] };
    broadcast();
    updateTray();
  });

  ipcMain.handle('open:external', (_e, url) => {
    try {
      if (!SAFE_PROTOCOLS.has(new URL(url).protocol)) return false;
      shell.openExternal(url);
      return true;
    } catch (e) {
      return false;
    }
  });

  ipcMain.handle('memory:processes', () => memory.topProcesses(8));
  ipcMain.handle('disks:list', () => memory.disks());
}

/* --------------------------------------------------------------- lifecycle */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (hud) { hud.show(); hud.focus(); } });

  app.whenReady().then(() => {
    // The Dock icon follows the same setting as the Windows taskbar button;
    // applyWindowMode sets it once the window exists.
    if (isMac && app.dock && !config.load().showInTaskbar) app.dock.hide();
    registerIpc();
    createHud();
    buildTray();

    if (!config.canEncrypt()) {
      dialog.showMessageBox({
        type: 'warning',
        title: 'WorkHUD',
        message: 'Secure credential storage is unavailable',
        detail: 'WorkHUD will run, but it will not save your Google or Slack tokens, so you will have to sign in again each launch. On Linux this usually means no keyring daemon is running.',
      });
    }

    // Nothing is connected yet, so there is nothing for the bar to show:
    // open Settings rather than leaving the user hunting for the tray icon.
    const first = config.load();
    if (!first.google.clientId && !first.slack.token) createSettings();

    poll('startup');

    // Memory is cheap and local, so it refreshes far faster than the network polls.
    memTimer = setInterval(async () => {
      try {
        const m = await memory.sample();
        state.memory = { ...state.memory, ...m };
        if (hud && !hud.isDestroyed()) hud.webContents.send('memory', state.memory);
      } catch (e) { /* ignore a single bad sample */ }
    }, 5000);

    hoverTimer = setInterval(checkHover, HOVER_TICK_MS);
    if (process.env.WORKHUD_DEBUG) console.log('[hover] watcher started');

    // If a screen is unplugged the window can end up off-canvas.
    screen.on('display-removed', () => {
      const b = storedBounds();
      const onScreen = screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
      });
      if (!onScreen) { config.save({ bounds: defaultBounds() }); applyWindowMode(); }
    });

    powerMonitor.on('resume', () => poll('resume'));
    app.on('activate', () => { if (!hud) createHud(); });
  });

  // The HUD lives in the tray; closing the settings window must not quit the app.
  app.on('window-all-closed', () => { /* keep running in the tray */ });
  app.on('before-quit', () => {
    clearTimeout(pollTimer);
    clearInterval(memTimer);
    clearInterval(hoverTimer);
  });
}
