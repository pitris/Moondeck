# Moondeck Apollo

**Stream any game from your Windows PC (Apollo) with Moonlight, straight from
the game's own page in SteamOS Gaming Mode.**

A [Decky Loader](https://decky.xyz) plugin, built for a Lenovo Legion Go S on
SteamOS and an Apollo host on Windows 11. Each game page gets a **Moonlight**
option right next to Steam's own **Play / Stream** button:

```
┌──────────────────────────────────────────────────────────────┐
│                     Cyberpunk 2077 artwork                   │
├──────────────────────────────────────────────────────────────┤
│ [ ▶ Play ▾ ] [ ☾ Moonlight      ][⋯]  Last played …   ⚙  ⓘ  ☆  │
│              [   Apollo: Cyberpunk ]                            │
└──────────────────────────────────────────────────────────────┘
```

Press it and the plugin:

1. identifies the game (Steam AppID + name) and finds the matching **Apollo app**;
2. checks the PC is online and **wakes it** with Wake-on-LAN if needed;
3. starts **Moonlight directly into that app**, without the Moonlight app list,
   as a Steam-launched process, so gamescope focuses it and **Steam Input**
   works;
4. returns you to the game's page in Gaming Mode when the stream ends.

> **Plugin name.** The repository is called *Moondeck*, but the plugin is called
> **Moondeck Apollo** (`moondeck-apollo`) so it does not clash with
> FrogTheFrog's separate [MoonDeck](https://github.com/FrogTheFrog/moondeck)
> plugin. The two are unrelated and can be installed side by side.

## Honest status

* ✅ Complete implementation: Decky frontend (TypeScript/React), Python backend,
  Steam runner script, settings UI, backups, uninstall helper.
* ✅ 39 Python tests (fake Apollo server, fake Moonlight, real runner script,
  the packaged zip loaded like Decky loads it) and 13 frontend tests (mocked
  Steam/Decky APIs). Type check and build pass. See
  [docs/TESTING.md](docs/TESTING.md).
* ⚠️ **Not yet tested on a real Legion Go S / Steam client.** It was developed
  without access to SteamOS hardware. The Steam integration uses the same
  injection technique as established Decky plugins, but it is unverified on the
  current Steam client. Run the [on-device checklist](docs/TESTING.md#on-device-acceptance-checklist-legion-go-s)
  and please report the results.

## What Steam does and does not allow (summary)

Full research: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

* **Steam has no API for third-party launch providers.** "Stream" is not a
  plugin slot. It is the same Play action aimed at another *Steam* client that
  native Steam found on the network (`overview.per_client_data`). A plugin
  cannot add an entry there safely.
* **What Decky can do:** patch the React tree of Steam's game page at runtime.
  Moondeck Apollo adds its own button into the play bar, right after Steam's
  Play button (the technique OpenNOW uses on current Steam clients), with the
  older MoonDeck/ProtonDB-style placement as a fallback.
* **Compromises:**
  * the Moonlight option is a **separate button next to Play/Stream** in the
    same play bar, not an entry inside Steam's Play/Stream dropdown;
  * Moonlight runs through **one hidden, automatically managed Steam shortcut**.
    Without it Steam Input and window focus would not work. It is not per game,
    you never create it, and it does not appear in the library;
  * that shortcut's controller layout is **shared by all Moonlight sessions**;
  * Steam updates can change the page structure. If that happens the button
    simply does not appear (Steam keeps working) until the plugin is updated.
* **Steam files are never modified directly.** The shortcut is created and
  removed through Steam's own `SteamClient` API.

## Features

* **Native-looking Moonlight button** on every Steam game page (optionally also
  on non-Steam shortcuts), with gamepad focus and a moon icon, placed next to
  Play (or below the play bar / on the artwork).
* **Automatic game → Apollo app mapping**: saved choice → Apollo app that
  launches the same Steam AppID (via Apollo's web UI API) → same name
  (ignores ™/®, punctuation, case and Roman numerals). If nothing matches you
  pick once and the choice is remembered. The plugin never guesses between
  several candidates.
* **Add a missing game to Apollo from the handheld** (optional, with Apollo web
  UI login). It creates an app that runs `steam://rungameid/<appid>` on the PC.
* **Sleep and wake with the Legion:** if a stream was running, waking the
  Legion wakes the PC (Wake-on-LAN). Optionally, putting the Legion to sleep
  during a stream puts the PC to sleep too (through an Apollo app, with nothing
  installed on the PC).
* **PC offline handling:** Wake-on-LAN with progress and cancel; the MAC address
  is learned automatically; clear offline dialog with Retry.
* **Missing app handling:** the app list is re-checked before launch; renamed or
  deleted apps lead to the picker, not a failed stream.
* **Moonlight overrides** (resolution, FPS, bitrate, codec, HDR, display mode,
  quit-after, extra args), or keep Moonlight's own settings.
* **Import the host from Moonlight** (read-only), so you don't retype the address.
* **Backups/restore** of settings and mappings, automatic backups before
  restore/uninstall, and a one-click uninstall preparation.
* Diagnostics page with the last session's exit code and Moonlight output.

## Requirements

* SteamOS in Gaming Mode on the Legion Go S, with Decky Loader 3.x
* Moonlight (Flatpak `com.moonlight_stream.Moonlight`), already paired with Apollo
* Apollo on the Windows PC. Upstream Sunshine should also work (the web UI
  features fall back to Basic auth), but only Apollo's API was checked.
* Nothing needs to be installed on the PC.

## Install

Short version (details: [docs/INSTALL.md](docs/INSTALL.md)):

1. Install Decky Loader (once, in Desktop Mode).
2. Download `moondeck-apollo.zip` from **Releases**.
3. Gaming Mode → Quick Access → Decky → ⚙ → enable **Developer mode** →
   **Developer → Install Plugin from ZIP File**.
4. Quick Access → Moondeck Apollo → **Settings** → Host → **Import from Moonlight**
   → **Reload app list**.
5. Open a game → **Moonlight**.

## Documentation

* [Installation (Legion Go S)](docs/INSTALL.md)
* [Configuration & game mappings](docs/CONFIGURATION.md)
* [Testing (automated + on-device checklist)](docs/TESTING.md)
* [Uninstall / backup / restore](docs/UNINSTALL.md)
* [Troubleshooting](docs/TROUBLESHOOTING.md)
* [Research & architecture](docs/ARCHITECTURE.md)

## Development

```bash
pnpm install
pnpm run typecheck && pnpm run test:frontend
pnpm run package          # dist/ + out/moondeck-apollo.zip
pnpm run test:backend
```

Layout: `src/` frontend, `main.py` + `py_modules/moondeck_apollo/` backend,
`bin/moonlight-runner.sh` (executed by Steam), `tests/`, `scripts/` (package,
install, uninstall, restore), `docs/`.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE). Moonlight and Apollo are separate
projects by their respective authors; this plugin only calls their documented
command-line and HTTP interfaces.
