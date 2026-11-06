# Uninstalling

Moondeck Apollo never edits Steam's files. It leaves behind only:

1. the hidden non-Steam shortcut "Moonlight (Apollo)" (or "*Game* (Moonlight)"),
2. its runtime and settings folders under `~/homebrew/`.

## Recommended (Gaming Mode)

1. Quick Access → Decky → Moondeck Apollo → **Settings & game mappings** →
   **Backup & uninstall** → **Remove Steam shortcut and runtime files…** → **Remove**.
   This removes the hidden shortcut through Steam's API, deletes the runtime
   files and keeps a settings backup.
2. Decky ⚙ → **Plugins** → Moondeck Apollo → **⋯** → **Uninstall**.

Settings and backups stay in `~/homebrew/settings/moondeck-apollo/`, so a later
reinstall picks up your host and game mappings again. Delete that folder to
remove everything.

## From Desktop Mode / SSH

```bash
bash scripts/uninstall.sh            # plugin + runtime files, keeps settings
bash scripts/uninstall.sh --purge    # also deletes settings (tar.gz backup in ~ first)
```

If you skipped step 1, remove the shortcut by hand in Gaming Mode:
Library → **Hidden** → "Moonlight (Apollo)" → ⚙ → **Manage** → **Remove non-Steam game**.

## Restore later

* In the plugin: **Backup & uninstall** → pick a backup → **Restore**.
* From a tarball: `bash scripts/restore-settings.sh ~/moondeck-apollo-settings-<time>.tar.gz`

Moonlight, its pairing, Apollo and any apps created on the PC are not touched by
uninstalling. Apps the plugin added to Apollo stay in Apollo until you delete
them in Apollo's web UI.
