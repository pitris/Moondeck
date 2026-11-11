import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { backend, calls, routerHook } from "./mocks/decky-api";
import { Navigation, findInReactTree, playSectionModule } from "./mocks/decky-ui";
import { installFakeSteam, FakeSteam } from "./steam-env";

// Interactive dialogs are replaced by programmable answers.
const answers = vi.hoisted(() => ({ pick: null as unknown, offline: "cancel" as string, alerts: [] as string[] }));
vi.mock("../../src/components/modals", () => ({
  ask: async (_b: unknown, cancel: unknown) => cancel,
  alertModal: async (title: string) => { answers.alerts.push(title); },
  offlineModal: async () => answers.offline,
  pickApp: async () => answers.pick,
  showProgress: () => () => {},
}));

import { inject, patchLibraryApp, resetForTests } from "../../src/patches/libraryApp";
import { launchWithMoonlight, onAppPageRendered } from "../../src/launcher";
import { ensureRunner, removeRunner } from "../../src/steam/runner";
import { settingsStore } from "../../src/store";
import { MoonlightButton } from "../../src/components/MoonlightButton";
import { SettingsPage } from "../../src/components/SettingsPage";
import plugin from "../../src/index";

const SETTINGS = {
  version: 1,
  host: { address: "192.168.1.50", moonlight_name: "GAMING-PC", http_port: 47989, mac: "AA:BB:CC:DD:EE:FF", wol_enabled: true, wol_broadcast: "255.255.255.255", wake_timeout: 90 },
  apollo_web: { enabled: false, port: 47990, username: "", password: "", password_set: false, cert_sha256: "", new_app_virtual_display: true },
  moonlight: { flatpak_id: "com.moonlight_stream.Moonlight", custom_path: "", resolution: "", fps: "", bitrate_kbps: "", display_mode: "", video_codec: "", hdr: "", performance_overlay: "", quit_app_after: false, extra_args: "" },
  ui: { placement: "below_play", label: "Moonlight", rename_runner_per_launch: true, show_on_non_steam: true },
  runner: { shortcut_appid: 0 },
  mappings: { "1091500": { app_name: "Cyberpunk 2077", source: "manual", steam_name: "Cyberpunk 2077" } },
  apps_cache: { fetched_at: 0, source: "moonlight", apps: [{ name: "Cyberpunk 2077" }] },
} as any;

/** A game page tree shaped like Steam's: header, play section, then content. */
function gamePage(overview: object): { ret: ReactElement; container: any } {
  const header = createElement("div", { key: "h", className: "appdetails_Header_abc" });
  const play = createElement("div", { key: "p", overview, onShowLaunchingDetails: () => {} });
  const content = createElement("div", { key: "c", className: "content" });
  const container = createElement("div", { className: "appdetails_InnerContainer_abc x" }, [header, play, content]);
  const holder = createElement("section", { overview }, container);
  return { ret: createElement("div", null, holder), container };
}

let steam: FakeSteam;
beforeEach(() => {
  resetForTests();
  for (const p of routerHook.patchesFor("/library/app/:appid")) routerHook.removePatch("/library/app/:appid", p);
  steam = installFakeSteam();
  calls.length = 0;
  answers.alerts.length = 0;
  Navigation.calls.length = 0;
  for (const k of Object.keys(backend)) delete backend[k];
  backend.get_runner_info = () => ({ ok: true, path: "/home/deck/homebrew/data/moondeck-apollo/moonlight-runner.sh", start_dir: "/home/deck/homebrew/data/moondeck-apollo", appid: 0 });
  backend.set_runner_appid = (id: number) => { backend.get_runner_info = () => ({ ok: true, path: "/r.sh", start_dir: "/", appid: id }); return { ok: true }; };
  backend.get_settings = () => structuredClone(SETTINGS);
  settingsStore.set(structuredClone(SETTINGS));
});

