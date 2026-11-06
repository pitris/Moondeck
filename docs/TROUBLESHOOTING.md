# Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No Moonlight button on game pages | The plugin log says *"game page layout not recognised"*, so a Steam client update changed the page. Steam itself is fine. Update the plugin or open an issue with the log. Check also that the page is a game (tools, DLC and soundtracks are skipped) and, for non-Steam shortcuts, that **Show on non-Steam games** is on. |
| "Moonlight was not found" | Install the Moonlight Flatpak from Discover, or set **Custom Moonlight executable**. |
| "Moonlight is not paired with this PC" | Open Moonlight once, pair with Apollo (PIN in Apollo's web UI), then **Reload app list**. |
| "Your PC is not responding" right away | Wrong address, PC off and Wake-on-LAN off, or a firewall blocking TCP 47989 on the PC. Try `http://<pc>:47989/serverinfo` in a browser. |
| Wake-on-LAN does nothing | See INSTALL.md §5 (BIOS, NIC power settings, Fast startup, wired NIC). Set **Broadcast address** to your LAN broadcast (e.g. 192.168.1.255). Some mesh routers drop broadcasts from Wi-Fi; use the PC's IP as the broadcast address while its ARP entry is still cached. |
| Wrong game streams | A saved mapping points to the wrong app. Press ⋯ on the game page and choose another one, or remove it in **Apps & mappings**. |
| Apollo web UI: "certificate changed" | Apollo was reinstalled (new certificate). **Apps & mappings → Pinned certificate → Forget**, then reload. |
| Apollo web UI: login rejected | Wrong credentials, or Apollo's *Origin Web UI Allowed* is `pc`. Set it to `lan` in Apollo's configuration. |
| Browser on the PC gets logged out of Apollo | Expected: Apollo allows one web session. Turn web UI access off if that bothers you; name matching via Moonlight still works. |
| Moonlight window black / not focused | Report it with the plugin log. As a check, add Moonlight as a normal non-Steam game and see whether it is focused there. |
| Controls feel wrong in Moonlight | Change the layout of the hidden shortcut: Library → Hidden → Moonlight (Apollo) → controller icon. Use the **Gamepad** template. |
| Stream ends straight away with an error dialog | **Settings → Diagnostics** shows Moonlight's output (e.g. "Failed to find application …"). |
