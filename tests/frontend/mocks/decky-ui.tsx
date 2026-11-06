/* Minimal stand-ins for @decky/ui so plugin logic can run under Node. */
import { ReactNode, createElement } from "react";

type AnyProps = { children?: ReactNode; [k: string]: unknown };
const el = (tag: string) => (props: AnyProps) => createElement("div", { "data-mock": tag }, props.children as ReactNode);

export const DialogButton = (p: AnyProps) => createElement("button", { "data-mock": "DialogButton", className: p.className as string }, p.children as ReactNode);
export const Focusable = el("Focusable");
export const ModalRoot = el("ModalRoot");
export const ConfirmModal = (p: AnyProps) => createElement("div", { "data-mock": "ConfirmModal" }, String(p.strTitle ?? ""));
export const DropdownItem = (p: AnyProps) => createElement("select", { "data-mock": "DropdownItem" }, String(p.label ?? ""));
export const TextField = (p: AnyProps) => createElement("input", { "data-mock": "TextField", "aria-label": String(p.label ?? ""), value: String(p.value ?? ""), readOnly: true });
export const ToggleField = (p: AnyProps) => createElement("input", { type: "checkbox", "aria-label": String(p.label ?? ""), checked: !!p.checked, readOnly: true });
export const ButtonItem = el("ButtonItem");
export const Field = (p: AnyProps) => createElement("div", { "data-mock": "Field" }, String(p.label ?? ""), p.description as ReactNode, p.children as ReactNode);
export const PanelSection = el("PanelSection");
export const PanelSectionRow = el("PanelSectionRow");
export const DialogBody = el("DialogBody");
export const DialogControlsSection = el("DialogControlsSection");
export const DialogControlsSectionHeader = el("DialogControlsSectionHeader");
export const SteamSpinner = el("SteamSpinner");
export const SidebarNavigation = (p: { pages: { title: string; content: ReactNode }[] }) =>
  createElement("div", { "data-mock": "SidebarNavigation" }, ...p.pages.map((pg) => createElement("section", { key: pg.title }, pg.content)));

export const staticClasses = { Title: "Title" };
export const appDetailsClasses = { InnerContainer: "appdetails_InnerContainer_abc", Header: "appdetails_Header_abc" };
export const appDetailsHeaderClasses = { TopCapsule: "TopCapsule", FullscreenEnterStart: "FES", FullscreenEnterActive: "FEA", FullscreenEnterDone: "FED", FullscreenExitStart: "FXS", FullscreenExitActive: "FXA" };

export const Navigation = {
  calls: [] as string[],
  Navigate(path: string) { this.calls.push(`navigate:${path}`); },
  NavigateBack() { this.calls.push("back"); },
  CloseSideMenus() { this.calls.push("close"); },
};

export const modalLog: unknown[] = [];
export const showModal = (modal: unknown) => {
  modalLog.push(modal);
  return { Close() {}, ClosedPromise: Promise.resolve(), Update() {} };
};

// --- tree helpers: same semantics as the real ones ---------------------------
export function findInTree(node: any, filter: (x: any) => boolean, opts: { walkable?: string[] } = {}, seen = new Set()): any {
  if (!node || typeof node !== "object" || seen.has(node)) return null;
  seen.add(node);
  if (filter(node)) return node;
  const keys = opts.walkable ?? Object.keys(node);
  for (const k of keys) {
    const v = node[k];
    if (Array.isArray(v)) {
      for (const c of v) {
        const r = findInTree(c, filter, opts, seen);
        if (r) return r;
      }
    } else if (v && typeof v === "object") {
      const r = findInTree(v, filter, opts, seen);
      if (r) return r;
    }
  }
  return null;
}
export const findInReactTree = (node: any, filter: (x: any) => boolean) =>
  findInTree(node, filter, { walkable: ["props", "children", "child", "sibling"] });

export function afterPatch(obj: any, name: string, handler: (args: unknown[], ret: unknown) => unknown) {
  const orig = obj[name];
  obj[name] = function (...args: unknown[]) {
    return handler(args, orig.apply(this, args));
  };
  return { unpatch() { obj[name] = orig; } };
}

/** Simplified: run each step on the returned tree, then the handler on the final one. */
export function createReactTreePatcher(steps: ((n: any) => any)[], handler: (args: unknown[], ret: any) => any) {
  return (args: unknown[], ret: any) => {
    for (const step of steps) step(ret);
    return handler(args, ret);
  };
}
