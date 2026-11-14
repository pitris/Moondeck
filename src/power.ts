/**
 * Follow the Legion's sleep/wake with the PC.
 *
 * - Legion goes to sleep during a Moonlight stream (opt-in): ask Apollo to run
 *   the "Moondeck: Sleep PC" app. Two independent triggers are registered,
 *   because this code cannot be exercised without the device:
 *     1. Steam's sleep manager notification + a suspend block
 *        (SuspendResumeStore.BlockSuspendAction), which gives us time to wait
 *        for Apollo's answer before the Legion suspends;
 *     2. SteamClient.System.RegisterForOnSuspendRequest, which fires even when
 *        no block is held. The request only has to be *sent* before the
 *        Legion freezes; Apollo runs it regardless of who waits for the reply.
 *   Whichever fires first sends the request; the other is ignored. Every path
 *   releases the block, so the Legion always goes to sleep (4 s hard limit).
 * - Legion wakes up after sleeping during a stream: send Wake-on-LAN a few
 *   times while Wi-Fi reconnects.
 * - Everything is written to a small history (Settings → Diagnostics), and a
 *   failed sleep request is shown as a notification after waking up.
 */
import { findModuleExport } from "@decky/ui";
import { toaster } from "@decky/api";
import { log, powerEvent, sleepPc, wakeHost } from "./backend";
import { settingsStore } from "./store";

export const SUSPEND_TIMEOUT_MS = 4000;
export const WAKE_SCHEDULE_MS = [0, 3000, 8000, 15000, 25000];
const DEDUPE_MS = 15000;

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
let lastSuspendHandled = 0;
let lastResumeHandled = 0;
let lastResumeAt = 0;
let pendingFailure: string | null = null;
export const hooks = { manager: false, system: false, store: false };

function note(message: string): void {
  log("info", `power: ${message}`);
  powerEvent(message).catch(() => undefined);
}

function suspendStore(): SuspendStore | null {
  return ((window as unknown as { SuspendResumeStore?: SuspendStore }).SuspendResumeStore) ?? null;
}

function sleepPcEnabled(): boolean {
  const s = settingsStore.current;
  return !!(s?.power?.sleep_pc_on_suspend && s?.apollo_web?.enabled);
}

/** True if the Legion woke up from sleep less than `ms` ago (a stream ending then died from the sleep). */
export function resumedWithin(ms: number): boolean {
  return lastResumeAt > 0 && Date.now() - lastResumeAt < ms;
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

export async function onSuspendRequested(source: string): Promise<void> {
  const now = Date.now();
  if (handlingSuspend || now - lastSuspendHandled < DEDUPE_MS) return; // the other trigger already handled it
  lastSuspendHandled = now;
  streamingAtSuspend = streaming;

  if (!streaming) return; // not our business: Steam sleeps by itself
  if (!sleepPcEnabled()) {
    const s = settingsStore.current;
    note(`Legion going to sleep during a stream; PC sleep is ${s?.power?.sleep_pc_on_suspend ? "on but Apollo web UI access is off" : "off"}`);
    return;
  }

  const blocking = !!releaseBlock;
  handlingSuspend = true;
  note(`Legion going to sleep during a stream (${source}${blocking ? ", holding sleep until the PC answers" : ""}) - asking the PC to sleep`);
  try {
    const r = await Promise.race([
      sleepPc(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SUSPEND_TIMEOUT_MS)),
    ]);
    if (r === null) pendingFailure = null; // sent, no answer in time: the backend records the outcome
    else if (!r.ok) pendingFailure = r.message;
    else pendingFailure = null;
  } catch (e) {
    pendingFailure = String(e);
  } finally {
    const release = releaseBlock;
    releaseBlock = null;
    try { release?.(); } catch { /* ignore */ }
    handlingSuspend = false;
    if (blocking) {
      try {
        suspendStore()?.RequestSleep();
      } catch (e) {
        log("error", `could not continue the suspend: ${String(e)}`);
      }
    }
  }
}

export async function onResumed(): Promise<void> {
  const now = Date.now();
  lastResumeAt = now;
  if (now - lastResumeHandled < DEDUPE_MS) return;
  lastResumeHandled = now;
  lastSuspendHandled = 0;
  const wasStreaming = streamingAtSuspend;
  streamingAtSuspend = false;
  updateSuspendBlock(); // block again if the stream is still running

  if (pendingFailure) {
    const reason = pendingFailure;
    pendingFailure = null;
    toaster.toast({ title: "Moondeck Apollo", body: `The PC could not be put to sleep: ${reason}`, duration: 10000 });
  }
  if (!wasStreaming) return;
  if (!(settingsStore.current?.power?.wake_on_resume ?? true)) {
    note("Legion woke up; waking the PC is turned off");
    return;
  }
  note("Legion woke up after sleeping during a stream - sending Wake-on-LAN");
  let elapsed = 0;
  for (const at of WAKE_SCHEDULE_MS) {
    await new Promise((r) => setTimeout(r, at - elapsed));
    elapsed = at;
    wakeHost().catch(() => undefined);
  }
}

/** Register sleep/wake handlers. Returns the cleanup function. */
export function registerPowerHandlers(): () => void {
  const regs: Unregisterable[] = [];
  hooks.manager = hooks.system = false;
  hooks.store = !!suspendStore();

  // Trigger 1: Steam's sleep manager (works together with the suspend block).
  try {
    const m = findModuleExport((mod: any) => mod?.RegisterForNotifyRequestSuspend && mod?.RegisterForNotifyResumeFromSuspend) as SleepNotifier | undefined;
    if (m) {
      regs.push(m.RegisterForNotifyRequestSuspend(() => { onSuspendRequested("sleep manager"); }));
      regs.push(m.RegisterForNotifyResumeFromSuspend(() => { onResumed(); }));
      hooks.manager = true;
    }
  } catch (e) {
    log("warning", `sleep manager hook failed: ${String(e)}`);
  }
  // Trigger 2: the raw system notification.
  try {
    const sys = (SteamClient as any)?.System;
    if (sys?.RegisterForOnSuspendRequest && sys?.RegisterForOnResumeFromSuspend) {
      regs.push(sys.RegisterForOnSuspendRequest(() => { onSuspendRequested("system"); }));
      regs.push(sys.RegisterForOnResumeFromSuspend(() => { onResumed(); }));
      hooks.system = true;
    }
  } catch (e) {
    log("warning", `system suspend hook failed: ${String(e)}`);
  }
  log("info", `power hooks: sleep manager ${hooks.manager ? "yes" : "NO"}, system ${hooks.system ? "yes" : "NO"}, suspend store ${hooks.store ? "yes" : "NO"}`);

  const unsub = settingsStore.subscribe(() => updateSuspendBlock());
  return () => {
    regs.forEach((r) => { try { r.unregister(); } catch { /* ignore */ } });
    unsub();
    streaming = false;
    handlingSuspend = false;
    lastSuspendHandled = lastResumeHandled = lastResumeAt = 0;
    streamingAtSuspend = false;
    pendingFailure = null;
    if (releaseBlock) { try { releaseBlock(); } catch { /* ignore */ } releaseBlock = null; }
  };
}
