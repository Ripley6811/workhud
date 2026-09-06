# TODO

Working list for WorkHUD. Add anything here and it gets picked up; Claude keeps
this file current, ticking items off and pruning them once they have shipped.

## Next

Nothing queued right now.

## Known gaps

- [ ] **Pulsing "new" dots and the whole-window hover detection are new and
      only sanity-checked, not fully exercised live.** Verified in the preview
      harness (pulse starts, stops on a simulated hover, resumes only on a
      genuine count increase) and the real app relaunches clean, but the
      actual mouse-driven hover path in the real window - `windowHovered` in
      main.js, the `hover` IPC message - hasn't been driven by a real cursor
      the way hover-peek was earlier in the project.
- [ ] **Calendar never exercised against a live Google account.** Built and
      verified in the preview harness against fake events. The real API path
      (`calendar.readonly` scope, event parsing, the reconsent path for
      accounts that connected before this existed, and the fixed 403-cause
      detection that distinguishes "needs reconsent" from "Calendar API not
      enabled") is unverified - same caveat as Gmail and Slack below.
- [ ] **1-4 meeting panels is user-set** (Settings, default 2) but only
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
