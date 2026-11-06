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

let warned = false;
function warnOnce(msg: string) {
  if (!warned) {
    warned = true;
    log("warning", msg);
  }
}

function supported(o: Overview): boolean {
  if (o.appid === getRunnerAppId()) return false;
  if (o.app_type === APP_TYPE_SHORTCUT) return settingsStore.current?.ui.show_on_non_steam ?? true;
  return o.app_type === APP_TYPE_GAME || o.app_type === APP_TYPE_DEMO;
}

export function inject(ret: ReactElement | undefined, overview: Overview | null): void {
  if (!ret || !overview) return;
  onAppPageRendered(overview.appid);
  if (!supported(overview)) return;

  const container = findInReactTree(ret, (x: Container) =>
    Array.isArray(x?.props?.children) && typeof x?.props?.className === "string" &&
    x.props.className.includes(appDetailsClasses.InnerContainer)) as Container | undefined;
  if (!container) {
    warnOnce("game page layout not recognised (InnerContainer missing) - Moonlight button not shown");
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
  const patch = routerHook.addPatch(ROUTE, (tree: any) => {
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
