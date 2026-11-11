import {
  ButtonItem,
  ConfirmModal,
  DialogBody,
  DialogControlsSection,
  DialogControlsSectionHeader,
  Field,
  Navigation,
  SidebarNavigation,
  showModal,
} from "@decky/ui";
import { toaster } from "@decky/api";
import { ReactNode, useEffect, useState } from "react";
import {
  Backup,
  Status,
  backupSettings,
  detectMac,
  getStatus,
  importMoonlightHosts,
  listBackups,
  refreshApps,
  restoreBackup,
  setMapping,
  uninstallCleanup,
  wakeHost,
} from "../backend";
import { settingsStore, useSettings } from "../store";
import { removeRunner } from "../steam/runner";
import { SettingChoice, SettingText, SettingToggle, saveOrToast } from "./fields";
import { alertModal, ask } from "./modals";

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <DialogControlsSection>
    <DialogControlsSectionHeader>{title}</DialogControlsSectionHeader>
    {children}
  </DialogControlsSection>
);

function ago(ts: number): string {
  if (!ts) return "never";
  const s = Math.round(Date.now() / 1000 - ts);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return new Date(ts * 1000).toLocaleString();
}

export const BACKEND_DEAD =
  "Plugin backend is not responding. Restart the device; if it persists, send ~/homebrew/logs/moondeck-apollo/ (or `journalctl -u plugin_loader`).";

/** Rejects if the backend does not answer in time (a crashed backend never answers). */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

