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
| `apollo_web.cert_sha256` | pinned | SHA-256 of Apollo's self-signed certificate, pinned on first use. If Apollo is reinstalled (new certificate), press **Forget** under *Pinned certificate*. |

Apps created from the handheld look like this in Apollo:

```json
{ "name": "Hades II", "detached": ["steam://rungameid/1145350"], "auto-detach": true, "wait-all": true }
```

You can edit them later in Apollo's web UI (cover art, prep commands, …). The
mapping only depends on the name.

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
| `moonlight.quit_app_after` | false | `--quit-after` (quit the game on the PC when the stream ends) |
| `moonlight.extra_args` | – | Appended verbatim (shell-style split) |

"Moonlight default" means the plugin passes no flag, so whatever you set in
Moonlight's own settings applies.

## Button

| Setting | Default | Meaning |
|---|---|---|
| `ui.placement` | `below_play` | `below_play`: a row directly under the play bar. `hero`: on the game artwork, bottom-right, above the play bar. |
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
