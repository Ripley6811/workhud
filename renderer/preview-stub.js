/* eslint-env browser */
// Development only. Stands in for the preload bridge so hud.html can be opened
// in a plain browser with representative data - handy for tweaking the design
// without connecting a real account. The generated preview.html loads this
// before hud.js. Not used by the running app.
//
// Append #compact to the URL to preview the collapsed bar.

const now = Date.now();
const min = (n) => now - n * 60000;

const FAKE_STATE = {
  polling: false,
  lastPoll: min(1),
  gmail: {
    ok: true,
    count: 9,
    account: 'you@example.com',
    items: [
      { id: '1', from: 'Priya Raman', subject: 'Re: Q3 capacity plan - numbers updated', snippet: 'I moved the storage line into the second half, which frees up...', ts: min(4), url: 'https://mail.google.com/' },
      { id: '2', from: 'build-bot', subject: '[FAILED] nightly-integration #4417', snippet: 'Stage migrate exited 1 after 6m12s. Last green build was...', ts: min(31), url: 'https://mail.google.com/' },
      { id: '3', from: 'Tom Whitfield', subject: 'Lunch Thursday?', snippet: 'There is a new place near the office that does a decent...', ts: min(96), url: 'https://mail.google.com/' },
      { id: '4', from: 'IT Service Desk', subject: 'Scheduled VPN maintenance this weekend', snippet: 'Access will be intermittent between 02:00 and 05:00 on Saturday.', ts: min(190), url: 'https://mail.google.com/' },
      { id: '5', from: 'Dana Okafor', subject: 'Design review notes', snippet: 'Attaching the annotated screens from this morning. The main...', ts: min(320), url: 'https://mail.google.com/' },
      { id: '6', from: 'notifications', subject: 'Your weekly summary is ready', snippet: '12 pull requests merged, 3 open more than a week.', ts: min(1400), url: 'https://mail.google.com/' },
    ],
  },
  slack: {
    ok: true,
    count: 5,
    account: 'Acme Corp',
    items: [
      { channel: 'D01', ts: '1', from: 'Priya Raman', where: 'DM', text: 'can you take a look at the migration branch before standup?', tsMs: min(2), url: 'https://app.slack.com/' },
      { channel: 'C02', ts: '2', from: 'Marcus Lee', where: '#platform', text: 'bumping this - did the rollback script ever land?', tsMs: min(22), url: 'https://app.slack.com/', mention: true },
      { channel: 'D03', ts: '3', from: 'Dana Okafor', where: 'DM', text: 'sent you the figma link, shout if the permissions are wrong', tsMs: min(58), url: 'https://app.slack.com/' },
      { channel: 'G04', ts: '4', from: 'Tom Whitfield', where: 'Group DM', text: 'moving the sync to 3pm, calendar updated', tsMs: min(140), url: 'https://app.slack.com/' },
      { channel: 'C05', ts: '5', from: 'Ana Duarte', where: '#incidents', text: 'all clear on the eu-west latency, root cause was a stale DNS entry', tsMs: min(210), url: 'https://app.slack.com/', mention: true },
    ],
  },
  memory: {
    ok: true,
    total: 17179869184,
    used: 13314398617,
    pct: 0.775,
    disks: [
      { name: 'C:', total: 999999999000, free: 442000000000, used: 557999999000, pct: 0.558 },
      { name: 'D:', total: 1999999999000, free: 1320000000000, used: 679999999000, pct: 0.34 },
    ],
    processes: [
      { name: 'chrome', bytes: 4912345088 },
      { name: 'Code', bytes: 2310000000 },
      { name: 'slack', bytes: 1180000000 },
      { name: 'java', bytes: 902000000 },
      { name: 'Docker Desktop', bytes: 744000000 },
    ],
  },
};

const FAKE_CONFIG = {
  hudHeight: 44,
  hudOpacity: 1,
  showGmail: true,
  showSlack: true,
  showMemory: true,
  showMemoryColumn: true,
  expanded: !location.hash.includes('compact'),
  pinned: true,
  vertical: location.hash.includes('vertical'),
  hoverPeek: true,
  pollMinutes: 3,
  activePollSeconds: 60,
  maxItems: 25,
  diskFilter: [],
};

window.hud = {
  getConfig: async () => ({ ...FAKE_CONFIG }),
  getState: async () => FAKE_STATE,
  saveConfig: async (partial) => { Object.assign(FAKE_CONFIG, partial); return { ...FAKE_CONFIG }; },
  pollNow: async () => {},
  openSettings: async () => {},
  resetPosition: async () => {},
  openExternal: async (url) => console.log('openExternal', url),
  slackMarkSeen: async () => {},
  topProcesses: async () => FAKE_STATE.memory.processes,
  listDisks: async () => FAKE_STATE.memory.disks,
  onState: () => {},
  onMemory: () => {},
  onPeek: () => {},
};
