/**
 * Injects the Moonlight launch option into Steam's game details page.
 *
 * Steam exposes no extension point for launch options: the Play/Stream button
 * is driven by the native client's list of Remote Play machines
 * (overview.per_client_data / selected_clientid). Decky's router hook lets us
 * post-process the React tree of the `/library/app/:appid` route, so we add
 * our own element to the page's inner container, next to the play section.
 * This is the same, long-standing technique used by other Decky plugins that
 * decorate the game page. It changes nothing on disk and disappears when the
 * plugin is unloaded.
 */
import { afterPatch, appDetailsClasses, createReactTreePatcher, findInReactTree } from "@decky/ui";
import { routerHook } from "@decky/api";
import { ReactElement } from "react";
import { log } from "../backend";
import { MoonlightButton } from "../components/MoonlightButton";
import { onAppPageRendered } from "../launcher";
import { settingsStore } from "../store";
import { APP_TYPE_SHORTCUT, getRunnerAppId } from "../steam/runner";

const ROUTE = "/library/app/:appid";
const KEY = "moondeck-apollo";
// EAppType bits we offer streaming for: Game, Demo (+ Shortcut when enabled).
const APP_TYPE_GAME = 1;
const APP_TYPE_DEMO = 8;

interface Overview {
  appid: number;
  display_name: string;
  app_type: number;
}

type Container = ReactElement<{ children: ReactElement<Record<string, unknown>>[]; className?: string }>;

// Each distinct diagnostic is logged once per session (to the plugin log via
// the backend), so a broken injection can be diagnosed from the device log.
const logged = new Set<string>();
function logOnce(key: string, msg: string, level: "info" | "warning" = "warning") {
  if (logged.has(key)) return;
  logged.add(key);
  log(level, msg);
}
const warnOnce = (msg: string) => logOnce(msg, msg);

/** Short description of a React element for diagnostics. */
function describe(el: any): string {
  if (el === null || el === undefined || typeof el !== "object") return String(el);
  const t = el.type;
  const name = typeof t === "string" ? t : t?.displayName || t?.name || (t?.$$typeof ? String(t.$$typeof.toString()) : typeof t);
  const cls = typeof el.props?.className === "string" ? `.${el.props.className.split(" ")[0]}` : "";
  const keys = Object.keys(el.props ?? {}).filter((k) => k !== "children").slice(0, 8).join(",");
  return `${name}${el.key ? `#${el.key}` : ""}${cls}{${keys}}`;
}

function supported(o: Overview): boolean {
  if (o.appid === getRunnerAppId()) return false;
  if (o.app_type === APP_TYPE_SHORTCUT) return settingsStore.current?.ui.show_on_non_steam ?? true;
  return o.app_type === APP_TYPE_GAME || o.app_type === APP_TYPE_DEMO;
}

export function inject(ret: ReactElement | undefined, overview: Overview | null): void {
  if (!ret) return;
  if (!overview) {
    logOnce("no-overview", `game page rendered but app overview not found; tree: ${describe(ret)}`);
    return;
  }
  onAppPageRendered(overview.appid);
  if (!supported(overview)) {
    logOnce(`type-${overview.app_type}`, `no button for app type ${overview.app_type} (${overview.display_name})`, "info");
    return;
  }

  const container = findInReactTree(ret, (x: Container) =>
    Array.isArray(x?.props?.children) && typeof x?.props?.className === "string" &&
    x.props.className.includes(appDetailsClasses.InnerContainer)) as Container | undefined;
  if (!container) {
    warnOnce(`game page layout not recognised (InnerContainer "${appDetailsClasses.InnerContainer}" missing) - ` +
      `Moonlight button not shown; tree: ${describe(ret)} > ${describe((ret as any)?.props?.children)}`);
    return;
  }
  const children = container.props.children;
  if (children.some((c) => c?.key === KEY)) return;

  // The play section is the child that receives the app overview and the
  // "show launching details" callback.
  const playIdx = children.findIndex((c) => c?.props?.overview && "onShowLaunchingDetails" in (c.props ?? {}));
  const placement = settingsStore.current?.ui.placement ?? "below_play";
  let at: number;
  if (playIdx < 0) {
    warnOnce("play section not found - placing Moonlight button after the header");
    at = Math.min(1, children.length);
  } else {
    at = placement === "hero" ? playIdx : playIdx + 1;
  }
  logOnce("injected", `injected Moonlight button for ${overview.display_name} (${overview.appid}, type ` +
    `${overview.app_type}) at ${at}/${children.length}, placement ${placement}; children: ` +
    children.map((c, i) => `[${i}] ${describe(c)}`).join(" "), "info");
  children.splice(at, 0, (
    <MoonlightButton
      key={KEY}
      appid={overview.appid}
      name={overview.display_name}
      isSteamGame={overview.app_type !== APP_TYPE_SHORTCUT}
      placement={placement}
    />
  ));
}

export function patchLibraryApp(): () => void {
  log("info", `registering route patch for ${ROUTE}`);
  const patch = routerHook.addPatch(ROUTE, (tree: any) => {
    logOnce("route", "game page route patch called", "info");
    const routeProps = findInReactTree(tree, (x: any) => x?.renderFunc);
    if (!routeProps) {
      warnOnce("library app route has no renderFunc - Steam UI changed?");
      return tree;
    }
    let overview: Overview | null = null;
    const handler = createReactTreePatcher([
      (node: any) => {
        const holder = findInReactTree(node, (x: any) => x?.props?.children?.props?.overview)?.props?.children;
        const o = holder?.props?.overview;
        overview = o && typeof o.appid === "number" && typeof o.display_name === "string" ? (o as Overview) : null;
        if (!holder) logOnce("no-holder", `overview holder not found in game page; tree: ${describe(node)}`);
        return holder;
      },
    ], (_: unknown[], ret?: ReactElement) => {
      try {
        inject(ret, overview);
      } catch (e) {
        warnOnce(`could not inject Moonlight button: ${String(e)}`);
      }
      return ret;
    }, "MoondeckApollo");
    afterPatch(routeProps, "renderFunc", handler);
    return tree;
  });
  return () => routerHook.removePatch(ROUTE, patch);
}
