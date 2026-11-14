# Configuration reference

All settings are edited in Gaming Mode: **Quick Access → Decky → Moondeck Apollo
→ Settings & game mappings**. They are stored in
`~/homebrew/settings/moondeck-apollo/settings.json` (mode 600). That file is
written atomically and validated on every save, so a broken hand edit is moved
aside as `settings.json.corrupt-<time>` and defaults are used instead.

## Host

| Setting | Default | Meaning |
|---|---|---|
| `host.address` | – | IP or hostname of the Apollo PC. Used for the online check, Wake-on-LAN and (if no Moonlight name is set) as Moonlight's host argument. |
| `host.moonlight_name` | – | Name under which Moonlight knows the PC. Optional; Moonlight accepts the IP too. |
| `host.http_port` | 47989 | Apollo's GameStream HTTP port (`/serverinfo`). |
| `host.mac` | learned | MAC of the PC's wired NIC, for Wake-on-LAN. |
| `host.wol_enabled` | true | Wake automatically when the PC does not answer. |
| `host.wol_broadcast` | 255.255.255.255 | Extra broadcast target. The /24 directed broadcast and the host IP are always tried too. |
| `host.wake_timeout` | 90 | Seconds to wait for Apollo after waking. |

## Apollo web UI (optional)

| Setting | Default | Meaning |
|---|---|---|
| `apollo_web.enabled` | false | Read app commands for exact Steam AppID matching; allow creating apps. |
| `apollo_web.port` | 47990 | Web UI port. |
| `apollo_web.username` / `password` | – | Web UI login. The password is stored only in this file; the UI never receives it back. |
| `apollo_web.new_app_virtual_display` | true | Apps created from the handheld get Apollo's **Always create Virtual Display** option. Pressing *Add to Apollo* on an existing app turns it on there as well. |
| `apollo_web.cert_sha256` | pinned | SHA-256 of Apollo's self-signed certificate, pinned on first use. If Apollo is reinstalled (new certificate), press **Forget** under *Pinned certificate*. |

Apps created from the handheld look like this in Apollo:

```json
{ "name": "Hades II", "detached": ["steam://rungameid/1145350"], "auto-detach": true, "wait-all": true, "virtual-display": true }
```

