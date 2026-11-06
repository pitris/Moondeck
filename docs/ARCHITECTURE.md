# Research findings and architecture

This document records what was investigated before writing code, what Steam does
and does not allow, and why Moondeck Apollo is built the way it is.

## 1. How SteamOS Gaming Mode is put together

| Layer | What it is | Relevance |
|---|---|---|
| **gamescope** | Valve's Wayland/X compositor that runs the whole session. It shows exactly one "focused" app: Steam's UI or the running game. | A process only gets the screen (and leaves it again) cleanly if Steam started it as a game. |
| **Steam client (`-gamepadui`)** | Native `steamclient` + a Chromium Embedded Framework (CEF) browser that renders the UI. | All launching, Remote Play streaming, Steam Input and the library live in native code. |
| **SteamUI** | A minified React/MobX web app running in CEF ("SharedJSContext"). It talks to native code through the `SteamClient.*` JavaScript bindings and global stores (`appStore`, `collectionStore`, `SteamUIStore`, …). | This is the only place a plugin can change the UI. |
| **Decky Loader** | Injects JavaScript into SharedJSContext through CEF remote debugging and runs a Python backend as a systemd service. Plugins = React frontend + Python backend. | Gives us React tree patching (`routerHook.addPatch`), routes, modals and a backend. |

Nothing in this stack is a public, versioned plugin API. Decky works by patching
Steam's React tree at runtime; Valve can change that tree in any client update.

## 2. How the Play and Stream buttons are generated

The game page (`/library/app/:appid`) renders a *play section*. Its button is
driven by the app overview object that native Steam pushes into `appStore`:

* `overview.per_client_data[]`: one entry per **machine** that can run the game:
  the local device, plus every Steam Remote Play host on the LAN that has it
  installed (`clientid`, `client_name`, `display_status`, `installed`, …).
* `overview.selected_clientid` / `most_available_clientid`: which machine the
  button currently targets. Selecting another machine in the dropdown calls
  `SteamClient.Apps.SetStreamingClientForApp(appid, clientid)`.
* Pressing the button calls `SteamClient.Apps.RunGame(gameid, …)`. Native Steam
  then either launches locally ("Play") or starts its Remote Play client against
  the selected host ("Stream").

So **"Stream" is not a launch provider**. It is the same Play action aimed at
another *Steam* client, discovered and spoken to by native code.

## 3. Can a custom launch provider be added?

**No. SteamOS has no supported way to add a third entry to Steam's Play/Stream
selector.** Options that were investigated:

| Approach | Verdict | Why |
|---|---|---|
| Register a launch provider / streaming backend | **Impossible** | Steam has no such API. Remote Play hosts are discovered by native code; the JS layer only receives the results. |
| Inject a fake entry into `per_client_data` | Rejected | The data belongs to native Steam and is replaced on every overview update. Selecting the entry would send an unknown client id to native `SetStreamingClientForApp`, and `RunGame` would still go through native code. It would need constant re-injection plus launch interception, and could corrupt Steam's state or break real Remote Play. |
| Patch the Play-button dropdown component | Rejected for now | Technically possible with Decky's React patching, but the component is minified with no stable identifier, so the patch would break with client updates. It also cannot be verified without hardware. |
| Intercept `RegisterForGameActionStart` and redirect "Play" to Moonlight | Rejected as default | It hijacks the local Play button. Fine as an opt-in hack, but it is not a third option. |
| **Add our own option to the game page next to the play section** | **Chosen** | This is a long-standing technique: MoonDeck, ProtonDB Badges and HowLongToBeat all decorate this page. It relies only on the page's `InnerContainer` class (exported by `@decky/ui`) and the `overview` prop. When it fails it fails safely: the button is missing and Steam is unaffected. |
| Entry in the game's context menu (⚙ / Options) | Possible future addition | decky-steamgriddb does this. Its code has needed fixes for Steam client changes (e.g. the Oct 2025 client), which shows how often these internals move. |

**Result:** each game page shows *Play/Stream* (Steam's native button) plus a
**Moonlight** button directly below it (or, optionally, on the game artwork).
It is a separate button rendered by the plugin, not an entry inside Steam's
selector. That compromise is unavoidable.

## 4. Launching Moonlight so it behaves like a Steam game

Starting `moonlight` from the Decky backend would not work properly: gamescope
would not focus the window, Steam Input would not apply, and Steam would not
know a game is running. Moondeck Apollo therefore:

1. keeps **one hidden non-Steam shortcut**, "Moonlight (Apollo)", whose target
   is `moonlight-runner.sh`. It is created through `SteamClient.Apps.AddShortcut`
   and hidden with `collectionStore.SetAppsAsHidden`. It is not per game, not
   created by hand, and not visible in the library.
2. the backend writes a one-shot request file holding the exact Moonlight
   command (`flatpak run com.moonlight_stream.Moonlight stream <host> "<app>"`),
   with every argument shell-quoted.
3. the frontend renames the shortcut to "*Game* (Moonlight)" (so Steam's
   overlay and "now playing" show the game) and calls `SteamClient.Apps.RunGame`.
4. Steam navigates to the launched app's page right after `RunGame`. The plugin
   sees the hidden shortcut's page render and navigates back to the real game.
5. moonlight-qt's CLI streams the app directly, without its app grid. When the
   session ends the CLI calls `Qt.quit()` (`app/gui/CliStartStreamSegue.qml` →
   `StreamSegue.qml`), so the runner exits and Steam returns to Gaming Mode.
   Steam's own "Exit game" sends SIGTERM, which the runner forwards to Moonlight.

Steam Input: Steam applies the hidden shortcut's controller layout (default
"Gamepad", a virtual Xbox controller) to Moonlight, and Moonlight forwards that
gamepad to Apollo. Compromise: **one layout is shared by all Moonlight
sessions**, because every session runs through the same shortcut. Per-game
layouts would need one shortcut per game, which you asked to avoid.

