/**
 * Follow the Legion's sleep/wake with the PC.
 *
 * - Legion goes to sleep during a Moonlight stream (opt-in): ask Apollo to run
 *   the "Moondeck: Sleep PC" app before the Legion suspends. Steam lets a
 *   plugin hold a suspend block (SuspendResumeStore.BlockSuspendAction); we
 *   hold it only while a stream is running and the option is on, send the
 *   request (at most SUSPEND_TIMEOUT_MS), then release the block and ask Steam
 *   to sleep again. Every path releases the block, so the Legion always sleeps.
 * - Legion wakes up after sleeping during a stream: send Wake-on-LAN a few
 *   times while Wi-Fi reconnects, so Moonlight can reconnect.
 */
import { findModuleExport } from "@decky/ui";
import { log, sleepPc, wakeHost } from "./backend";
import { settingsStore } from "./store";

export const SUSPEND_TIMEOUT_MS = 4000;
export const WAKE_SCHEDULE_MS = [0, 3000, 8000, 15000, 25000];

interface Unregisterable { unregister(): void }
interface SleepNotifier {
  RegisterForNotifyRequestSuspend(cb: (...a: unknown[]) => void): Unregisterable;
  RegisterForNotifyResumeFromSuspend(cb: (...a: unknown[]) => void): Unregisterable;
}
interface SuspendStore {
  BlockSuspendAction(): () => void;
  RequestSleep(): void;
}

let streaming = false;
let streamingAtSuspend = false;
let releaseBlock: (() => void) | null = null;
let handlingSuspend = false;

function suspendStore(): SuspendStore | null {
  return ((window as unknown as { SuspendResumeStore?: SuspendStore }).SuspendResumeStore) ?? null;
}

function sleepPcEnabled(): boolean {
  const s = settingsStore.current;
  return !!(s?.power?.sleep_pc_on_suspend && s?.apollo_web?.enabled);
}

/** Hold the suspend block exactly while it is needed. */
export function updateSuspendBlock(): void {
  const store = suspendStore();
  const want = streaming && sleepPcEnabled();
  if (want && !releaseBlock && store) {
    try {
      releaseBlock = store.BlockSuspendAction();
    } catch (e) {
      log("warning", `could not hold suspend block: ${String(e)}`);
    }
  } else if (!want && releaseBlock && !handlingSuspend) {
    const release = releaseBlock;
    releaseBlock = null;
    try { release(); } catch { /* ignore */ }
  }
}

/** Called by the launcher when a Moonlight session starts/ends. */
export function setStreaming(active: boolean): void {
  streaming = active;
  updateSuspendBlock();
}

export async function onSuspendRequested(): Promise<void> {
  streamingAtSuspend = streaming;
  if (!releaseBlock || handlingSuspend) return; // not blocking: Steam suspends by itself
  handlingSuspend = true;
  try {
    const r = await Promise.race([
      sleepPc(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SUSPEND_TIMEOUT_MS)),
    ]);
    if (r === null) log("warning", "PC sleep request timed out; letting the Legion sleep anyway");
    else if (!r.ok) log("warning", `PC sleep request failed: ${r.message}`);
    else log("info", "asked the PC to sleep");
  } catch (e) {
    log("warning", `PC sleep request failed: ${String(e)}`);
  } finally {
    const release = releaseBlock;
    releaseBlock = null;
    try { release?.(); } catch { /* ignore */ }
    handlingSuspend = false;
    try {
      suspendStore()?.RequestSleep();
    } catch (e) {
      log("error", `could not resume the suspend: ${String(e)}`);
    }
  }
}

export async function onResumed(): Promise<void> {
  const wasStreaming = streamingAtSuspend;
  streamingAtSuspend = false;
  updateSuspendBlock(); // block again if the stream is still running
  if (!wasStreaming || !(settingsStore.current?.power?.wake_on_resume ?? true)) return;
  log("info", "Legion woke up during a stream - waking the PC");
  let elapsed = 0;
  for (const at of WAKE_SCHEDULE_MS) {
    await new Promise((r) => setTimeout(r, at - elapsed));
    elapsed = at;
    wakeHost().catch(() => undefined);
  }
}

function findNotifier(): SleepNotifier | null {
  try {
    const m = findModuleExport((mod: any) => mod?.RegisterForNotifyRequestSuspend && mod?.RegisterForNotifyResumeFromSuspend);
    if (m) return m as SleepNotifier;
  } catch { /* fall through */ }
  const sys = (SteamClient as any)?.System;
  if (sys?.RegisterForOnSuspendRequest && sys?.RegisterForOnResumeFromSuspend) {
    return {
      RegisterForNotifyRequestSuspend: (cb) => sys.RegisterForOnSuspendRequest(cb),
      RegisterForNotifyResumeFromSuspend: (cb) => sys.RegisterForOnResumeFromSuspend(cb),
    };
  }
  return null;
}

/** Register sleep/wake handlers. Returns the cleanup function. */
export function registerPowerHandlers(): () => void {
  const notifier = findNotifier();
  if (!notifier) {
    log("warning", "Steam sleep notifications not found - PC sleep/wake follow-up disabled");
    return () => undefined;
  }
  if (!suspendStore()) log("warning", "SuspendResumeStore not found - cannot put the PC to sleep with the Legion");
  const regs: Unregisterable[] = [];
  try {
    regs.push(notifier.RegisterForNotifyRequestSuspend(() => { onSuspendRequested(); }));
    regs.push(notifier.RegisterForNotifyResumeFromSuspend(() => { onResumed(); }));
  } catch (e) {
    log("warning", `could not register sleep notifications: ${String(e)}`);
  }
  const unsub = settingsStore.subscribe(() => updateSuspendBlock());
  return () => {
    regs.forEach((r) => { try { r.unregister(); } catch { /* ignore */ } });
    unsub();
    streaming = false;
    handlingSuspend = false;
    updateSuspendBlock();
    if (releaseBlock) { try { releaseBlock(); } catch { /* ignore */ } releaseBlock = null; }
  };
}
