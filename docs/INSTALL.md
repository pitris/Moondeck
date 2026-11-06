# Installation – Lenovo Legion Go S with SteamOS

Installation needs Desktop Mode **once** (Decky Loader's installer runs there).
After that everything happens in Gaming Mode.

## 0. Requirements

| Where | What |
|---|---|
| Windows 11 PC | Apollo installed and working; Wake-on-LAN set up if you want the PC to wake automatically (step 5) |
| Legion Go S | SteamOS (the official SteamOS edition, or SteamOS installed yourself); Moonlight **Flatpak** already paired with Apollo (you have this) |
| Legion Go S | Decky Loader v3.x |

Check that Moonlight can stream an Apollo app by itself before you start.

## 1. Install Decky Loader (skip if you already have it)

1. Hold the power button → **Switch to Desktop**.
2. If you never set a password for the `deck` user, open **Konsole** and run
   `passwd` (Decky's installer needs sudo).
3. Open the Decky Loader website, <https://decky.xyz>, in the browser, download
   the installer and run it, or in Konsole:

   ```bash
   curl -L https://github.com/SteamDeckHomebrew/decky-installer/releases/latest/download/install_release.sh | sh
   ```
4. Return to Gaming Mode (desktop shortcut **Return to Gaming Mode**).

## 2. Install Moondeck Apollo

### Option A: Decky's "Install from ZIP" (recommended)

1. Download `moondeck-apollo.zip` from this repository's **Releases** page into
   `~/Downloads`. Use Desktop Mode, or the Steam browser in Gaming Mode.
2. Gaming Mode → open the **Quick Access Menu** (the `⋯` button on the right of
   the screen) → **Decky** (plug icon) → ⚙ **Settings**.
3. **General** → enable **Developer mode**.
4. Open the new **Developer** tab → **Install Plugin from ZIP File** → **Browse**
   → pick `~/Downloads/moondeck-apollo.zip` → **Install**.
5. "Moondeck Apollo" now appears in the Decky menu.

### Option B: script (Desktop Mode or SSH)

```bash
git clone https://github.com/pitris/Moondeck.git && cd Moondeck
bash scripts/install.sh                       # downloads the latest release
# or, with a zip you built or downloaded:
bash scripts/install.sh out/moondeck-apollo.zip
```

### Option C: build from source

```bash
# on any Linux/macOS machine with Node 22 + pnpm 10, or on the Legion Go S in Desktop Mode
pnpm install
pnpm run package           # -> out/moondeck-apollo.zip
```

## 3. First-time setup (Gaming Mode)

1. Quick Access Menu → **Decky** → **Moondeck Apollo** → **Settings & game mappings**.
2. **Host** tab → **Import from Moonlight**. This copies the address, name and
   (if Moonlight knows it) the MAC address of the PC you paired. Or type the PC's
   IP in **PC address**. A fixed IP or DHCP reservation for the PC is strongly
   recommended.
3. Press **Check again**. *Gaming PC* should show **Online … (Apollo)** and
   *Moonlight* should show **Installed (flatpak)**.
4. **Apps & mappings** → **Reload app list from PC**. You should see the number
   of Apollo apps.
5. *(Optional but recommended)* **Apps & mappings** → enable **Use Apollo web UI**
   and enter the username/password of Apollo's web UI
   (`https://<pc>:47990`). This turns on exact Steam-AppID matching and lets
   you add missing games to Apollo from the handheld. Apollo allows one web
   session at a time, so a browser logged in on the PC gets signed out when the
   plugin reloads the list.
6. *(Optional)* **Button** tab → choose the button position and label.

## 4. Use it

Open any game in your library. Under Steam's **Play**/**Stream** button there is
now a **Moonlight** button.

* First launch of a game without an obvious Apollo match: pick the Apollo app
  once (or **Add “Game” to Apollo on the PC** if web UI access is enabled).
  The choice is saved.
* **⋯** next to the button (or the secondary action listed in the footer while the button is focused) changes the
  Apollo app for that game.
* To end a stream, use Moonlight's quit combo (**Select + Start + L1 + R1**),
  quit the game on the PC, or use Steam menu → **Exit game**. You are returned
  to the game's page.

## 5. Wake-on-LAN on the Windows PC (optional)

Moondeck Apollo can wake the PC automatically. On the PC:

1. **BIOS/UEFI:** enable *Wake on LAN* / *Power on by PCI-E*, and disable *ErP/EuP*
   (otherwise the NIC gets no power when the PC is off).
2. **Device Manager → Network adapters → (wired adapter) → Properties**
   * *Power Management*: tick **Allow this device to wake the computer** and
     **Only allow a magic packet to wake the computer**.
   * *Advanced*: **Wake on Magic Packet = Enabled**.
3. To wake from *shutdown* (not only sleep), turn off **Fast startup**
   (Control Panel → Power Options → Choose what the power buttons do).
4. Use a **wired** connection on the PC. The Legion Go S can be on Wi-Fi: most
   home routers pass the broadcast from Wi-Fi to the wired LAN. If yours does
   not, set **Broadcast address** to the LAN's broadcast (e.g. `192.168.1.255`)
   or the PC's IP.

The MAC address is learned automatically the first time the PC is online. You
can also press **Detect MAC address** or type it in.

## 6. Update

Install the new zip the same way (Decky replaces the old version). Settings and
mappings live in `~/homebrew/settings/moondeck-apollo/` and are kept.
