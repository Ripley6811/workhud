// System memory, top processes, and disk space.
//
// os.freemem() means different things per platform: on Windows it is close to
// "available", but on macOS it counts only wholly free pages, which would report
// ~95% used on an idle Mac. So macOS and Linux get real readings.
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

const HISTORY = 60; // ~5 minutes of samples at 5s
const history = [];

function run(cmd, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout) =>
      resolve(err ? '' : stdout));
  });
}

async function usedBytes() {
  const total = os.totalmem();

  if (process.platform === 'darwin') {
    const out = await run('vm_stat', []);
    const pageSize = Number(out.match(/page size of (\d+) bytes/)?.[1]) || 4096;
    const pages = (label) => {
      const m = out.match(new RegExp(`${label}:\\s+(\\d+)`));
      return m ? Number(m[1]) : null;
    };
    const wired = pages('Pages wired down');
    const compressed = pages('Pages occupied by compressor');
    const anon = pages('Anonymous pages');
    const purgeable = pages('Pages purgeable') || 0;
    // Mirrors Activity Monitor's "Memory Used": app memory + wired + compressed.
    if (wired !== null && compressed !== null && anon !== null) {
      return { total, used: Math.max(0, (anon - purgeable + wired + compressed) * pageSize) };
    }
  }

  if (process.platform === 'linux') {
    try {
      const info = fs.readFileSync('/proc/meminfo', 'utf8');
      const kb = (k) => Number(info.match(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm'))?.[1]);
      const avail = kb('MemAvailable');
      if (avail) return { total, used: Math.max(0, total - avail * 1024) };
    } catch { /* fall through */ }
  }

  return { total, used: total - os.freemem() };
}

/* ------------------------------------------------------------------ disks */

function candidateRoots() {
  if (process.platform === 'win32') {
    // Probe the drive letters. statfs simply throws on ones that are not there,
    // which is cheaper than shelling out to wmic and does not depend on a
    // deprecated tool being installed.
    const roots = [];
    for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
      roots.push(`${String.fromCharCode(c)}:\\`);
    }
    return roots;
  }
  const roots = ['/'];
  if (process.platform === 'darwin') {
    try {
      for (const v of fs.readdirSync('/Volumes')) roots.push(path.join('/Volumes', v));
    } catch { /* no external volumes */ }
  }
  return roots;
}

async function disks() {
  const out = [];
  await Promise.all(candidateRoots().map(async (root) => {
    try {
      const s = await fsp.statfs(root);
      const total = s.blocks * s.bsize;
      if (!total) return;
      // bavail is what this user may actually use; bfree includes reserved blocks.
      const free = s.bavail * s.bsize;
      out.push({
        name: process.platform === 'win32' ? root.slice(0, 2) : root,
        root,
        total,
        free,
        used: total - free,
        pct: (total - free) / total,
      });
    } catch { /* not mounted, empty optical drive, permission denied */ }
  }));
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/* -------------------------------------------------------------- processes */

async function topProcesses(n = 5) {
  try {
    if (process.platform === 'win32') {
      const out = await run('tasklist', ['/FO', 'CSV', '/NH']);
      const rows = out.split(/\r?\n/).map((line) => {
        // "name.exe","pid","session","1","123,456 K"
        const cols = line.match(/"([^"]*)"/g);
        if (!cols || cols.length < 5) return null;
        const strip = (s) => s.slice(1, -1);
        const kb = Number(strip(cols[4]).replace(/[^\d]/g, ''));
        return kb ? { name: strip(cols[0]).replace(/\.exe$/i, ''), bytes: kb * 1024 } : null;
      }).filter(Boolean);
      return merge(rows, n);
    }
    // macOS and Linux: rss is in kilobytes.
    const out = await run('ps', ['-Axo', 'rss=,comm=']);
    const rows = out.split(/\r?\n/).map((line) => {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!m) return null;
      return { name: m[2].split('/').pop(), bytes: Number(m[1]) * 1024 };
    }).filter(Boolean);
    return merge(rows, n);
  } catch {
    return [];
  }
}

// Chrome and friends are dozens of processes; sum them under one name.
function merge(rows, n) {
  const by = new Map();
  for (const r of rows) by.set(r.name, (by.get(r.name) || 0) + r.bytes);
  return [...by.entries()]
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, n);
}

/* ----------------------------------------------------------------- sample */

// `withDetail` adds the process list and disk figures, which are only worth
// gathering on the slow poll. The fast 5s tick asks for memory alone.
async function sample({ withDetail = false } = {}) {
  const { total, used } = await usedBytes();
  const pct = total ? used / total : 0;
  history.push(pct);
  if (history.length > HISTORY) history.shift();

  const out = { ok: true, total, used, pct, history: history.slice() };
  // These keys must be absent, not undefined, when we did not sample them: the
  // caller merges this over the last reading, and an explicit `undefined` would
  // wipe the good values it is merging onto.
  if (withDetail) {
    out.processes = await topProcesses();
    out.disks = await disks();
  }
  return out;
}

module.exports = { sample, topProcesses, disks };
