# TODO

Working list for WorkHUD. Add anything here and it gets picked up; Claude keeps
this file current, ticking items off and pruning them once they have shipped.

## Next

- [ ] **Make "show disk space" optional on the memory panel.** A toggle to hide
      the DISKS section; with it off, the panel is just RAM plus the process
      list. Same pattern as `showMemoryColumn` - a config flag, checked in
      `paintMemoryColumn`.
- [ ] **Put RAM next to the process list, not next to DISKS.** Currently the
      panel reads RAM, DISKS, RAM BY PROCESS top to bottom - the two RAM
      sections aren't adjacent. Reorder to RAM, RAM BY PROCESS, DISKS (or drop
      DISKS to the very bottom) so the related pair sits together.

## Known gaps

- [ ] **Calendar never exercised against a live Google account.** Built and
      verified in the preview harness against fake events. The real API path
      (`calendar.readonly` scope, event parsing, the insufficient-scope
      re-consent path for accounts that connected before this existed) is
      unverified - same caveat as Gmail and Slack below.
- [ ] **1-4 meeting panels is now user-set** (Settings, default 2) but only
      verified in the preview harness at 2 and 4. 1 and 3 weren't screenshotted
      - should be fine (same code path, just a loop bound) but not eyeballed.


- [ ] **Never exercised against live Gmail or Slack.** Everything so far is
      window behaviour and layout against fake data. The API paths — token
      refresh, `resultSizeEstimate`, Slack pagination, rate limits — are
      unverified.
- [ ] **Never run on macOS.** The platform-specific code (`vm_stat` parsing,
      `app.dock.hide()`, `type: 'panel'`, `/Volumes` enumeration, template tray
      icon) is written but untested.
- [ ] **Slack "new" is local state.** Last-seen timestamps are tracked in
      config, so the count diverges from Slack's own unread badge. Worth
      revisiting if Slack ever exposes unread counts to third-party tokens.
