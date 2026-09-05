# TODO

Working list for WorkHUD. Add anything here and it gets picked up; Claude keeps
this file current, ticking items off and pruning them once they have shipped.

## Next

- [ ] **Google Calendar support.** Today's events as a fourth source. The Gmail
      OAuth client can carry it — add `calendar.readonly` to the scopes, which
      forces a re-consent, so handle the "token has fewer scopes than we now
      need" case rather than silently failing. Open question: its own column, or
      folded into the mail column as a day strip.
- [ ] **Make the RAM figures read like the DISKS rows.** RAM is currently a
      TOTAL/FREE stat grid while disks get a heading, a fuel-gauge bar and a
      `x of y` line. Give RAM the same treatment so the panel reads as one
      consistent list.
- [ ] **Toggle for a vertical bar HUD.** Let the whole window stand on its end
      against a screen edge — the bar running down the side, columns stacked
      rather than side by side. Mostly a matter of flipping `#wrap`'s axis and
      giving the collapsed state a width rather than a height, but the drag
      region, the memory rail and the peek geometry all assume horizontal today.

## Known gaps

- [ ] **Never exercised against live Gmail or Slack.** Everything so far is
      window behaviour and layout against fake data. The API paths — token
      refresh, `resultSizeEstimate`, Slack pagination, rate limits — are
      unverified.
- [ ] **Never run on macOS.** The platform-specific code (`vm_stat` parsing,
      `app.dock.hide()`, `type: 'panel'`, `/Volumes` enumeration, template tray
      icon) is written but untested.
- [ ] **No app icon for packaging.** `electron-builder` falls back to the
      Electron default; `assets/icon.png` is the generated placeholder.
- [ ] **Slack "new" is local state.** Last-seen timestamps are tracked in
      config, so the count diverges from Slack's own unread badge. Worth
      revisiting if Slack ever exposes unread counts to third-party tokens.
