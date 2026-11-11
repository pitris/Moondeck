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

// --- the REAL tree helpers from @decky/ui (pure JS, no Steam needed) ----------
export { createReactTreePatcher } from "../../../node_modules/@decky/ui/dist/utils/react/treepatcher.js";
export { afterPatch } from "../../../node_modules/@decky/ui/dist/utils/patcher.js";
export { findInTree, findInReactTree } from "../../../node_modules/@decky/ui/dist/utils/react/react.js";

/** Class module of Steam's play section (names are hashed in the real client). */
export const playSectionModule = {
  ActionRow: "appdetailsplaysection_ActionRow_3Xk2",
  AppButtons: "appdetailsplaysection_AppButtons_1aB",
  PlaySection: "appdetailsplaysection_PlaySection_9q",
};
export const classModules: Record<string, string>[] = [playSectionModule];
export function findClassModule(filter: (m: any) => boolean) {
  return classModules.find((m) => filter(m));
}