describe("game page injection", () => {
  const cp = { appid: 1091500, display_name: "Cyberpunk 2077", app_type: 1 };

  it("puts the Moonlight option directly after the play section", () => {
    const { ret, container } = gamePage(cp);
    inject(ret, cp);
    const kids = container.props.children;
    expect(kids.map((k: any) => k.key)).toEqual(["h", "p", "moondeck-apollo", "c"]);
    expect(kids[2].props).toMatchObject({ appid: 1091500, name: "Cyberpunk 2077", isSteamGame: true, placement: "below_play" });
  });

  it("hero placement goes before the play section, and re-renders do not duplicate", () => {
    settingsStore.current!.ui.placement = "hero";
    const { ret, container } = gamePage(cp);
    inject(ret, cp);
    inject(ret, cp);
    expect(container.props.children.map((k: any) => k.key)).toEqual(["h", "moondeck-apollo", "p", "c"]);
  });

  it("skips tools/DLC and optionally non-Steam shortcuts", () => {
    const tool = { appid: 1493710, display_name: "Proton Experimental", app_type: 4 };
    let page = gamePage(tool);
    inject(page.ret, tool);
    expect(page.container.props.children).toHaveLength(3);
    const sc = { appid: 3100000000, display_name: "Some Epic Game", app_type: 1073741824 };
    page = gamePage(sc);
    inject(page.ret, sc);
    expect(page.container.props.children[2].props.isSteamGame).toBe(false);
    settingsStore.current!.ui.show_on_non_steam = false;
    page = gamePage(sc);
    inject(page.ret, sc);
    expect(page.container.props.children).toHaveLength(3);
  });

  it("does nothing (and does not throw) on an unknown page layout", () => {
    const ret = createElement("div", null, createElement("span"));
    expect(() => inject(ret, cp)).not.toThrow();
  });

  it("older Steam layout: route patch + real tree patcher add the button, unpatch cleanly", () => {
    settingsStore.current!.ui.placement = "play_row"; // falls back automatically on the old layout
    const unpatch = patchLibraryApp();
    const [patch] = routerHook.patchesFor("/library/app/:appid");
    const header = createElement("div", { key: "h", className: "appdetails_Header_abc" });
    const play = createElement("div", { key: "p", overview: cp, onShowLaunchingDetails: () => {} });
    const container = createElement("div", { className: "appdetails_InnerContainer_abc x" }, [header, play]);
    const PageBody = (_props: object) => container;
    const routeProps: any = { renderFunc: () => createElement("div", null, createElement("section", null, createElement(PageBody, { overview: cp }))) };
    patch({ children: { props: routeProps } });
    const out = routeProps.renderFunc();
    const body = findInReactTree(out, (n: any) => n?.props?.overview && typeof n.type === "function");
    body.type(body.props); // React renders the (now patched) page body
    expect(container.props.children.map((k: any) => k.key)).toEqual(["h", "p", "moondeck-apollo"]);
    expect(container.props.children[2].props.placement).toBe("below_play");
    unpatch();
    expect(routerHook.patchesFor("/library/app/:appid")).toHaveLength(0);
  });

  it("the injected button renders", () => {
    const html = renderToString(createElement(MoonlightButton, { appid: 1091500, name: "Cyberpunk 2077", isSteamGame: true, placement: "below_play" }));
    expect(html).toContain("Moonlight");
    expect(html).toContain("mda-launch");
  });
});

