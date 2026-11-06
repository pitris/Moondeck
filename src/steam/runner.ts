/**
 * The hidden "runner" shortcut.
 *
 * Steam only applies Steam Input and gamescope window focus to processes it
 * launched itself. So instead of starting Moonlight from the plugin backend we
 * keep one non-Steam shortcut (hidden from the library) whose executable is
 * moonlight-runner.sh, and ask Steam to launch it. The backend has already
 * written the exact Moonlight command line for the runner to execute.
 */
import { getRunnerInfo, log, setRunnerAppId } from "../backend";

export const RUNNER_BASE_NAME = "Moonlight (Apollo)";

// EAppType.Shortcut
export const APP_TYPE_SHORTCUT = 1073741824;

interface OverviewLike {
  appid: number;
  display_name: string;
  gameid?: string;
  app_type?: number;
}

function getOverview(appid: number): OverviewLike | null {
  try {
    return (appStore.GetAppOverviewByAppID(appid) as unknown as OverviewLike) ?? null;
  } catch {
    return null;
  }
}

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs: number, stepMs = 200): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = fn();
      if (v) return v;
    } catch {
      /* keep polling */
    }
    if (Date.now() >= end) return null;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Steam game id of a non-Steam shortcut: (appid << 32) | 0x02000000. */
function shortcutGameId(appid: number): string {
  return ((BigInt(appid >>> 0) << 32n) | 0x02000000n).toString();
}

let runnerAppId = 0;

export function getRunnerAppId(): number {
  return runnerAppId;
}

function hide(appid: number): void {
  try {
    if (!collectionStore.BIsHidden(appid)) {
      collectionStore.SetAppsAsHidden([appid], true);
    }
  } catch (e) {
    log("warning", `could not hide runner shortcut: ${String(e)}`);
  }
}

/** Find or create the hidden runner shortcut. Returns its appid or null. */
export async function ensureRunner(): Promise<number | null> {
  const info = await getRunnerInfo();
  if (!info.ok) {
    log("error", `runner info unavailable: ${info.message}`);
    return null;
  }
  let appid = info.appid;
  const existing = appid ? getOverview(appid) : null;
  if (existing && existing.app_type === APP_TYPE_SHORTCUT) {
    try {
      // Keep the target in sync in case the plugin was reinstalled elsewhere.
      SteamClient.Apps.SetShortcutExe(appid, info.path);
      SteamClient.Apps.SetShortcutStartDir(appid, info.start_dir);
    } catch (e) {
      log("warning", `could not update runner shortcut: ${String(e)}`);
    }
  } else {
    log("info", `creating runner shortcut -> ${info.path}`);
    try {
      appid = await SteamClient.Apps.AddShortcut(RUNNER_BASE_NAME, info.path, info.start_dir, "");
    } catch (e) {
      log("error", `AddShortcut failed: ${String(e)}`);
      return null;
    }
    if (typeof appid !== "number" || !(await waitFor(() => getOverview(appid), 5000))) {
      log("error", "runner shortcut did not appear in the library");
      return null;
    }
    SteamClient.Apps.SetShortcutName(appid, RUNNER_BASE_NAME);
    await setRunnerAppId(appid);
  }
  hide(appid);
  runnerAppId = appid;
  return appid;
}

/** Remove the runner shortcut from Steam (used by the uninstall helper). */
export async function removeRunner(): Promise<boolean> {
  const info = await getRunnerInfo();
  const appid = info.ok ? info.appid : runnerAppId;
  if (!appid || !getOverview(appid)) return true;
  try {
    SteamClient.Apps.RemoveShortcut(appid);
  } catch (e) {
    log("error", `RemoveShortcut failed: ${String(e)}`);
    return false;
  }
  await setRunnerAppId(0);
  runnerAppId = 0;
  return !!(await waitFor(() => !getOverview(appid), 5000));
}

export function isRunning(appid: number): boolean {
  try {
    return SteamUIStore.RunningApps.some((a) => a.appid === appid);
  } catch {
    return false;
  }
}

export function isAnyGameRunning(): boolean {
  try {
    return SteamUIStore.RunningApps.length > 0;
  } catch {
    return false;
  }
}

/** Launch the runner via Steam. Resolves true once Steam reports it running. */
export async function launchRunner(appid: number, displayName: string): Promise<boolean> {
  try {
    SteamClient.Apps.SetShortcutName(appid, displayName);
  } catch {
    /* cosmetic only */
  }
  const gameId = getOverview(appid)?.gameid || shortcutGameId(appid);
  log("info", `RunGame ${gameId} (${displayName})`);
  try {
    SteamClient.Apps.RunGame(gameId, "", -1, 100);
  } catch (e) {
    log("error", `RunGame failed: ${String(e)}`);
    return false;
  }
  return !!(await waitFor(() => isRunning(appid), 20000, 250));
}

/** Resolves when the runner is no longer running. */
export async function waitForExit(appid: number): Promise<void> {
  // Sessions can last hours; poll slowly. Steam does not reliably report the
  // appid of shortcuts in lifetime notifications, so we watch RunningApps.
  while (isRunning(appid)) {
    await new Promise((r) => setTimeout(r, 1500));
  }
}
