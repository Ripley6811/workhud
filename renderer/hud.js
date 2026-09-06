/* eslint-env browser */
// The HUD renderer. It never touches the network and never sees a token: it just
// draws whatever the main process broadcasts, and reports UI intent back.

let state = null;
let cfg = null;

// Ids seen in the previous poll, so genuinely new arrivals can be highlighted.
let seenIds = { gmail: new Set(), slack: new Set() };
let firstPaint = true;

// Hover-peek: hovering the bar previews the dashboard and leaving it closes
// again, without touching the saved mode. The main process owns the detection,
// because the bar is a drag region and drag regions never deliver mouse events
// to the page.
let peeking = false;
// Stable nodes for the memory panel. It updates every 5 seconds, and rebuilding
// its DOM that often is what made numbers flash in and out of existence.
let memoryDom = null;
// Whether the rail is what opened the window, so closing it can undo that.
let railOpened = false;

const $ = (id) => document.getElementById(id);

/* --------------------------------------------------------------- helpers */

function bytes(n) {
  if (!n && n !== 0) return '--';
  const tb = n / 1024 ** 4;
  if (tb >= 1) return `${tb.toFixed(tb >= 10 ? 0 : 1)} TB`;
  const gb = n / 1024 ** 3;
  if (gb >= 100) return `${gb.toFixed(0)} GB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

// Everything is expressed as headroom: the meters read as fuel gauges that
// empty as you run out, and the colour follows how little is left.
function freeColour(freePct) {
  return freePct < 0.1 ? 'var(--bad)' : freePct < 0.25 ? 'var(--warn)' : 'var(--ok)';
}

function pct(fraction) {
  return `${Math.round(fraction * 100)}%`;
}

function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text; // textContent, never innerHTML: this is remote data
  return n;
}

function show(node, on) { node.hidden = !on; }

/* ------------------------------------------------------------------- bar */

// The bar is wide, so the newest item rides along beside the count.
function setPreview(id, item, textOf) {
  const node = $(id);
  node.replaceChildren();
  if (!item) return;
  node.appendChild(el('span', 'who', `${item.from}: `));
  node.appendChild(document.createTextNode(textOf(item)));
}

function paintBar() {
  if (!state || !cfg) return;

  const g = state.gmail || {};
  show($('seg-gmail'), cfg.showGmail);
  $('gmail-count').textContent = g.ok ? String(g.count) : '--';
  $('gmail-count').classList.toggle('alert', !!(g.ok && g.count));
  $('gmail-dot').className = `dot${g.needsSetup ? ' setup' : g.error ? ' err' : ''}`;
  $('seg-gmail').title = g.needsSetup ? 'Not connected - open Settings' : g.error || `Inbox: ${g.account || ''}`;
  setPreview('gmail-preview', (g.items || [])[0], (it) => it.subject);

  const s = state.slack || {};
  show($('seg-slack'), cfg.showSlack);
  $('slack-count').textContent = s.ok ? String(s.count) : '--';
  $('slack-count').classList.toggle('alert', !!(s.ok && s.count));
  $('slack-dot').className = `dot${s.needsSetup ? ' setup' : s.error ? ' err' : ''}`;
  $('seg-slack').title = s.needsSetup ? 'Not connected - open Settings' : s.error || `Slack: ${s.account || ''}`;
  setPreview('slack-preview', (s.items || [])[0], (it) => it.text);

  show($('rail'), cfg.showMemory);
  paintMemory(state.memory || {});

  const st = $('status');
  st.classList.toggle('busy', !!state.polling);
  const stamp = ago(state.lastPoll);
  st.textContent = state.polling ? 'refreshing'
    : !state.lastPoll ? ''
    : stamp === 'now' ? 'just now' : `${stamp} ago`;
}

function paintMemory(m) {
  const free = (m.total || 0) - (m.used || 0);
  const freeFrac = m.total ? free / m.total : 0;
  const usedFrac = m.total ? (m.used || 0) / m.total : 0;
  // The rail reads as used%, the opposite of the expanded panel's gauges
  // (which stay free-based) - the user wants "how full" here, at a glance.
  $('mem-pct').textContent = m.total ? pct(usedFrac) : '--';
  $('mem-detail').textContent = m.total ? `${bytes(m.used)} of ${bytes(m.total)}` : 'memory';
  const fill = $('mem-fill');
  // The meter fills with what is used, so it grows as memory fills. Which axis
  // it grows along depends on the layout, so CSS reads this rather than a
  // hard-coded height.
  fill.style.setProperty('--share', `${Math.min(100, usedFrac * 100)}%`);
  // Colour still keyed off how much room is left, not how full it reads.
  fill.style.background = freeColour(freeFrac);
  // The rail is the whole memory UI now, so the detail lives in its tooltip.
  const lines = [];
  if (m.total) {
    lines.push(`Memory: ${bytes(m.used)} used of ${bytes(m.total)} (${pct(usedFrac)})`);
    lines.push('Click to expand');
    const heaviest = (m.processes || []).slice(0, 4);
    if (heaviest.length) {
      lines.push('');
      lines.push('Heaviest:');
      for (const p of heaviest) lines.push(`  ${p.name}  ${bytes(p.bytes)}`);
    }
  } else {
    lines.push('Memory');
  }
  $('rail').title = lines.join('\n');
}

/* --------------------------------------------------------------- columns */

function emptyBlock(title, detail, actionLabel, onAction) {
  const box = el('div', 'empty');
  box.appendChild(el('b', null, title));
  if (detail) box.appendChild(el('div', 'err-text', detail));
  if (actionLabel) {
    const b = el('button', 'ghost', actionLabel);
    b.addEventListener('click', onAction);
    box.appendChild(b);
  }
  return box;
}

function messageRow({ who, what, sub, when, tag, url, fresh }) {
  const row = el('div', `row${fresh ? ' fresh' : ''}`);
  row.appendChild(el('span', 'who', who));
  const w = el('span', 'what', what);
  if (sub) w.appendChild(el('span', 'sub', sub));
  row.appendChild(w);
  if (tag) row.appendChild(el('span', 'tag', tag));
  row.appendChild(el('span', 'when', when));
  if (url) row.addEventListener('click', () => window.hud.openExternal(url));
  return row;
}

function paintGmailColumn() {
  const g = state.gmail || {};
  const body = $('gmail-body');
  body.replaceChildren();

  const count = $('gmail-col-count');
  show(count, !!(g.ok && g.count));
  count.textContent = String(g.count || 0);
  $('gmail-meta').textContent = g.ok ? (g.account || '') : '';

  if (!cfg.showGmail) return body.appendChild(emptyBlock('Email is switched off', 'Turn it back on in Settings.'));
  if (g.needsSetup) {
    return body.appendChild(emptyBlock('Gmail not connected',
      'Sign in with Google in Settings.', 'Open Settings', () => window.hud.openSettings()));
  }
  if (g.error) return body.appendChild(emptyBlock('Could not reach Gmail', g.error, 'Retry', () => window.hud.pollNow()));
  if (!g.items || !g.items.length) return body.appendChild(emptyBlock('Inbox zero', 'Nothing unread.'));

  const next = new Set();
  for (const it of g.items) {
    next.add(it.id);
    body.appendChild(messageRow({
      who: it.from, what: it.subject, sub: it.snippet, when: ago(it.ts), url: it.url,
      fresh: !firstPaint && !seenIds.gmail.has(it.id),
    }));
  }
  seenIds.gmail = next;
  return undefined;
}

function paintSlackColumn() {
  const s = state.slack || {};
  const body = $('slack-body');
  body.replaceChildren();

  const count = $('slack-col-count');
  show(count, !!(s.ok && s.count));
  count.textContent = String(s.count || 0);
  $('slack-meta').textContent = s.ok ? (s.account || '') : '';
  show($('slack-mark'), !!(s.ok && s.items && s.items.length));

  if (!cfg.showSlack) return body.appendChild(emptyBlock('Slack is switched off', 'Turn it back on in Settings.'));
  if (s.needsSetup) {
    return body.appendChild(emptyBlock('Slack not connected',
      'Paste a Slack user token in Settings.', 'Open Settings', () => window.hud.openSettings()));
  }
  if (s.error) return body.appendChild(emptyBlock('Could not reach Slack', s.error, 'Retry', () => window.hud.pollNow()));
  if (!s.items || !s.items.length) return body.appendChild(emptyBlock('All caught up', 'No new messages since you last looked.'));

  const next = new Set();
  for (const it of s.items) {
    const key = `${it.channel}:${it.ts}`;
    next.add(key);
    body.appendChild(messageRow({
      who: it.from, what: it.text, when: ago(it.tsMs), url: it.url,
      tag: it.where === 'DM' ? '' : it.where,
      fresh: !firstPaint && !seenIds.slack.has(key),
    }));
  }
  seenIds.slack = next;
  return undefined;
}

// A labelled fuel gauge: name and free share on top, bar, then `free of total`.
// RAM and each disk are the same kind of reading, so they get the same row.
function gaugeRow(name) {
  const row = el('div', 'disk');
  const top = el('div', 'top');
  top.appendChild(el('span', 'who', name));
  const share = el('span', 'pct', '--');
  top.appendChild(share);
  row.appendChild(top);
  const bar = el('span', 'bar');
  const fill = el('i');
  bar.appendChild(fill);
  row.appendChild(bar);
  const sub = el('div', 'sub', '');
  row.appendChild(sub);
  return { row, fill, share, sub };
}

// The row's own label says what it is, so it needs no section heading above it.
function paintGauge(g, free, total) {
  const frac = total ? free / total : 0;
  g.fill.style.width = `${Math.round(frac * 100)}%`;
  g.fill.style.background = freeColour(frac);
  g.share.textContent = `${pct(frac)} free`;
  g.share.style.color = freeColour(frac);
  g.sub.textContent = `${bytes(free)} of ${bytes(total)}`;
  return frac;
}

function buildMemoryDom(body) {
  body.replaceChildren();
  const ram = gaugeRow('RAM');
  body.appendChild(ram.row);

  const diskHead = el('div', 'section', 'Disks');
  const disks = el('div');
  body.appendChild(diskHead);
  body.appendChild(disks);

  const procHead = el('div', 'section', 'RAM by process');
  const procs = el('div');
  body.appendChild(procHead);
  body.appendChild(procs);

  return { ram, disks, diskHead, procs, procHead, diskKey: null, diskRows: [], procKey: null, procRows: [] };
}

function paintMemoryColumn() {
  const m = state.memory || {};
  const body = $('memory-body');
  if (!memoryDom || !body.contains(memoryDom.procs)) memoryDom = buildMemoryDom(body);


  const ramFree = (m.total || 0) - (m.used || 0);
  const ramFrac = paintGauge(memoryDom.ram, ramFree, m.total || 0);
  memoryDom.ram.row.title = `RAM - ${bytes(ramFree)} free of ${bytes(m.total)} (${pct(ramFrac)} free)`;
  $('memory-meta').textContent = '';

  const wanted = new Set(cfg.diskFilter || []);
  const disks = (m.disks || []).filter((d) => !wanted.size || wanted.has(d.name));
  show(memoryDom.diskHead, disks.length > 0);

  // Rows are rebuilt only when the set of drives changes. This panel repaints
  // every five seconds, and rebuilding its DOM that often is what made the
  // figures flash in and out of view.
  const diskKey = disks.map((d) => d.name).join('|');
  if (diskKey !== memoryDom.diskKey) {
    memoryDom.diskKey = diskKey;
    memoryDom.diskRows = [];
    memoryDom.disks.replaceChildren();
    for (const d of disks) {
      const g = gaugeRow(d.name);
      memoryDom.disks.appendChild(g.row);
      memoryDom.diskRows.push(g);
    }
  }
  disks.forEach((d, i) => {
    const g = memoryDom.diskRows[i];
    if (!g) return;
    const frac = paintGauge(g, d.free, d.total);
    g.row.title = `${d.name} - ${bytes(d.free)} free of ${bytes(d.total)} (${pct(frac)} free)`;
  });

  const procs = m.processes || [];
  show(memoryDom.procHead, procs.length > 0);
  const procKey = procs.map((p) => p.name).join('|');
  if (procKey !== memoryDom.procKey) {
    memoryDom.procKey = procKey;
    memoryDom.procRows = [];
    memoryDom.procs.replaceChildren();
    for (const p of procs) {
      const row = el('div', 'proc');
      row.appendChild(el('span', 'who', p.name));
      const size = el('span', 'when', '--');
      row.appendChild(size);
      memoryDom.procs.appendChild(row);
      memoryDom.procRows.push(size);
    }
  }
  procs.forEach((p, i) => {
    if (memoryDom.procRows[i]) memoryDom.procRows[i].textContent = bytes(p.bytes);
  });
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function fmtWhen(ev) {
  if (!ev) return '';
  if (ev.allDay) return 'All day';
  return `${fmtTime(ev.startMs)} - ${fmtTime(ev.endMs)}`;
}

function paintEventPanel(prefix, ev) {
  const panel = $(`cal-${prefix}`);
  const title = $(`cal-${prefix}-title`);
  const when = $(`cal-${prefix}-when`);
  panel.classList.toggle('empty', !ev);
  title.textContent = ev ? ev.title : 'Nothing scheduled';
  when.textContent = fmtWhen(ev);
}

function paintCalendarColumn() {
  const c = state.calendar || {};
  const countEl = $('cal-count');
  const unitEl = $('cal-unit');
  countEl.className = 'cal-count';

  if (c.needsSetup || c.needsReconsent) {
    countEl.textContent = '--';
    unitEl.textContent = c.needsReconsent ? 'reconnect' : 'not connected';
  } else if (c.error) {
    countEl.textContent = '--';
    unitEl.textContent = 'error';
  } else if (!c.next) {
    countEl.textContent = '--';
    unitEl.textContent = 'no events';
  } else {
    const now = Date.now();
    if (now >= c.next.startMs && now < c.next.endMs) {
      countEl.textContent = 'NOW';
      countEl.classList.add('now');
      unitEl.textContent = 'in progress';
    } else {
      const mins = Math.max(0, Math.round((c.next.startMs - now) / 60000));
      if (mins < 60) {
        countEl.textContent = String(mins);
        unitEl.textContent = mins === 1 ? 'minute' : 'minutes';
        if (mins <= 5) countEl.classList.add('soon');
      } else if (mins < 60 * 24) {
        countEl.textContent = String(Math.round(mins / 60));
        unitEl.textContent = 'hours';
      } else {
        countEl.textContent = String(Math.round(mins / 60 / 24));
        unitEl.textContent = 'days';
      }
    }
  }

  paintEventPanel('next', c.next);
  paintEventPanel('following', c.following);
}

function paintDash() {
  if (!cfg.expanded && !peeking) return;
  paintGmailColumn();
  paintSlackColumn();
  if (cfg.showCalendar) paintCalendarColumn();
  if (cfg.showMemoryColumn) paintMemoryColumn();
}

/* ----------------------------------------------------------------- modes */

function applyMode() {
  const on = !!(cfg.expanded || peeking);
  document.body.classList.toggle('expanded', on);
  document.body.classList.toggle('vertical', !!cfg.vertical);
  show($('dash'), on);
  show($('col-gmail'), cfg.showGmail);
  show($('col-calendar'), cfg.showCalendar);
  show($('col-slack'), cfg.showSlack);
  show($('col-memory'), on && cfg.showMemory && cfg.showMemoryColumn);

  const btn = $('btn-expand');
  // The chevron points the way the window will grow.
  btn.textContent = cfg.vertical
    ? (cfg.expanded ? '◀' : '▶')
    : (cfg.expanded ? '▲' : '▼');
  btn.title = cfg.expanded ? 'Collapse to the bar'
    : peeking ? 'Keep it open'
    : 'Expand';
  $('rail').classList.toggle('on', !!cfg.showMemoryColumn);
  $('btn-pin').classList.toggle('on', !!cfg.pinned);
  $('btn-pin').title = cfg.pinned ? 'Pinned on top - click to unpin' : 'Keep on top of other windows';
  document.documentElement.style.setProperty('--bar-h', `${cfg.hudHeight}px`);
}

async function setConfig(partial) {
  cfg = await window.hud.saveConfig(partial);
  if (cfg.expanded) peeking = false; // a deliberate expand supersedes a peek
  applyMode();
  paintBar();
  paintDash();
}

/* ------------------------------------------------------------------ wire */

// The segments are drag handles, not buttons - the chevron expands.
$('btn-expand').addEventListener('click', () => setConfig({ expanded: !cfg.expanded }));
$('btn-pin').addEventListener('click', () => setConfig({ pinned: !cfg.pinned }));
$('btn-refresh').addEventListener('click', () => window.hud.pollNow());
$('btn-settings').addEventListener('click', () => window.hud.openSettings());
$('slack-mark').addEventListener('click', () => window.hud.slackMarkSeen(state.slack.items));

// The rail opens the memory detail panel, expanding the window if it has to.
// Closing it again undoes that expand only if the rail is what caused it.
$('rail').addEventListener('click', () => {
  if (!cfg.showMemoryColumn) {
    railOpened = !cfg.expanded;
    setConfig({ showMemoryColumn: true, expanded: true });
  } else {
    const collapse = railOpened;
    railOpened = false;
    setConfig({ showMemoryColumn: false, expanded: collapse ? false : cfg.expanded });
  }
});

window.hud.onPeek((on) => {
  if (peeking === on) return;
  peeking = on;
  applyMode();
  paintDash();
});

window.hud.onState((s) => {
  state = s;
  window.hud.getConfig().then((c) => {
    cfg = c;
    applyMode();
    paintBar();
    paintDash();
    firstPaint = false;
  });
});

// Memory ticks far more often than a poll, so it gets its own light path.
window.hud.onMemory((m) => {
  if (!state) return;
  // Merge, not replace: the fast tick carries no process list.
  state.memory = { ...state.memory, ...m };
  paintMemory(state.memory);
  if (cfg && (cfg.expanded || peeking) && cfg.showMemoryColumn) paintMemoryColumn();
});

// Keep the relative stamps honest between polls.
setInterval(() => {
  if (!state || state.polling) return;
  paintBar();
  if (cfg && (cfg.expanded || peeking)) paintDash();
}, 20000);

(async () => {
  cfg = await window.hud.getConfig();
  state = await window.hud.getState();
  applyMode();
  paintBar();
  paintDash();
  firstPaint = false;
})();
