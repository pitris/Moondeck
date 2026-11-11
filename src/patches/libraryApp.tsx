/**
 * Injects the Moonlight launch option into Steam's game details page.
 *
 * Steam exposes no extension point for launch options: the Play/Stream button
 * is driven by the native client's list of Remote Play machines
 * (overview.per_client_data / selected_clientid). Decky's router hook lets us
 * post-process the React tree of the `/library/app/:appid` route.
 *
 * Two strategies, because Steam's page structure changed over time:
 *
 *  A. "play row" (current clients, verified against the late-2026 structure
 *     used by actively maintained plugins such as OpenNOW): the route renders
 *     a node whose `value` prop is the function that renders the page
 *     sections and whose child carries the app `overview`. We wrap that
 *     function, follow it down to the PlaySection and its ActionRow component
 *     and insert our button into the ActionRow right after Steam's Play
 *     button.
 *  B. "inner container" (older clients): the overview holder's child renders
 *     the page's InnerContainer and we add a row/overlay next to the play
 *     section. Used for the other placements, and as a fallback when A cannot
 *     find its anchor points.
 *
 * Nothing is written to disk; everything disappears when the plugin unloads.
 */
import { afterPatch, appDetailsClasses, createReactTreePatcher, findClassModule, findInReactTree } from "@decky/ui";
import { routerHook } from "@decky/api";
import { ReactElement } from "react";
import { Placement, log } from "../backend";
import { MoonlightButton } from "../components/MoonlightButton";
import { onAppPageRendered } from "../launcher";
import { settingsStore } from "../store";
import { APP_TYPE_SHORTCUT, getRunnerAppId } from "../steam/runner";

const ROUTE = "/library/app/:appid";
export const KEY = "moondeck-apollo";
// EAppType values we offer streaming for: Game, Demo (+ Shortcut when enabled).
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

function asOverview(o: any): Overview | null {
  return o && typeof o.appid === "number" && typeof o.display_name === "string" ? (o as Overview) : null;
}

function supported(o: Overview): boolean {
  if (o.appid === getRunnerAppId()) return false;
  if (o.app_type === APP_TYPE_SHORTCUT) return settingsStore.current?.ui?.show_on_non_steam ?? true;
  return o.app_type === APP_TYPE_GAME || o.app_type === APP_TYPE_DEMO;
}

function placement(): Placement {
  return settingsStore.current?.ui?.placement ?? "play_row";
}

function button(o: Overview, where: Placement) {
  return (
    <MoonlightButton
      key={KEY}
      appid={o.appid}
      name={o.display_name}
      isSteamGame={o.app_type !== APP_TYPE_SHORTCUT}
      placement={where}
    />
  );
}

// Strategy A failed to find its anchors on this client -> let B take over.
let playRowFailed = false;

export function resetForTests(): void {
  playRowFailed = false;
  logged.clear();
}

// ---------------------------------------------------------------- strategy A
function hasClass(node: any, className: string): boolean {
  return typeof node?.props?.className === "string" && node.props.className.split(" ").includes(className);
}

/** True for a forwardRef component whose (minified) render function uses `classes.<key>`. */
function rendersClass(node: any, key: string): boolean {
  const render = node?.type?.render;
  return typeof render === "function" && render.toString().includes(`.${key},`);
}

function actionRowClass(): string | undefined {
  try {
    const m = findClassModule((mod: any) => mod.ActionRow && mod.AppButtons && mod.PlaySection) as Record<string, string> | void;
    return m ? m.ActionRow : undefined;
  } catch {
    return undefined;
  }
}

/** Insert the button into the ActionRow tree right after Steam's Play button. */
export function injectPlayRow(rendered: any, overview: Overview | null, rowClass: string | undefined): void {
  if (!rendered || !overview) return;
  onAppPageRendered(overview.appid);
  if (!supported(overview)) {
    logOnce(`type-${overview.app_type}`, `no button for app type ${overview.app_type} (${overview.display_name})`, "info");
    return;
  }
  const row = rowClass
    ? findInReactTree(rendered, (n: any) => Array.isArray(n?.props?.children) && hasClass(n, rowClass))
    : null;
  if (!row) {
    playRowFailed = true;
    warnOnce(`play row not found (ActionRow class ${rowClass ?? "unknown"}); tree: ${describe(rendered)} - using fallback placement`);
    return;
  }
  const children: any[] = row.props.children;
  if (children.some((c) => c?.key === KEY)) return;
  logOnce("injected-row", `Moonlight button added next to Play for ${overview.display_name} (${overview.appid}); row: ` +
    children.map((c, i) => `[${i}] ${describe(c)}`).join(" "), "info");
  children.splice(Math.min(1, children.length), 0, button(overview, "play_row"));
}

