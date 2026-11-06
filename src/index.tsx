import { ButtonItem, Field, PanelSection, PanelSectionRow, staticClasses } from "@decky/ui";
import { definePlugin, routerHook, toaster } from "@decky/api";
import { useState } from "react";
import { log, refreshApps, wakeHost } from "./backend";
import { MoonIcon } from "./components/icons";
import { SettingsPage, openSettings, useStatus } from "./components/SettingsPage";
import { SETTINGS_ROUTE } from "./launcher";
import { patchLibraryApp } from "./patches/libraryApp";
import { ensureRunner } from "./steam/runner";
import { settingsStore, useSettings } from "./store";

const QuickAccess = () => {
  const s = useSettings();
  const [status, refresh, loading] = useStatus();
  const [busy, setBusy] = useState(false);
  const host = s?.host;

  return (
    <PanelSection title="Apollo PC">
      <PanelSectionRow>
        <Field
          label={host?.moonlight_name || host?.address || "Not configured"}
          description={!host?.address ? "Open settings to add your PC" : status ? (status.host.online ? "Online" : "Offline") : "Checking…"}
        />
      </PanelSectionRow>
      {status && !status.moonlight.installed && (
        <PanelSectionRow>
          <Field label="Moonlight not found" description="Install Moonlight from Discover (Flatpak)." />
        </PanelSectionRow>
      )}
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={loading} onClick={refresh}>{loading ? "Checking…" : "Check connection"}</ButtonItem>
      </PanelSectionRow>
      {host?.mac && status && !status.host.online && (
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={async () => {
            const r = await wakeHost();
            toaster.toast({ title: "Moondeck Apollo", body: r.ok ? "Wake-on-LAN sent" : r.message });
            setTimeout(refresh, 8000);
          }}>Wake PC</ButtonItem>
        </PanelSectionRow>
      )}
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={busy || !host?.address} onClick={async () => {
          setBusy(true);
          const r = await refreshApps();
          setBusy(false);
          toaster.toast({ title: "Moondeck Apollo", body: r.ok ? `${r.apps.length} Apollo apps loaded` : r.message });
          settingsStore.load();
        }}>{busy ? "Loading…" : `Reload Apollo apps (${s?.apps_cache.apps.length ?? 0})`}</ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={openSettings}>Settings & game mappings</ButtonItem>
      </PanelSectionRow>
    </PanelSection>
  );
};

export default definePlugin(() => {
  settingsStore.load().then(async (s) => {
    // Create/verify the hidden runner shortcut early so the first launch is fast.
    if (s?.host.address) {
      const id = await ensureRunner();
      log("info", `runner shortcut ${id ?? "unavailable"}`);
    }
  });
  const unpatch = patchLibraryApp();
  routerHook.addRoute(SETTINGS_ROUTE, SettingsPage);

  return {
    name: "Moondeck Apollo",
    titleView: <div className={staticClasses.Title}>Moondeck Apollo</div>,
    content: <QuickAccess />,
    icon: <MoonIcon />,
    onDismount() {
      unpatch();
      routerHook.removeRoute(SETTINGS_ROUTE);
    },
  };
});
