# Testing

## What has been tested

| Area | How | Status |
|---|---|---|
| Backend logic: settings validation, atomic save, corrupt-file recovery, backups/restore, mapping/normalisation, Wake-on-LAN packets and targets, ARP lookup, Moonlight CSV parsing and argv building, error classification, Moonlight.conf import | Python `unittest` | automated |
| Apollo HTTP `/serverinfo` probe, web UI cookie login, Sunshine Basic-auth fallback, `GET/POST /api/apps`, certificate pinning, wrong password | integration tests against a **fake Apollo server** (HTTP + HTTPS with a generated self-signed cert) | automated |
| Full backend launch flow: name match, exact AppID match, unmapped → manual mapping, deleted app, create app on PC, offline without/with WoL (timeout), Moonlight not paired/missing, cancel | integration tests with a fake Apollo and a **fake Moonlight executable** | automated |
| `moonlight-runner.sh`: executes the request, one-shot request, stale request ignored, hostile app names cannot inject shell commands, failure result, SIGTERM forwarding, `LD_LIBRARY_PATH` scrubbing | the real script, run as Steam would run it | automated |
| `main.py` loaded the way Decky loads it, from the extracted release zip | fake `decky` module | automated |
| Frontend: button placement in a Steam-shaped page tree (both positions, no duplicates, skipped app types, unknown layout), route patch/unpatch, hidden shortcut create/reuse/remove, launch flow (picker → mapping → RunGame → back navigation → session watch), offline/wake/cancel, Steam not starting the runner, all settings pages render | Vitest with mocked `@decky/ui`, `@decky/api` and Steam globals | automated |
| TypeScript type check against `@decky/ui` 4.16.5 typings, Rollup bundle | `tsc`, `rollup` | automated |
| install / uninstall / restore scripts | run in a sandboxed `$HOME` with `sudo`/`systemctl` shims | manually verified |

## What has NOT been tested

**The plugin has not been run on a real Legion Go S / Steam client.** It was
built in a Linux container without Steam, so these are unverified:

* that the button appears in the current Steam client's game page (the injection
  point is the same one MoonDeck/ProtonDB Badges use, but Steam's tree is only
  mocked in the tests);
* gamepad focus/navigation to the button;
* `SteamClient.Apps.AddShortcut/RunGame` behaviour, the hidden shortcut and the
  return navigation;
* gamescope focus of the Moonlight window and Steam Input passthrough;
* Moonlight Flatpak `list`/`stream` against your real Apollo, and
  Wake-on-LAN on your network.

Please run the on-device checklist below and report results (and the plugin
log) in an issue.

## Running the automated tests

```bash
pnpm install
pnpm run typecheck
pnpm run test:frontend          # Vitest
pnpm run package                # builds dist/ and out/moondeck-apollo.zip
pnpm run test:backend           # python3 -m unittest (uses openssl to make a test certificate)
```

CI (`.github/workflows/ci.yml`) runs all of the above on Python 3.11 (the
version Decky bundles) and Node 22, and attaches the zip to tagged releases.

## On-device acceptance checklist (Legion Go S)

Prepare: Apollo running, Moonlight paired, plugin installed and the host
configured (see INSTALL.md). Keep a game with an Apollo app of the **same name**
(A), a game with **no** Apollo app (B) and a non-Steam shortcut (C).

| # | Step | Expected |
|---|---|---|
| 1 | Open game A's page | **Moonlight** button under Play/Stream; hint "Apollo: A" |
| 2 | Move focus with the D-pad from Play down to the button and to ⋯ | Focus reaches both; A launches, B (back) leaves the page |
| 3 | Press **Moonlight** on A | "Contacting …" dialog → stream of A starts full screen, with no Moonlight app grid |
| 4 | Use the controller in game | Input works; Steam button opens the Steam overlay |
| 5 | End the stream (Select+Start+L1+R1) | Back on A's game page in Gaming Mode |
| 6 | Library → Hidden | Contains only "A (Moonlight)" / "Moonlight (Apollo)", which is the runner |
| 7 | Press **Moonlight** on B | "Choose the Apollo app" dialog; pick one → it streams; the second launch does not ask again |
| 8 | ⋯ on B | Can change the mapping |
| 9 | Delete B's Apollo app on the PC, launch B | "The saved app … no longer exists" → picker |
| 10 | Web UI access on; B with no app → **Add “B” to Apollo** | App appears in Apollo's web UI; stream starts Steam on the PC with B |
| 11 | Put the PC to sleep, press **Moonlight** | "Waking…" countdown → PC wakes → stream starts |
| 12 | Unplug the PC's network, press **Moonlight** | After the timeout: "Gaming PC is offline" with Retry/Cancel |
| 13 | Steam menu → Exit game during a stream | Moonlight closes, back on the game page |
| 14 | Button position "hero" | Button on the artwork bottom-right; hidden during the header's fullscreen transition |
| 15 | Steam client update (beta ↔ stable) | Steam still works; if the button is missing, the log shows "game page layout not recognised" |
| 16 | Backup → change something → Restore | Settings/mappings restored |
| 17 | Remove Steam shortcut and runtime files → uninstall in Decky | Hidden shortcut gone, button gone, settings backup kept |

## Debugging

* Plugin log: `~/homebrew/logs/moondeck-apollo/` (backend and frontend messages).
* Last Moonlight output: **Settings → Diagnostics** or
  `~/homebrew/data/moondeck-apollo/moonlight-last.log`.
* Frontend console: enable Decky ⚙ → Developer → **Allow Remote CEF Debugging**,
  then on a PC open `chrome://inspect` → configure `<legion-ip>:8081` →
  inspect **SharedJSContext**. Messages are prefixed `[Moondeck Apollo]`.
* Run the Moonlight command by hand in Desktop Mode, e.g.
  `flatpak run com.moonlight_stream.Moonlight list 192.168.1.50 --csv`.
