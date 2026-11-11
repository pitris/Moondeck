import { DialogButton, Focusable, appDetailsClasses, appDetailsHeaderClasses } from "@decky/ui";
import { useEffect, useRef, useState } from "react";
import { MoonIcon } from "./icons";
import { Placement, resolveApp } from "../backend";
import { useSettings } from "../store";
import { LaunchTarget, isBusy, launchWithMoonlight, onBusyChange } from "../launcher";
import { pickApp } from "./modals";
import { setMapping, getApps, log } from "../backend";

let mountLogged = false;

const CSS = `
.mda-row { display: flex; align-items: center; gap: 10px; box-sizing: border-box; }
.mda-row.mda-below { padding: 10px 2.8vw 4px; }
.mda-anchor { position: relative; height: 0; z-index: 7; }
.mda-anchor .mda-row { position: absolute; right: 2.8vw; bottom: 14px; }
.mda-inrow { display: flex; align-self: stretch; align-items: stretch; margin-left: 16px; flex-shrink: 0; }
.mda-inrow .mda-row { gap: 6px; align-items: stretch; }
.mda-row .mda-launch {
  display: flex !important; align-items: center; justify-content: center; gap: 10px;
  width: auto !important; min-width: 200px; height: 48px; padding: 0 28px !important;
  font-size: 18px; font-weight: 700; letter-spacing: 0.02em; border-radius: 3px !important;
  color: #fff !important; background: linear-gradient(90deg, #3f51b5 0%, #5c6bc0 100%) !important;
  box-shadow: 0 2px 6px rgba(0,0,0,0.4); transition: filter 120ms ease, transform 120ms ease;
}
.mda-inrow .mda-launch {
  height: auto; min-height: 48px; min-width: 190px; padding: 0 18px !important;
  justify-content: flex-start; text-align: left; border-radius: 2px !important; margin: 0 !important;
}
.mda-row .mda-launch.gpfocus, .mda-row .mda-launch:hover { filter: brightness(1.25); }
.mda-row .mda-launch:disabled { filter: grayscale(0.6) brightness(0.8); }
.mda-text { display: flex; flex-direction: column; line-height: 1.15; }
.mda-title { font-size: 16px; font-weight: 600; }
.mda-detail { font-size: 12px; font-weight: 400; opacity: 0.8; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mda-row .mda-more {
  width: 44px !important; min-width: 44px !important; padding: 0 !important; margin: 0 !important;
  display: flex !important; align-items: center; justify-content: center; font-size: 20px; font-weight: 700; border-radius: 2px !important;
}
.mda-hint { font-size: 13px; opacity: 0.7; max-width: 32vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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

export const MoonlightButton = ({ appid, name, isSteamGame, placement }: Props) => {
  const settings = useSettings();
  const busy = useBusy();
  const [hint, setHint] = useState<string>("");
  const ref = useRef<HTMLDivElement | null>(null);
  const heroVisible = useHeroVisible(ref, placement === "hero");

  const refreshHint = async () => {
    try {
      const r = await resolveApp(appid, name);
      if (!r.ok) return;
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
      canCreate: false,
    });
    if (choice?.kind === "map") {
      await setMapping(appid, choice.name, name);
      refreshHint();
    }
  };

  const label = settings?.ui?.label || "Moonlight";
  const inRow = placement === "play_row";
  const row = (
    <Focusable className={`mda-row ${placement === "below_play" ? "mda-below" : ""}`} flow-children="horizontal">
      <DialogButton
        className="mda-launch"
        disabled={busy}
        onClick={() => launchWithMoonlight({ appid, name, isSteamGame })}
        onSecondaryButton={changeMapping}
        onSecondaryActionDescription="Change Apollo app"
      >
        <MoonIcon />
        {inRow ? (
          <span className="mda-text">
            <span className="mda-title">{busy ? "Starting…" : label}</span>
            <span className="mda-detail">{hint || "Stream from your PC"}</span>
          </span>
        ) : (
          <span>{busy ? "Starting…" : label}</span>
        )}
      </DialogButton>
      <DialogButton className="mda-more" onClick={changeMapping} aria-label="Change Apollo app">
        ⋯
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