**Virtual display.** Apollo creates its virtual display (and, with its isolated
display option, turns the physical screen off) only when the app has
*Always create Virtual Display*, Headless mode is on, or the client asks for
it. Regular Moonlight does not ask (Apollo's own client Artemis does). So
either keep the option above on, or enable it once per device in Apollo's web
UI: client list → your Legion → **Always create virtual display**. That
covers every app streamed to the Legion.

You can edit them later in Apollo's web UI (cover art, prep commands, …). The
mapping only depends on the name.

## Sleep and wake with the Legion

| Setting | Default | Meaning |
|---|---|---|
| `power.wake_on_resume` | true | When the Legion wakes up and a Moonlight stream was running when it went to sleep, send Wake-on-LAN (immediately, then after 3, 8, 15 and 25 s while Wi-Fi reconnects). |
| `power.sleep_pc_on_suspend` | false | When the Legion goes to sleep **during a Moonlight stream**, put the PC to sleep right away. Needs Apollo web UI access. |
| `power.sleep_app_uuid` | set automatically | The Apollo app used for sleeping. |

Two independent triggers detect the Legion going to sleep (Steam's sleep
manager with a suspend block, and the plain system notification); whichever
fires first sends the request. Every step is recorded under **Settings →
Diagnostics → Sleep and wake**, and a failed request is shown as a notification
after the Legion wakes up. Before the next launch the plugin ends a leftover
"Sleep PC" app in Apollo so Moonlight never asks to quit it.

How PC sleep works: turning the option on adds an Apollo app **"Moondeck: Sleep PC"**
(hidden from the game pickers) whose command waits 3 s and then calls Windows'
`SetSuspendState('Suspend')`. That is real sleep, not hibernate. When you put the
Legion to sleep during a stream, the plugin briefly holds the Legion's suspend
(Steam's `SuspendResumeStore.BlockSuspendAction`), asks Apollo to start that
app through its web API, and then lets the Legion sleep. If the PC does not
answer within 4 s the Legion sleeps anyway, so it is never kept awake. Starting
an app makes Apollo end its current app: games added by this plugin are started
through Steam and keep running, but an Apollo app that runs a game program
directly would be closed. When the PC wakes, Apollo's virtual display is
created again when Moonlight reconnects; most games cope, some may move to
the main monitor.

## Moonlight

| Setting | Default | CLI flag |
|---|---|---|
| `moonlight.flatpak_id` | com.moonlight_stream.Moonlight | `flatpak run <id>` |
| `moonlight.custom_path` | – | Use this executable instead of the Flatpak |
| `moonlight.resolution` | Moonlight default | `--resolution WxH` |
| `moonlight.fps` | Moonlight default | `--fps` |
| `moonlight.bitrate_kbps` | Moonlight default | `--bitrate` |
| `moonlight.display_mode` | Moonlight default | `--display-mode fullscreen/borderless/windowed` |
| `moonlight.video_codec` | Moonlight default | `--video-codec auto/H.264/HEVC/AV1` |
| `moonlight.hdr` | Moonlight default | `--hdr` / `--no-hdr` |
| `moonlight.performance_overlay` | Moonlight default | `--performance-overlay` / `--no-performance-overlay` |
| `moonlight.end_session_on_exit` | true | When a stream ends, the plugin ends Apollo's session (web API `POST /api/apps/close`, or `moonlight quit <host>` without web UI access), so Moonlight does not show the app as still running. Games started through Steam keep running on the PC. Skipped when the stream died because the Legion was asleep, so the next launch resumes straight away. |
| `moonlight.quit_app_after` | false | `--quit-after` (quit the game on the PC when the stream ends) |
| `moonlight.extra_args` | – | Appended verbatim (shell-style split) |

"Moonlight default" means the plugin passes no flag, so whatever you set in
Moonlight's own settings applies.

## Button

| Setting | Default | Meaning |
|---|---|---|
| `ui.placement` | `play_row` | `play_row`: inside Steam's play bar, right after the Play/Stream button. `below_play`: a row under the play bar. `hero`: on the game artwork, bottom-right. The last two use the older page structure and are kept as fallbacks. |
| `ui.label` | Moonlight | Button text. |
| `ui.show_on_non_steam` | true | Also show the button on non-Steam shortcuts (manual mapping only). |
| `ui.rename_runner_per_launch` | true | Show "*Game* (Moonlight)" as the running game's name. |

## Game mappings

`mappings` maps a Steam AppID (string) to an Apollo app name:

```json
"mappings": {
  "1091500": { "app_name": "Cyberpunk 2077", "source": "manual", "steam_name": "Cyberpunk 2077" }
}
```

Mappings are created when you pick an app (or create one) on first launch, and
can be changed with **⋯** on the game page or removed in **Apps & mappings**.
A mapping always wins over automatic matching.

## Backup and restore

* **Backup & uninstall → Back up settings and mappings now** writes a timestamped
  copy to `~/homebrew/settings/moondeck-apollo/backups/` (the last 20 are kept).
  Backups are also made automatically before a restore and before uninstall
  cleanup.
* **Restore** replaces settings and mappings with the chosen backup, after first
  backing up the current state. The runner shortcut id is kept, because it
  belongs to this Steam installation.
* From Desktop Mode: `scripts/install.sh` and `scripts/uninstall.sh` also save a
  `~/moondeck-apollo-settings-<time>.tar.gz`; restore it with
  `scripts/restore-settings.sh <file>`.

## Files the plugin creates

| Path | Purpose |
|---|---|
| `~/homebrew/plugins/moondeck-apollo/` | the plugin (managed by Decky) |
| `~/homebrew/settings/moondeck-apollo/` | settings, mappings, backups |
| `~/homebrew/data/moondeck-apollo/` | `moonlight-runner.sh` (copy), one-shot launch request, last session result + Moonlight log |
| `~/homebrew/logs/moondeck-apollo/` | plugin log |
| Steam: hidden non-Steam shortcut "Moonlight (Apollo)" | launch vehicle (Steam API) |

If Decky's data folder name contains a space, the runtime files go to
`~/.local/share/moondeck-apollo/` instead, so the shortcut target never needs
quoting.