describe("current Steam layout: button next to Play", () => {
  const cp = { appid: 1091500, display_name: "Cyberpunk 2077", app_type: 1 };
  const c = playSectionModule;
  const fwd = (render: (p: any, r: any) => any) => ({ $$typeof: Symbol.for("react.forward_ref"), render });
  // Minified-style render functions: their source mentions `<classes>.ActionRow,` / `.PlaySection,`.
  const ActionRow = fwd(function (p: any) {
    const cls = [c.ActionRow, "Panel"].join(" ");
    return createElement("div", { className: cls }, [
      createElement("button", { key: "play" }, p.overview.display_name ? "Play" : "?"),
      createElement("div", { key: "stats" }),
      createElement("div", { key: "icons" }),
    ]);
  });
  const PlaySection = fwd(function (p: any) {
    const k = [c.PlaySection, 1];
    return createElement("div", { className: "ps", "data-k": k[1] }, createElement(ActionRow, { overview: p.overview }));
  });
  const sections = (p: any) => createElement("div", { className: "sections" }, [
    createElement("div", { key: "header" }),
    createElement(PlaySection, { key: "play", overview: p.overview }),
    createElement("div", { key: "about" }),
  ]);

  /** Render the route the way React would: renderFunc -> sections(value) -> PlaySection -> ActionRow. */
  function renderPage(routeProps: any, overview: object): any {
    const out = routeProps.renderFunc();
    const holder = findInReactTree(out, (n: any) => typeof n?.props?.value === "function");
    const secTree = holder.props.value({ overview });
    const ps = findInReactTree(secTree, (n: any) => n?.key === "play");
    const psTree = ps.type.render(ps.props, null);
    const ar = findInReactTree(psTree, (n: any) => n?.type?.render);
    return ar.type.render(ar.props, null);
  }

  function setup(overview: object) {
    const unpatch = patchLibraryApp();
    const [patch] = routerHook.patchesFor("/library/app/:appid");
    const routeProps: any = {
      renderFunc: () => createElement("div", null,
        createElement("x-sections", { value: sections }, createElement("div", { overview }))),
    };
    patch({ children: { props: routeProps } });
    return { routeProps, unpatch };
  }

  it("inserts the Moonlight button right after Steam's Play button", () => {
    settingsStore.current!.ui.placement = "play_row";
    const { routeProps, unpatch } = setup(cp);
    const row = renderPage(routeProps, cp);
    expect(row.props.children.map((k: any) => k.key)).toEqual(["play", "moondeck-apollo", "stats", "icons"]);
    expect(row.props.children[1].props).toMatchObject({ appid: 1091500, name: "Cyberpunk 2077", isSteamGame: true, placement: "play_row" });
    // re-render: still exactly one button
    const again = renderPage(routeProps, cp);
    expect(again.props.children.filter((k: any) => k.key === "moondeck-apollo")).toHaveLength(1);
    unpatch();
  });

  it("does not add the button for tools, and leaves the page alone in other placements", () => {
    const tool = { appid: 1493710, display_name: "Proton", app_type: 4 };
    settingsStore.current!.ui.placement = "play_row";
    let { routeProps, unpatch } = setup(tool);
    expect(renderPage(routeProps, tool).props.children).toHaveLength(3);
    unpatch();
    settingsStore.current!.ui.placement = "hero";
    ({ routeProps, unpatch } = setup(cp));
    expect(renderPage(routeProps, cp).props.children).toHaveLength(3);
    unpatch();
  });

  it("the in-row button renders with a two-line label", () => {
    const html = renderToString(createElement(MoonlightButton, { appid: 1091500, name: "Cyberpunk 2077", isSteamGame: true, placement: "play_row" }));
    expect(html).toContain("mda-inrow");
    expect(html).toContain("Stream from your PC");
  });
});

describe("runner shortcut", () => {
  it("creates a hidden shortcut once and reuses it", async () => {
    const id = await ensureRunner();
    expect(id).toBe(3000000001);
    expect(steam.hidden.has(id!)).toBe(true);
    expect(steam.log[0]).toContain("AddShortcut Moonlight (Apollo) /home/deck/homebrew/data/moondeck-apollo/moonlight-runner.sh");
    expect(calls.find((c) => c.route === "set_runner_appid")?.args).toEqual([id]);
    const again = await ensureRunner();
    expect(again).toBe(id);
    expect(steam.log.filter((l) => l.startsWith("AddShortcut"))).toHaveLength(1);
    expect(await removeRunner()).toBe(true);
    expect(steam.overviews.has(id!)).toBe(false);
  });
});

