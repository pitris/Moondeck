import { DialogButton, Focusable, Menu, MenuItem, MenuSeparator, Navigation, appDetailsClasses, appDetailsHeaderClasses, showContextMenu } from "@decky/ui";
import { useEffect, useRef, useState } from "react";
import { MoonIcon } from "./icons";
import { Placement, resolveApp } from "../backend";
import { useSettings } from "../store";
import { LaunchTarget, SETTINGS_ROUTE, isBusy, launchWithMoonlight, onBusyChange } from "../launcher";
import { alertModal, pickApp } from "./modals";
import { createApolloApp, createdMessage, setMapping, getApps, log, sleepPc, wakeHost } from "../backend";
import { toaster } from "@decky/api";
import { settingsStore } from "../store";

let mountLogged = false;

// Colours follow Steam's own blue action button (Install / Stream), so the
// option reads as part of the play bar rather than as a foreign widget.
const CSS = `
.mda-row { display: flex; align-items: center; gap: 10px; box-sizing: border-box; }
.mda-row.mda-below { padding: 10px 2.8vw 4px; }
.mda-anchor { position: relative; height: 0; z-index: 7; }
.mda-anchor .mda-row { position: absolute; right: 2.8vw; bottom: 14px; }
.mda-inrow { display: flex; align-self: stretch; align-items: stretch; margin-left: 16px; flex-shrink: 0; }
.mda-inrow .mda-row { gap: 1px; align-items: stretch; }
.mda-row .mda-launch, .mda-row .mda-more {
  color: #fff !important;
  background: linear-gradient(to right, #47bfff 0%, #1a44c2 60%) !important;
  background-size: 330% 100% !important; background-position: 25% 50% !important;
  transition: background-position 250ms ease, filter 150ms ease; box-shadow: none; margin: 0 !important;
}
.mda-row .mda-launch.gpfocus, .mda-row .mda-launch:hover,
.mda-row .mda-more.gpfocus, .mda-row .mda-more:hover { background-position: 0% 50% !important; filter: brightness(1.1); }
.mda-row .mda-launch:disabled { filter: grayscale(0.5) brightness(0.8); }
.mda-row .mda-launch {
  display: flex !important; align-items: center; justify-content: center; gap: 12px;
  width: auto !important; min-width: 200px; height: 48px; padding: 0 24px !important;
  font-size: 16px; font-weight: 500; border-radius: 2px 0 0 2px !important;
}
.mda-inrow .mda-launch {
  height: auto; min-height: 48px; min-width: 180px; padding: 0 18px !important;
  justify-content: flex-start; text-align: left;
}
.mda-text { display: flex; flex-direction: column; line-height: 1.15; }
.mda-title { font-size: 16px; font-weight: 500; text-transform: none; }
.mda-detail { font-size: 12px; font-weight: 400; opacity: 0.8; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-transform: none; }
.mda-row .mda-more {
  width: 38px !important; min-width: 38px !important; height: 48px; padding: 0 !important;
  display: flex !important; align-items: center; justify-content: center; border-radius: 0 2px 2px 0 !important;
  background-position: 60% 50% !important;
}
.mda-inrow .mda-more { height: auto; min-height: 48px; }
.mda-hint { font-size: 13px; opacity: 0.7; max-width: 32vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-left: 10px; }
`;

interface Props extends LaunchTarget {
  placement: Placement;
}

function useBusy(): boolean {
  const [b, setB] = useState(isBusy());
  useEffect(() => onBusyChange(setB), []);
  return b;
}

/** Hide the hero overlay while the header plays its fullscreen transition. */
function useHeroVisible(ref: React.RefObject<HTMLDivElement | null>, enabled: boolean): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (!enabled) return;
    const parent = ref.current?.parentElement;
    const header = parent ? Array.from(parent.children).find((c) => c.className.includes(appDetailsClasses.Header)) : undefined;
    const capsule = header
      ? Array.from(header.children).find((c) => c.className.includes(appDetailsHeaderClasses.TopCapsule))
      : undefined;
    if (!capsule) return;
    const fullscreen = [
      appDetailsHeaderClasses.FullscreenEnterStart,
      appDetailsHeaderClasses.FullscreenEnterActive,
      appDetailsHeaderClasses.FullscreenEnterDone,
      appDetailsHeaderClasses.FullscreenExitStart,
      appDetailsHeaderClasses.FullscreenExitActive,
    ].filter(Boolean);
    const update = () => setVisible(!fullscreen.some((c) => capsule.className.includes(c)));
    const mo = new MutationObserver(update);
    mo.observe(capsule, { attributes: true, attributeFilter: ["class"] });
    update();
    return () => mo.disconnect();
  }, [enabled]);
  return visible;
}

export interface OptionsMenuContext {
  name: string;
  pcName: string;
  mapped: string | null;
  webEnabled: boolean;
  launch: () => void;
  changeMapping: () => void;
}

