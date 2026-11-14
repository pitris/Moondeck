import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backend, calls } from "./mocks/decky-api";
import { webpackModules } from "./mocks/decky-ui";
import { hooks, registerPowerHandlers, resumedWithin, setStreaming } from "../../src/power";
import { toasts } from "./mocks/decky-api";
import { settingsStore } from "../../src/store";

/** Simulated Steam sleep system: notifications + suspend blocks. */
function fakeSleepSystem(opts: { manager?: boolean; system?: boolean; store?: boolean } = {}) {
  const sys = {
    blocks: 0,
    sleepRequests: 0,
    onSuspend: [] as (() => void)[],
    onResume: [] as (() => void)[],
    RegisterForNotifyRequestSuspend(cb: () => void) { sys.onSuspend.push(cb); return { unregister() { sys.onSuspend = sys.onSuspend.filter((c) => c !== cb); } }; },
    RegisterForNotifyResumeFromSuspend(cb: () => void) { sys.onResume.push(cb); return { unregister() { sys.onResume = sys.onResume.filter((c) => c !== cb); } }; },
    suspend() { sys.onSuspend.forEach((c) => c()); },
    resume() { sys.onResume.forEach((c) => c()); },
  };
  (globalThis as any).SuspendResumeStore = {
    BlockSuspendAction() { sys.blocks++; let done = false; return () => { if (!done) { done = true; sys.blocks--; } }; },
    RequestSleep() { sys.sleepRequests++; },
  };
  webpackModules.length = 0;
  if (opts.manager !== false) webpackModules.push(sys);
  const system = {
    onSuspend: [] as (() => void)[],
    onResume: [] as (() => void)[],
    RegisterForOnSuspendRequest(cb: () => void) { system.onSuspend.push(cb); return { unregister() { system.onSuspend = []; } }; },
    RegisterForOnResumeFromSuspend(cb: () => void) { system.onResume.push(cb); return { unregister() { system.onResume = []; } }; },
  };
  (globalThis as any).SteamClient = { System: opts.system === false ? {} : system };
  if (opts.store === false) delete (globalThis as any).SuspendResumeStore;
  // A real suspend/resume fires both notification paths.
  sys.suspend = () => { sys.onSuspend.forEach((c) => c()); system.onSuspend.forEach((c) => c()); };
  sys.resume = () => { sys.onResume.forEach((c) => c()); system.onResume.forEach((c) => c()); };
  return sys;
}

function settings(power: object, webEnabled = true) {
  settingsStore.set({ apollo_web: { enabled: webEnabled }, power: { wake_on_resume: true, sleep_pc_on_suspend: false, sleep_app_uuid: "", ...power } } as any);
}

let sys: ReturnType<typeof fakeSleepSystem>;
let cleanup: () => void;
beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(backend)) delete backend[k];
  sys = fakeSleepSystem();
  settings({ sleep_pc_on_suspend: true });
  cleanup = registerPowerHandlers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("PC follows the Legion's sleep", () => {
  it("holds the suspend block only while streaming with the option on", () => {
    expect(sys.blocks).toBe(0);
    setStreaming(true);
    expect(sys.blocks).toBe(1);
    settings({ sleep_pc_on_suspend: false });
    expect(sys.blocks).toBe(0);
    settings({ sleep_pc_on_suspend: true }, false); // web UI access off
    expect(sys.blocks).toBe(0);
    settings({ sleep_pc_on_suspend: true });
    expect(sys.blocks).toBe(1);
    setStreaming(false);
    expect(sys.blocks).toBe(0);
  });

  it("on suspend during a stream: sleeps the PC, then releases the block and lets the Legion sleep", async () => {
    let resolveSleep!: (v: unknown) => void;
    backend.sleep_pc = () => new Promise((r) => { resolveSleep = r; });
    setStreaming(true);
    sys.suspend();
    await flush();
    expect(calls.map((c) => c.route)).toContain("sleep_pc");
    expect(sys.blocks).toBe(1); // still held while the request is in flight
    expect(sys.sleepRequests).toBe(0);
    resolveSleep({ ok: true });
    await flush();
    expect(sys.blocks).toBe(0);
    expect(sys.sleepRequests).toBe(1);
  });

  it("never keeps the Legion awake: a hanging or failing request times out", async () => {
    vi.useFakeTimers();
    backend.sleep_pc = () => new Promise(() => {}); // never answers
    setStreaming(true);
    sys.suspend();
    await vi.advanceTimersByTimeAsync(4100);
    expect(sys.blocks).toBe(0);
    expect(sys.sleepRequests).toBe(1);
    backend.sleep_pc = () => { throw new Error("boom"); };
    sys.resume(); // re-blocks (still streaming)
    expect(sys.blocks).toBe(1);
    sys.suspend();
    await vi.advanceTimersByTimeAsync(10);
    expect(sys.blocks).toBe(0);
    expect(sys.sleepRequests).toBe(2);
  });

  it("does nothing when not streaming (Steam sleeps on its own)", async () => {
    backend.sleep_pc = () => ({ ok: true });
    sys.suspend();
    await flush();
    expect(calls.map((c) => c.route)).not.toContain("sleep_pc");
    expect(sys.sleepRequests).toBe(0);
  });
});