export function useStatus(): [Status | null, () => Promise<void>, boolean, string | null] {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => {
    setLoading(true);
    try {
      const r = await withTimeout(getStatus(), 25000);
      if (r.ok) setStatus(r);
      setError(null);
    } catch {
      setError(BACKEND_DEAD);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { refresh(); }, []);
  return [status, refresh, loading, error];
}

const HostPage = () => {
  const s = useSettings();
  const [status, refresh, loading, error] = useStatus();
  if (!s) return <DialogBody><Field label="Moondeck Apollo" description={error ?? "Loading settings…"} /></DialogBody>;
  const h = s.host;

  const importHosts = async () => {
    const r = await importMoonlightHosts();
    if (!r.ok || r.hosts.length === 0) {
      await alertModal("No hosts found", "Moonlight has no saved PCs yet. Pair your PC in Moonlight first.");
      return;
    }
    const pick = r.hosts.length === 1 ? r.hosts[0] : await ask<typeof r.hosts[0] | null>((done) => (
      <ConfirmModal strTitle="Import PC from Moonlight" bAlertDialog strOKButtonText="Cancel" onOK={() => done(null)} onCancel={() => done(null)}
        strDescription={<div>{r.hosts.map((x) => (
          <ButtonItem key={x.uuid || x.address} layout="below" onClick={() => done(x)}>{x.name} ({x.address})</ButtonItem>
        ))}</div>} />
    ), null);
    if (!pick) return;
    await saveOrToast({ host: { address: pick.address, moonlight_name: pick.name, ...(pick.mac ? { mac: pick.mac } : {}) } });
    toaster.toast({ title: "Moondeck Apollo", body: `Imported ${pick.name}` });
    refresh();
  };

  return (
    <DialogBody>
      <Section title="Status">
        <Field label="Gaming PC" description={status?.host.online
          ? `Online – ${status.host.hostname || h.address}${status.host.is_apollo ? " (Apollo)" : ""} ${status.host.appversion ?? ""}`
          : status ? `Offline${status.host.error ? ` – ${status.host.error}` : ""}` : error ?? "Checking…"} />
        <Field label="Moonlight" description={status ? (status.moonlight.installed ? `Installed (${status.moonlight.method})` : `Not found – ${status.moonlight.detail}`) : error ?? "Checking…"} />
        <ButtonItem layout="below" disabled={loading} onClick={refresh}>{loading ? "Checking…" : "Check again"}</ButtonItem>
      </Section>
      <Section title="Apollo host">
        <ButtonItem layout="below" onClick={importHosts} description="Copies the address, name and MAC of a PC you already paired in Moonlight.">Import from Moonlight</ButtonItem>
        <SettingText label="PC address" description="IP address or hostname of the Windows PC running Apollo." placeholder="192.168.1.50"
          value={h.address} toPatch={(v) => ({ host: { address: v } })} />
        <SettingText label="Moonlight host name (optional)" description="Name of the PC in Moonlight. Leave empty to use the address."
          value={h.moonlight_name} toPatch={(v) => ({ host: { moonlight_name: v } })} />
        <SettingText label="GameStream HTTP port" value={String(h.http_port)} toPatch={(v) => ({ host: { http_port: Number(v) } })} />
      </Section>
      <Section title="Wake-on-LAN">
        <SettingToggle label="Wake the PC automatically" description="When the PC does not respond, send a Wake-on-LAN packet and wait for Apollo." value={h.wol_enabled}
          toPatch={(v) => ({ host: { wol_enabled: v } })} />
        <SettingText label="PC MAC address" description="Learned automatically the first time the PC is online." placeholder="AA:BB:CC:DD:EE:FF"
          value={h.mac} toPatch={(v) => ({ host: { mac: v } })} />
        <ButtonItem layout="below" onClick={async () => {
          const r = await detectMac();
          if (r.ok) toaster.toast({ title: "Moondeck Apollo", body: `MAC ${r.mac}` });
          else await alertModal("Could not detect MAC", r.message);
          settingsStore.load();
        }}>Detect MAC address</ButtonItem>
        <SettingText label="Broadcast address" value={h.wol_broadcast} toPatch={(v) => ({ host: { wol_broadcast: v } })} />
        <SettingText label="Wake timeout (seconds)" value={String(h.wake_timeout)} toPatch={(v) => ({ host: { wake_timeout: Number(v) } })} />
        <ButtonItem layout="below" onClick={async () => {
          const r = await wakeHost();
          toaster.toast({ title: "Moondeck Apollo", body: r.ok ? `Wake-on-LAN sent (${r.sent} packets)` : r.message });
        }}>Send Wake-on-LAN now</ButtonItem>
      </Section>
    </DialogBody>
  );
};

const AppsPage = () => {
  const s = useSettings();
  const [busy, setBusy] = useState(false);
  if (!s) return null;
  const w = s.apollo_web;
  const mappings = Object.entries(s.mappings);

  const reload = async () => {
    setBusy(true);
    const r = await refreshApps();
    setBusy(false);
    if (r.ok) {
      toaster.toast({ title: "Moondeck Apollo", body: `${r.apps.length} Apollo apps loaded` });
      r.warnings.forEach((m) => toaster.toast({ title: "Moondeck Apollo", body: m }));
    } else {
      await alertModal("Could not load Apollo apps", r.message);
    }
    settingsStore.load();
  };

  return (
    <DialogBody>
      <Section title="Apollo applications">
        <Field label="Cached app list" description={`${s.apps_cache.apps.length} apps, ${s.apps_cache.source || "no source"}, updated ${ago(s.apps_cache.fetched_at)}`} />
        <ButtonItem layout="below" disabled={busy} onClick={reload}>{busy ? "Loading…" : "Reload app list from PC"}</ButtonItem>
        <Field label="Automatic matching" description="1) your saved choice, 2) an Apollo app that launches the game's Steam AppID (needs web UI access below), 3) an Apollo app with the same name. Otherwise you are asked once on first launch." />
      </Section>
      <Section title={`Game mappings (${mappings.length})`}>
        {mappings.length === 0 && <Field label="None yet" description="Mappings are created when you pick an Apollo app for a game." />}
        {mappings.map(([appid, m]) => (
          <Field key={appid} label={m.steam_name || `AppID ${appid}`} description={`→ ${m.app_name}${m.source === "created" ? " (created on PC)" : ""}`}>
            <ButtonItem onClick={() => setMapping(Number(appid), null, "").then(() => settingsStore.load())}>Remove</ButtonItem>
          </Field>
        ))}
      </Section>
      <Section title="Apollo web UI access (optional)">
        <Field label="Why?" description="With your Apollo web UI login the plugin can read which Steam AppID each Apollo app starts (exact matching) and add missing games to Apollo from the Legion Go. Note: Apollo allows one web session at a time, so this signs out a browser that is logged in on the PC." />
        <SettingToggle label="Use Apollo web UI" value={w.enabled} toPatch={(v) => ({ apollo_web: { enabled: v } })} />
        <SettingText label="Username" value={w.username} toPatch={(v) => ({ apollo_web: { username: v } })} />
        <SettingText label="Password" password value="" placeholder={w.password_set ? "•••••• (saved)" : ""}
          toPatch={(v) => ({ apollo_web: { password: v } })} />
        <SettingToggle label="New Apollo apps use the virtual display"
          description="Apps added from here get Apollo's “Always create Virtual Display” option, so the game runs on a virtual screen sized for the Legion (and your PC screen can stay off). Pressing “Add to Apollo” again on an existing app turns it on there too."
          value={w.new_app_virtual_display} toPatch={(v) => ({ apollo_web: { new_app_virtual_display: v } })} />
        <SettingText label="Web UI port" value={String(w.port)} toPatch={(v) => ({ apollo_web: { port: Number(v) } })} />
        <Field label="Pinned certificate" description={w.cert_sha256 ? `SHA-256 ${w.cert_sha256.slice(0, 16)}…` : "Not pinned yet (pinned on first successful connection)"}>
          {w.cert_sha256 && <ButtonItem onClick={() => saveOrToast({ apollo_web: { cert_sha256: "" } })}>Forget</ButtonItem>}
        </Field>
        {w.password_set && <ButtonItem layout="below" onClick={() => saveOrToast({ apollo_web: { clear_password: true } })}>Delete saved password</ButtonItem>}
      </Section>
    </DialogBody>
  );
};

const opt = (pairs: string[]): [string, string][] => pairs.map((p) => [p, p || "Moonlight default"]);

const MoonlightPage = () => {
  const s = useSettings();
  if (!s) return null;
  const m = s.moonlight;
  return (
    <DialogBody>
      <Section title="Moonlight program">
        <SettingText label="Flatpak ID" value={m.flatpak_id} toPatch={(v) => ({ moonlight: { flatpak_id: v } })} />
        <SettingText label="Custom Moonlight executable (optional)" description="Absolute path to an AppImage/binary. Leave empty to use the Flatpak."
          value={m.custom_path} toPatch={(v) => ({ moonlight: { custom_path: v } })} />
      </Section>
      <Section title="Stream overrides">
        <Field label="" description="Leave on “Moonlight default” to use the settings saved inside Moonlight." />
        <SettingChoice label="Resolution" value={m.resolution} options={opt(["", "1280x800", "1920x1080", "1920x1200", "2560x1440", "2560x1600"])}
          toPatch={(v) => ({ moonlight: { resolution: v } })} />
        <SettingChoice label="Frame rate" value={m.fps} options={opt(["", "30", "40", "60", "90", "120"])} toPatch={(v) => ({ moonlight: { fps: v } })} />
        <SettingText label="Bitrate (Kbps)" value={m.bitrate_kbps} placeholder="Moonlight default" toPatch={(v) => ({ moonlight: { bitrate_kbps: v } })} />
        <SettingChoice label="Display mode" value={m.display_mode} options={opt(["", "fullscreen", "borderless", "windowed"])} toPatch={(v) => ({ moonlight: { display_mode: v } })} />
        <SettingChoice label="Video codec" value={m.video_codec} options={opt(["", "auto", "H.264", "HEVC", "AV1"])} toPatch={(v) => ({ moonlight: { video_codec: v } })} />
        <SettingChoice label="HDR" value={m.hdr} options={[["", "Moonlight default"], ["on", "On"], ["off", "Off"]]} toPatch={(v) => ({ moonlight: { hdr: v } })} />
        <SettingChoice label="Performance overlay" value={m.performance_overlay} options={[["", "Moonlight default"], ["on", "On"], ["off", "Off"]]} toPatch={(v) => ({ moonlight: { performance_overlay: v } })} />
        <SettingToggle label="Quit the game on the PC when the stream ends" value={m.quit_app_after} toPatch={(v) => ({ moonlight: { quit_app_after: v } })} />
        <SettingText label="Extra Moonlight arguments" placeholder="--no-vsync" value={m.extra_args} toPatch={(v) => ({ moonlight: { extra_args: v } })} />
      </Section>
    </DialogBody>
  );
};

const ButtonPage = () => {
  const s = useSettings();
  if (!s) return null;
  return (
    <DialogBody>
      <Section title="Game page button">
        <SettingChoice label="Position" description="Takes effect the next time a game page opens."
          value={s.ui.placement}
          options={[["play_row", "Next to the Play button"], ["below_play", "Below the play bar"], ["hero", "On the game artwork, above the play bar"]]}
          toPatch={(v) => ({ ui: { placement: v } })} />
        <SettingText label="Button label" value={s.ui.label} toPatch={(v) => ({ ui: { label: v } })} />
        <SettingToggle label="Show on non-Steam games" description="Requires a manual mapping (no Steam AppID)." value={s.ui.show_on_non_steam}
          toPatch={(v) => ({ ui: { show_on_non_steam: v } })} />
        <SettingToggle label="Show the game's name while streaming" description="Renames the hidden Moonlight shortcut to “<Game> (Moonlight)” for each session."
          value={s.ui.rename_runner_per_launch} toPatch={(v) => ({ ui: { rename_runner_per_launch: v } })} />
      </Section>
      <Section title="Controls">
        <Field label="Change the Apollo app for a game" description="Press ⋯ next to the button, or use the secondary action shown in the button bar while the Moonlight button is focused." />
        <Field label="Controller layout" description="Moonlight runs as the hidden shortcut “Moonlight (Apollo)”. Its Steam Input layout (default: Gamepad) applies to every Moonlight session. To change it, find the shortcut under Library → Hidden." />
      </Section>
    </DialogBody>
  );
};

const MaintenancePage = () => {
  const [backups, setBackups] = useState<Backup[]>([]);
  const reload = async () => {
    const r = await listBackups();
    if (r.ok) setBackups(r.backups);
  };
  useEffect(() => { reload(); }, []);

  const restore = (name: string) => showModal(
    <ConfirmModal strTitle="Restore backup?" strDescription={`Replace current settings and mappings with ${name}? A backup of the current state is made first.`}
      strOKButtonText="Restore" onOK={async () => {
        const r = await restoreBackup(name);
        toaster.toast({ title: "Moondeck Apollo", body: r.ok ? "Settings restored" : r.message });
        settingsStore.load();
        reload();
      }} />,
  );

  const uninstall = () => showModal(
    <ConfirmModal strTitle="Prepare for uninstall" bDestructiveWarning
      strDescription="Removes the hidden “Moonlight (Apollo)” Steam shortcut and the plugin's runtime files. Settings and a fresh backup are kept in ~/homebrew/settings so a reinstall can restore them. Afterwards uninstall the plugin in Decky."
      strOKButtonText="Remove" onOK={async () => {
        const removed = await removeRunner();
        const r = await uninstallCleanup(true);
        await alertModal("Ready to uninstall", `${removed ? "Steam shortcut removed." : "Could not remove the Steam shortcut – delete “Moonlight (Apollo)” from Library → Hidden manually."} ${r.ok ? `Backup: ${r.backup}` : r.message}. Now uninstall Moondeck Apollo from Decky's settings.`);
      }} />,
  );

  return (
    <DialogBody>
      <Section title="Backups">
        <ButtonItem layout="below" onClick={async () => {
          const r = await backupSettings("manual");
          if (r.ok) { setBackups(r.backups); toaster.toast({ title: "Moondeck Apollo", body: `Saved ${r.name}` }); }
        }}>Back up settings and mappings now</ButtonItem>
        {backups.length === 0 && <Field label="No backups yet" />}
        {backups.map((b) => (
          <Field key={b.name} label={b.name} description={new Date(b.mtime * 1000).toLocaleString()}>
            <ButtonItem onClick={() => restore(b.name)}>Restore</ButtonItem>
          </Field>
        ))}
      </Section>
      <Section title="Uninstall">
        <ButtonItem layout="below" onClick={uninstall}>Remove Steam shortcut and runtime files…</ButtonItem>
      </Section>
    </DialogBody>
  );
};

const DiagnosticsPage = () => {
  const [status, refresh] = useStatus();
  const last = status?.last_session;
  return (
    <DialogBody>
      <Section title="Last Moonlight session">
        {!last && <Field label="No session yet" />}
        {last && <>
          <Field label="App" description={`${last.app_name || "?"} (Steam AppID ${last.steam_appid || "?"})`} />
          <Field label="Result" description={`exit code ${last.exit_code}, ${last.duration ?? "?"}s`} />
          <Field label="Moonlight output" description={<pre style={{ whiteSpace: "pre-wrap", fontSize: 11, maxHeight: 300, overflow: "auto" }}>{last.log_tail || "(empty)"}</pre>} />
        </>}
        <ButtonItem layout="below" onClick={refresh}>Refresh</ButtonItem>
      </Section>
      <Section title="Logs">
        <Field label="Plugin log" description="~/homebrew/logs/<plugin folder>/ (backend and frontend messages)" />
      </Section>
    </DialogBody>
  );
};

export const SettingsPage = () => (
  <SidebarNavigation
    title="Moondeck Apollo"
    showTitle
    pages={[
      { title: "Host", content: <HostPage /> },
      { title: "Apps & mappings", content: <AppsPage /> },
      { title: "Moonlight", content: <MoonlightPage /> },
      { title: "Button", content: <ButtonPage /> },
      { title: "Backup & uninstall", content: <MaintenancePage /> },
      { title: "Diagnostics", content: <DiagnosticsPage /> },
    ]}
  />
);

export function openSettings(): void {
  Navigation.CloseSideMenus();
  Navigation.Navigate("/moondeck-apollo");
}