/** Native Steam context menu behind the ▾ part of the button. */
export function showOptionsMenu(c: OptionsMenuContext, target: EventTarget): void {
  showContextMenu(
    <Menu label={c.pcName ? `Moonlight · ${c.pcName}` : "Moonlight"}>
      <MenuItem onSelected={c.launch}>Stream {c.name}</MenuItem>
      <MenuItem onSelected={c.changeMapping}>
        {c.mapped ? `Change Apollo app (now: ${c.mapped})…` : "Choose Apollo app…"}
      </MenuItem>
      <MenuSeparator />
      <MenuItem onSelected={async () => {
        const r = await wakeHost();
        toaster.toast({ title: "Moonlight", body: r.ok ? "Wake-on-LAN sent" : r.message });
      }}>Wake PC</MenuItem>
      {c.webEnabled && (
        <MenuItem onSelected={async () => {
          const r = await sleepPc();
          toaster.toast({ title: "Moonlight", body: r.ok ? "PC is going to sleep" : `Could not put the PC to sleep: ${r.message}` });
        }}>Put PC to sleep</MenuItem>
      )}
      <MenuSeparator />
      <MenuItem onSelected={() => Navigation.Navigate(SETTINGS_ROUTE)}>Moonlight settings…</MenuItem>
    </Menu>,
    target,
  );
}

export const MoonlightButton = ({ appid, name, isSteamGame, placement }: Props) => {
  const settings = useSettings();
  const busy = useBusy();
  const [hint, setHint] = useState<string>("");
  const [mapped, setMapped] = useState<string | null | undefined>(undefined); // undefined = not known yet
  const ref = useRef<HTMLDivElement | null>(null);
  const heroVisible = useHeroVisible(ref, placement === "hero");

  const refreshHint = async () => {
    try {
      const r = await resolveApp(appid, name);
      if (!r.ok) return;
      setMapped(r.app_name);
      setHint(r.app_name ? `Apollo: ${r.app_name}` : r.apps.length ? "Choose Apollo app on first launch" : "");
    } catch {
      /* hint is optional */
    }
  };

  useEffect(() => {
    refreshHint();
  }, [appid, settings?.mappings, settings?.apps_cache.fetched_at]);

  // Diagnostics: confirm the button really mounted and where it is on screen.
  useEffect(() => {
    if (mountLogged) return;
    mountLogged = true;
    setTimeout(() => {
      const el = ref.current;
      const r = el?.getBoundingClientRect();
      const btn = el?.querySelector(".mda-launch")?.getBoundingClientRect();
      log("info", `button mounted for ${name}: container ${r ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` : "none"}, ` +
        `button ${btn ? `${Math.round(btn.x)},${Math.round(btn.y)} ${Math.round(btn.width)}x${Math.round(btn.height)}` : "none"}, ` +
        `parent ${el?.parentElement?.className ?? "?"}, window ${window.innerWidth}x${window.innerHeight}`);
    }, 1500);
  }, []);

  const changeMapping = async () => {
    const cache = await getApps();
    const r = await resolveApp(appid, name);
    const apps = cache.ok ? cache.apps.filter((a) => !a.hidden).map((a) => a.name) : [];
    const choice = await pickApp({
      gameName: name,
      reason: r.ok && r.app_name ? `Currently: ${r.app_name}` : "Not mapped yet",
      candidates: r.ok ? r.candidates : [],
      apps,
      canCreate: isSteamGame && !!settingsStore.current?.apollo_web?.enabled,
    });
    if (choice?.kind === "map") {
      await setMapping(appid, choice.name, name);
      refreshHint();
    } else if (choice?.kind === "create") {
      const c = await createApolloApp(appid, name);
      if (c.ok) {
        toaster.toast({ title: "Moonlight", body: createdMessage(c) });
        settingsStore.load();
        refreshHint();
      } else {
        await alertModal("Could not add the game to Apollo", c.message);
      }
    }
  };

  const label = settings?.ui?.label || "Moonlight";
  const inRow = placement === "play_row";
  const pcName = settings?.host?.moonlight_name || settings?.host?.address || "";
  const webEnabled = !!settings?.apollo_web?.enabled;
  // Same wording as Steam's own "Stream from <PC>".
  const detail = mapped === null ? "Choose app on first launch" : pcName ? `from ${pcName}` : "Stream from your PC";
  const launch = () => launchWithMoonlight({ appid, name, isSteamGame });

  const openMenu = (e: MouseEvent) => showOptionsMenu(
    { name, pcName, mapped: mapped ?? null, webEnabled, launch, changeMapping },
    (e?.currentTarget as EventTarget | null) ?? window,
  );

  const row = (
    <Focusable className={`mda-row ${placement === "below_play" ? "mda-below" : ""}`} flow-children="horizontal">
      <DialogButton
        className="mda-launch"
        disabled={busy}
        onClick={launch}
        onSecondaryButton={changeMapping}
        onSecondaryActionDescription="Change Apollo app"
      >
        <MoonIcon />
        {inRow ? (
          <span className="mda-text">
            <span className="mda-title">{busy ? "Starting…" : label}</span>
            <span className="mda-detail">{detail}</span>
          </span>
        ) : (
          <span>{busy ? "Starting…" : label}</span>
        )}
      </DialogButton>
      <DialogButton className="mda-more" onClick={openMenu} aria-label="Moonlight options">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="M1.5 3.5h9L6 9z" /></svg>
      </DialogButton>
      {placement === "below_play" && hint && <div className="mda-hint">{hint}</div>}
    </Focusable>
  );

  return (
    <div ref={ref} className={placement === "hero" ? "mda-anchor" : inRow ? "mda-inrow" : undefined} id="moondeck-apollo">
      <style>{CSS}</style>
      {(placement !== "hero" || heroVisible) && row}
    </div>
  );
};