## 5. Identifying the game and mapping it to Apollo

* The route patch reads `overview.appid`, `display_name` and `app_type` from the
  props Steam passes to the game page, so the Steam AppID is exact.
* Apollo app lists come from one of two sources:
  * **`moonlight list <host> --csv`** (default). It uses Moonlight's existing
    pairing, so nothing extra is needed on the PC. It returns names only. It
    runs with `QT_QPA_PLATFORM=offscreen` because the CLI still creates a
    `QGuiApplication`.
  * **Apollo web UI API** (optional, `POST /api/login` + `GET /api/apps` on port
    47990). It returns each app's `cmd`/`detached`/`prep-cmd`, so
    `steam://rungameid/<id>`, `steam://run/<id>` or `-applaunch <id>` give an
    exact AppID match. With this enabled the plugin can also **create** a
    missing Apollo app (`POST /api/apps`, detached `steam://rungameid/<id>`).
    Upstream Sunshine's HTTP Basic auth is supported as a fallback.
* Resolution order (`py_modules/moondeck_apollo/mapping.py`):
  1. the user's saved mapping;
  2. exactly one Apollo app that launches this Steam AppID;
  3. exactly one Apollo app whose normalised name matches. Normalisation
     ignores ™/®, punctuation and case, turns `&` into "and" and Roman numerals
     into digits, so "Hades II" matches "Hades 2";
  4. otherwise the user is asked **once**, with ranked suggestions, and the
     choice is saved. When several apps are equally plausible the plugin never
     guesses: starting the wrong game is worse than asking.
* Moonlight matches app names case-insensitively (`startstream.cpp`
  `getAppIndex`), and the plugin checks names the same way.

## 6. Reliability

| Situation | Behaviour |
|---|---|
| PC asleep/off | `GET /serverinfo` on port 47989 (no pairing needed) times out → Wake-on-LAN magic packet to the configured broadcast, 255.255.255.255, the /24 directed broadcast and the host IP on ports 9 and 7, resent every 10 s → poll until Apollo answers (default 90 s) → continue automatically. Cancellable. |
| MAC address unknown | Learned from the kernel ARP cache the first time the PC is online, imported from Moonlight's config, or entered by hand. |
| Apollo app deleted or renamed | The app list is re-checked before launch (cache older than 10 min or name not found) → "choose app" dialog with the current list. |
| Moonlight not paired / not installed | Detected beforehand (`flatpak info`, CLI error text) with a clear message. |
| Stream fails right after starting | The runner records the exit code and the tail of Moonlight's output → dialog with the reason. |
| Steam update changes the page layout | The patch finds nothing and logs a warning once. No button appears, Steam keeps working. |
| Plugin removed | The route patch is removed on unload. The hidden shortcut can be removed from the plugin (Steam API) or by hand. |

**Steam files are never edited directly.** The only persistent change in Steam
is the one hidden shortcut, created and removed through Steam's own API. Steam
stores it in `shortcuts.vdf` like any other non-Steam game. Steam updates
cannot be blocked or broken by the plugin. In the worst case an update hides
the button until the patch is adjusted.

## 7. Existing projects

| Project | What it does | Relation |
|---|---|---|
| [MoonDeck](https://github.com/FrogTheFrog/moondeck) (GPL-3.0) | Decky plugin that adds a launch button to Steam game pages and streams via Moonlight. Needs **MoonDeck Buddy** installed on the PC, which launches the Steam game itself, and works with Sunshine/Apollo. | The closest existing solution and proof that the game-page approach works. If you are happy to install Buddy on Windows, MoonDeck is mature and worth trying. Moondeck Apollo differs: **nothing is installed on the PC**, it streams *your Apollo apps* directly by name, the button sits under Play, and mapping, Wake-on-LAN and app creation are built in. No MoonDeck code is reused. |
| ProtonDB Badges, HLTB for Deck | Add elements to the game page via `routerHook.addPatch('/library/app/:appid')`. | Same injection technique. |
| decky-steamgriddb | Patches the game context menu. | Shows the context-menu route, and how much maintenance it needs. |
| moonlight-qt | `stream`, `list`, `pair`, `quit` CLI commands. | Used as-is. |
| Apollo (Sunshine fork) | GameStream host, web UI API, virtual display. | Used as-is. |

## 8. Code map

```
main.py                       Decky entry point (thin adapter)
py_modules/moondeck_apollo/
  service.py                  all backend operations, pre-flight checks, wake loop
  settings.py                 schema, validation, atomic save, backups/restore
  mapping.py                  title normalisation, AppID extraction, resolution
  apollo.py                   /serverinfo probe, web UI client, cert pinning
  moonlight.py                CLI argv, list parsing, error classification
  moonlight_conf.py           read-only import of hosts from Moonlight.conf
  wol.py                      magic packets, ARP lookup
  launch.py                   request/result hand-off files, runner install
  procenv.py                  clean environment for host binaries from Decky
bin/moonlight-runner.sh       executed by Steam via the hidden shortcut
src/index.tsx                 plugin definition, Quick Access panel
src/patches/libraryApp.tsx    game page injection
src/components/               button, dialogs, settings page
src/steam/runner.ts           hidden shortcut management, RunGame, running state
src/launcher.ts               launch orchestration and return navigation
tests/                        Python unit/integration tests, Vitest frontend tests
```