describe("launch flow", () => {
  const target = { appid: 1145350, name: "Hades II", isSteamGame: true };

  it("asks for an Apollo app once, then launches the runner and returns to the game page", async () => {
    let prepared = 0;
    backend.prepare_launch = () => (++prepared === 1
      ? { ok: false, error: "UNMAPPED", message: "No match", candidates: ["Hades II (Apollo)"], apps: ["Desktop", "Hades II (Apollo)"], can_create: false }
      : { ok: true, app_name: "Hades II (Apollo)", resolution: "manual" });
    backend.last_session = () => ({ ok: true, session: { exit_code: 0, duration: 1200 } });
    answers.pick = { kind: "map", name: "Hades II (Apollo)" };
    steam.onRunGame = (gid) => {
      const id = [...steam.overviews.values()].find((o) => o.gameid === gid)!.appid;
      steam.running.add(id);
      // Steam navigates to the launched app's page; the plugin should go back.
      onAppPageRendered(id);
      setTimeout(() => steam.running.delete(id), 600); // stream ends
    };

    await launchWithMoonlight(target);

    expect(calls.find((c) => c.route === "set_mapping")?.args).toEqual([1145350, "Hades II (Apollo)", "Hades II"]);
    expect(prepared).toBe(2);
    const run = steam.log.find((l) => l.startsWith("RunGame"));
    expect(run).toBe('RunGame gid-3000000001 "" -1 100');
    expect(steam.log).toContain("SetShortcutName 3000000001 Hades II (Moonlight)");
    await new Promise((r) => setTimeout(r, 50));
    expect(Navigation.calls).toContain("back");
    expect(answers.alerts).toEqual([]);
    // wait for the background session watcher to see the exit
    await new Promise((r) => setTimeout(r, 2500));
    expect(calls.some((c) => c.route === "last_session")).toBe(true);
  }, 10000);

  it("offline PC: user cancels -> nothing is launched", async () => {
    backend.prepare_launch = () => ({ ok: false, error: "HOST_OFFLINE", message: "PC not responding", can_wake: true });
    answers.offline = "cancel";
    await launchWithMoonlight(target);
    expect(steam.log.some((l) => l.startsWith("RunGame"))).toBe(false);
  });

  it("offline PC: wake and retry", async () => {
    let n = 0;
    backend.prepare_launch = () => (++n === 1 ? { ok: false, error: "HOST_OFFLINE", message: "x", can_wake: true } : { ok: true, app_name: "Hades II" });
    answers.offline = "wake";
    steam.onRunGame = (gid) => {
      const id = [...steam.overviews.values()].find((o) => o.gameid === gid)!.appid;
      steam.running.add(id);
      setTimeout(() => steam.running.delete(id), 100);
    };
    await launchWithMoonlight(target);
    expect(calls.some((c) => c.route === "wake_host")).toBe(true);
    expect(steam.log.some((l) => l.startsWith("RunGame"))).toBe(true);
  });

  it("Steam never starts the runner -> request cancelled and error shown", async () => {
    backend.prepare_launch = () => ({ ok: true, app_name: "Hades II" });
    steam.onRunGame = () => {};
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 200 });
    try {
      const p = launchWithMoonlight(target);
      await vi.advanceTimersByTimeAsync(25000);
      await p;
    } finally {
      vi.useRealTimers();
    }
    expect(calls.some((c) => c.route === "cancel_launch")).toBe(true);
    expect(answers.alerts).toEqual(["Cannot start Moonlight"]);
  });

  it("missing host opens the settings page", async () => {
    backend.prepare_launch = () => ({ ok: false, error: "NO_HOST", message: "x" });
    await launchWithMoonlight(target);
    expect(Navigation.calls).toContain("navigate:/moondeck-apollo");
  });
});

describe("plugin UI renders", () => {
  it("settings page and quick access panel render without errors", () => {
    const html = renderToString(createElement(SettingsPage));
    for (const text of ["PC address", "Wake-on-LAN", "Game mappings (1)", "Cyberpunk 2077", "Resolution", "Position", "Back up settings"]) {
      expect(html).toContain(text);
    }
    const p = (plugin as unknown as () => any)();
    expect(p.name).toBe("Moondeck Apollo");
    expect(renderToString(p.content)).toContain("GAMING-PC");
    expect(routerHook.routes["/moondeck-apollo"]).toBeDefined();
    p.onDismount();
    expect(routerHook.routes["/moondeck-apollo"]).toBeUndefined();
  });
});
