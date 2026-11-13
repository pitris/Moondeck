import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backend, calls } from "./mocks/decky-api";
import { webpackModules } from "./mocks/decky-ui";
import { registerPowerHandlers, setStreaming } from "../../src/power";
import { settingsStore } from "../../src/store";

/** Simulated Steam sleep system: notifications + suspend blocks. */
function fakeSleepSystem() {
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
  webpackModules.push(sys);
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