describe("robustness and visibility", () => {
  it("both triggers fire on a real suspend but the PC is asked only once", async () => {
    backend.sleep_pc = () => ({ ok: true });
    expect(hooks).toMatchObject({ manager: true, system: true, store: true });
    setStreaming(true);
    sys.suspend();
    await flush();
    expect(calls.filter((c) => c.route === "sleep_pc")).toHaveLength(1);
    expect(sys.sleepRequests).toBe(1);
  });

  it("still asks the PC to sleep when only the plain system notification exists", async () => {
    cleanup();
    sys = fakeSleepSystem({ manager: false, store: false });
    cleanup = registerPowerHandlers();
    expect(hooks).toMatchObject({ manager: false, system: true, store: false });
    backend.sleep_pc = () => ({ ok: true });
    setStreaming(true);
    sys.suspend();
    await flush();
    expect(calls.filter((c) => c.route === "sleep_pc")).toHaveLength(1);
    expect(sys.sleepRequests).toBe(0); // no block was held, Steam continues on its own
  });

  it("writes the history and reports a failed sleep after waking up", async () => {
    backend.sleep_pc = () => ({ ok: false, error: "WEB_UNREACHABLE", message: "Cannot reach Apollo web UI" });
    toasts.length = 0;
    setStreaming(true);
    sys.suspend();
    await flush();
    const notes = calls.filter((c) => c.route === "power_event").map((c) => String(c.args[0]));
    expect(notes.some((n) => n.includes("asking the PC to sleep"))).toBe(true);
    expect(resumedWithin(60000)).toBe(false);
    sys.resume();
    await flush();
    expect(resumedWithin(60000)).toBe(true);
    expect(JSON.stringify(toasts)).toContain("could not be put to sleep: Cannot reach Apollo web UI");
  });

  it("explains in the history when the option is off", async () => {
    settings({ sleep_pc_on_suspend: false });
    setStreaming(true);
    sys.suspend();
    await flush();
    expect(calls.map((c) => c.route)).not.toContain("sleep_pc");
    expect(calls.filter((c) => c.route === "power_event").map((c) => String(c.args[0])).join()).toContain("PC sleep is off");
  });
});

describe("PC follows the Legion's wake", () => {
  it("sends Wake-on-LAN repeatedly after waking from a stream", async () => {
    vi.useFakeTimers();
    backend.sleep_pc = () => ({ ok: true });
    setStreaming(true);
    sys.suspend();
    await vi.advanceTimersByTimeAsync(10);
    sys.resume();
    await vi.advanceTimersByTimeAsync(26000);
    expect(calls.filter((c) => c.route === "wake_host")).toHaveLength(5);
  });

  it("no Wake-on-LAN after a normal sleep, or when turned off", async () => {
    vi.useFakeTimers();
    sys.suspend();
    sys.resume();
    await vi.advanceTimersByTimeAsync(26000);
    expect(calls.filter((c) => c.route === "wake_host")).toHaveLength(0);
    settings({ wake_on_resume: false, sleep_pc_on_suspend: false });
    setStreaming(true);
    sys.suspend();
    sys.resume();
    await vi.advanceTimersByTimeAsync(26000);
    expect(calls.filter((c) => c.route === "wake_host")).toHaveLength(0);
  });
});