function playRowPatcher(rowClass: string | undefined, fallbackOverview: () => Overview | null) {
  return createReactTreePatcher([
    (section: any) => section,
    (rendered: any) => {
      const n = findInReactTree(rendered, (x: any) => rendersClass(x, "PlaySection"));
      if (!n) { playRowFailed = true; warnOnce(`PlaySection component not found; tree: ${describe(rendered)} - using fallback placement`); }
      return n;
    },
    (rendered: any) => {
      const n = findInReactTree(rendered, (x: any) => rendersClass(x, "ActionRow"));
      if (!n) { playRowFailed = true; warnOnce(`ActionRow component not found; tree: ${describe(rendered)} - using fallback placement`); }
      return n;
    },
  ], (args: any[], rendered?: ReactElement) => {
    try {
      if (placement() === "play_row") {
        injectPlayRow(rendered, asOverview(args?.[0]?.overview) ?? fallbackOverview(), rowClass);
      }
    } catch (e) {
      playRowFailed = true;
      warnOnce(`could not add Moonlight button to the play row: ${String(e)}`);
    }
    return rendered;
  }, "MoondeckApollo play row");
}

// ---------------------------------------------------------------- strategy B
/** Insert into the page's InnerContainer (older clients, or the other placements). */
export function inject(ret: ReactElement | undefined, overview: Overview | null): void {
  if (!ret) return;
  const where = placement();
  if (where === "play_row" && !playRowFailed) return;
  if (!overview) {
    logOnce("no-overview", `game page rendered but app overview not found; tree: ${describe(ret)}`);
    return;
  }
  onAppPageRendered(overview.appid);
  if (!supported(overview)) return;

  const container = findInReactTree(ret, (x: Container) =>
    Array.isArray(x?.props?.children) && typeof x?.props?.className === "string" &&
    x.props.className.includes(appDetailsClasses.InnerContainer)) as Container | undefined;
  if (!container) {
    warnOnce(`game page layout not recognised (InnerContainer "${appDetailsClasses.InnerContainer}" missing); ` +
      `tree: ${describe(ret)} > ${describe((ret as any)?.props?.children)}`);
    return;
  }
  const children = container.props.children;
  if (children.some((c) => c?.key === KEY)) return;

  // The play section is the child that receives the app overview and the
  // "show launching details" callback.
  const playIdx = children.findIndex((c) => c?.props?.overview && "onShowLaunchingDetails" in (c.props ?? {}));
  const effective: Placement = where === "hero" ? "hero" : "below_play";
  let at: number;
  if (playIdx < 0) {
    warnOnce("play section not found - placing Moonlight button after the header");
    at = Math.min(1, children.length);
  } else {
    at = effective === "hero" ? playIdx : playIdx + 1;
  }
  logOnce("injected", `Moonlight button added (${effective}) for ${overview.display_name} (${overview.appid}) at ` +
    `${at}/${children.length}; children: ` + children.map((c, i) => `[${i}] ${describe(c)}`).join(" "), "info");
  children.splice(at, 0, button(overview, effective));
}

// ---------------------------------------------------------------- route patch
export function patchLibraryApp(): () => void {
  const rowClass = actionRowClass();
  log("info", `registering route patch for ${ROUTE} (ActionRow class: ${rowClass ?? "not found"})`);
  if (!rowClass) playRowFailed = true;

  const patch = routerHook.addPatch(ROUTE, (tree: any) => {
    logOnce("route", "game page route patch called", "info");
    const routeProps = findInReactTree(tree, (x: any) => x?.renderFunc);
    if (!routeProps) {
      warnOnce("library app route has no renderFunc - Steam UI changed?");
      return tree;
    }
    let overview: Overview | null = null;

    // Strategy B handler (older layout / other placements).
    const innerHandler = createReactTreePatcher([
      (node: any) => {
        const holder = findInReactTree(node, (x: any) => x?.props?.children?.props?.overview)?.props?.children;
        overview = asOverview(holder?.props?.overview);
        return holder;
      },
    ], (_: unknown[], ret?: ReactElement) => {
      try {
        inject(ret, overview);
      } catch (e) {
        warnOnce(`could not inject Moonlight button: ${String(e)}`);
      }
      return ret;
    }, "MoondeckApollo inner container");

    const rowPatcher = playRowPatcher(rowClass, () => overview);

    afterPatch(routeProps, "renderFunc", (args: unknown[], rendered: any) => {
      // Strategy A: wrap the sections render function (current clients).
      const sections = findInReactTree(rendered, (n: any) =>
        typeof n?.props?.value === "function" && n?.props?.children?.props?.overview);
      if (sections) {
        overview = asOverview(sections.props.children.props.overview);
        if (!sections.props.value.__moondeckApollo) {
          const holder = { type: sections.props.value };
          rowPatcher([], holder);
          holder.type.__moondeckApollo = true;
          sections.props.value = holder.type;
        }
      } else {
        if (!playRowFailed) logOnce("no-sections", `sections renderer not found (older Steam layout?); tree: ${describe(rendered)}`, "info");
        playRowFailed = true;
      }
      return innerHandler(args, rendered);
    });
    return tree;
  });
  return () => routerHook.removePatch(ROUTE, patch);
}
