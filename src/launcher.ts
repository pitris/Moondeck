import { Navigation } from "@decky/ui";
import { toaster } from "@decky/api";
import {
  Failure,
  cancelLaunch,
  createApolloApp,
  createdMessage,
  lastSession,
  log,
  prepareLaunch,
  setMapping,
  wakeHost,
} from "./backend";
import { settingsStore } from "./store";
import { RUNNER_BASE_NAME, ensureRunner, isAnyGameRunning, launchRunner, waitForExit } from "./steam/runner";
import { alertModal, ask, offlineModal, pickApp, showProgress } from "./components/modals";
import { setStreaming } from "./power";
import { ConfirmModal } from "@decky/ui";
import { createElement } from "react";

export const SETTINGS_ROUTE = "/moondeck-apollo";

export interface LaunchTarget {
  appid: number;
  name: string;
  isSteamGame: boolean;
}

interface ReturnState {
  originAppId: number;
  runnerAppId: number;
  since: number;
  // "launch": Steam opened the runner's page right after RunGame -> go back.
  // "exit": the session just ended and Steam shows the runner's page -> go to the game.
  phase: "launch" | "exit";
  handled: boolean;
}

let busy = false;
let returnState: ReturnState | null = null;
const busyListeners = new Set<(b: boolean) => void>();

function setBusy(b: boolean) {
  busy = b;
  busyListeners.forEach((l) => l(b));
}

export function onBusyChange(l: (b: boolean) => void): () => void {
  busyListeners.add(l);
  return () => busyListeners.delete(l);
}

export function isBusy(): boolean {
  return busy;
}

/**
 * Called from the route patch when Steam renders an app page. After RunGame
 * Steam navigates to the launched app's page - for us that is the hidden
 * runner, which the user should never see. Go back to the real game instead.
 */
export function onAppPageRendered(appid: number): void {
  const rs = returnState;
  if (!rs || appid !== rs.runnerAppId || rs.handled) return;
  if (Date.now() - rs.since > 30000) return;
  rs.handled = true;
  setTimeout(() => {
    try {
      if (rs.phase === "launch") {
        Navigation.NavigateBack();
      } else {
        Navigation.Navigate(`/library/app/${rs.originAppId}`);
      }
    } catch (e) {
      log("warning", `navigation after Moonlight session failed: ${String(e)}`);
    }
  }, 0);
}

async function confirmStopRunningGame(): Promise<boolean> {
  return ask<boolean>((done) => createElement(ConfirmModal, {
    strTitle: "A game is already running",
    strDescription: "Steam will close the running game before starting the Moonlight stream. Continue?",
    strOKButtonText: "Continue",
    strCancelButtonText: "Cancel",
    onOK: () => done(true),
    onCancel: () => done(false),
  }), false);
}

/** Resolve all pre-flight problems interactively. Returns the Apollo app name or null if aborted. */
async function prepare(target: LaunchTarget): Promise<string | null> {
  let cancelled = false;
  let closeProgress = showProgress("Moonlight", "Preparing…", () => {
    cancelled = true;
    cancelLaunch();
  });
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      const r = await prepareLaunch(target.appid, target.name);
      if (cancelled) {
        await cancelLaunch();
        return null;
      }
      if (r.ok) return r.app_name;

      closeProgress();
      const f = r as Failure;
      log("info", `prepare_launch: ${f.error} ${f.message}`);
      switch (f.error) {
        case "UNMAPPED":
        case "APP_MISSING": {
          const choice = await pickApp({
            gameName: target.name,
            reason: f.error === "APP_MISSING" ? `The saved app “${f.app_name}” no longer exists on the PC` : f.message,
            candidates: f.candidates ?? [],
            apps: f.apps ?? [],
            canCreate: !!f.can_create && target.isSteamGame,
          });
          if (!choice) return null;
          if (choice.kind === "create") {
            const c = await createApolloApp(target.appid, target.name);
            if (!c.ok) {
              await alertModal("Could not add the game to Apollo", c.message);
              return null;
            }
            toaster.toast({ title: "Moonlight", body: createdMessage(c) });
          } else {
            await setMapping(target.appid, choice.name, target.name);
            settingsStore.load();
          }
          break;
        }
        case "HOST_OFFLINE": {
          const choice = await offlineModal(f.message, !!f.can_wake);
          if (choice === "cancel") return null;
          if (choice === "wake") await wakeHost();
          break;
        }
        case "NO_HOST":
          await alertModal("Moondeck Apollo is not set up", "Enter your PC's address in the plugin settings first.");
          Navigation.Navigate(SETTINGS_ROUTE);
          return null;
        case "BUSY":
          toaster.toast({ title: "Moonlight", body: f.message });
          return null;
        case "CANCELLED":
          return null;
        default:
          await alertModal("Cannot start Moonlight", f.message);
          return null;
      }
      closeProgress = showProgress("Moonlight", "Retrying…", () => {
        cancelled = true;
        cancelLaunch();
      });
    }
    return null;
  } finally {
    closeProgress();
  }
}

export async function launchWithMoonlight(target: LaunchTarget): Promise<void> {
  if (busy) return;
  setBusy(true);
  try {
    if (isAnyGameRunning() && !(await confirmStopRunningGame())) return;

    const appName = await prepare(target);
    if (!appName) return;

    const runnerAppId = await ensureRunner();
    if (!runnerAppId) {
      await cancelLaunch();
      await alertModal("Cannot start Moonlight", "The hidden Moonlight shortcut could not be created in Steam. Restarting Steam usually fixes this.");
      return;
    }
    const rename = settingsStore.current?.ui?.rename_runner_per_launch ?? true;
    const displayName = rename ? `${target.name} (Moonlight)` : RUNNER_BASE_NAME;
    returnState = { originAppId: target.appid, runnerAppId, since: Date.now(), phase: "launch", handled: false };
    const started = await launchRunner(runnerAppId, displayName);
    if (!started) {
      await cancelLaunch();
      await alertModal("Cannot start Moonlight", "Steam did not start the Moonlight runner. Check the plugin log for details.");
      return;
    }
    // The launch itself is done; watch the session in the background.
    setBusy(false);
    watchSession(target, runnerAppId);
  } catch (e) {
    log("error", `launch failed: ${String(e)}`);
    await alertModal("Cannot start Moonlight", String(e));
  } finally {
    setBusy(false);
  }
}

async function watchSession(target: LaunchTarget, runnerAppId: number): Promise<void> {
  setStreaming(true);
  try {
    await waitForExit(runnerAppId);
  } finally {
    setStreaming(false);
  }
  returnState = { originAppId: target.appid, runnerAppId, since: Date.now(), phase: "exit", handled: false };
  const r = await lastSession();
  const s = r.ok ? r.session : null;
  log("info", `session ended: ${JSON.stringify(s && { exit_code: s.exit_code, duration: s.duration, error: s.error })}`);
  if (!s || !s.exit_code) return;
  // Moonlight shows its own error dialog in-stream for most failures; only
  // surface problems for sessions that ended almost immediately.
  if ((s.duration ?? 0) < 20) {
    await alertModal(`Moonlight could not stream ${target.name}`, s.message || "Moonlight exited with an error.");
  }
}
