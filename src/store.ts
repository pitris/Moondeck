import { useEffect, useState } from "react";
import { DeepPartial, Settings, getSettings, log, saveSettings } from "./backend";

type Listener = (s: Settings | null) => void;

/** In-memory copy of the backend settings so render patches can read them synchronously. */
class SettingsStore {
  current: Settings | null = null;
  private listeners = new Set<Listener>();

  async load(): Promise<Settings | null> {
    try {
      const s = await getSettings();
      if (s && typeof s === "object" && "host" in s && "ui" in s) this.set(s);
      else log("error", "backend returned malformed settings");
    } catch (e) {
      log("error", `could not load settings: ${String(e)}`);
    }
    return this.current;
  }

  /** Saves a partial update. Returns an error message, or null on success. */
  async save(patch: DeepPartial<Settings>): Promise<string | null> {
    const r = await saveSettings(patch);
    if (!r.ok) return r.message;
    this.set(r.settings);
    return null;
  }

  set(s: Settings | null): void {
    this.current = s;
    this.listeners.forEach((l) => l(s));
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const settingsStore = new SettingsStore();

export function useSettings(): Settings | null {
  const [s, setS] = useState(settingsStore.current);
  useEffect(() => {
    const unsub = settingsStore.subscribe(setS);
    if (!settingsStore.current) settingsStore.load();
    return () => { unsub(); };
  }, []);
  return s;
}
