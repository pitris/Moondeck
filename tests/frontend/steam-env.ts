/* Fake Steam client globals (appStore, collectionStore, SteamUIStore, SteamClient). */
export interface FakeSteam {
  overviews: Map<number, { appid: number; display_name: string; app_type: number; gameid: string }>;
  hidden: Set<number>;
  running: Set<number>;
  log: string[];
  nextShortcutId: number;
  /** what happens when RunGame is called */
  onRunGame: (gameId: string) => void;
}

export function installFakeSteam(): FakeSteam {
  const fake: FakeSteam = {
    overviews: new Map(),
    hidden: new Set(),
    running: new Set(),
    log: [],
    nextShortcutId: 3000000001,
    onRunGame: () => {},
  };
  const g = globalThis as any;
  g.appStore = { GetAppOverviewByAppID: (id: number) => fake.overviews.get(id) ?? null };
  g.collectionStore = {
    BIsHidden: (id: number) => fake.hidden.has(id),
    SetAppsAsHidden: (ids: number[], hide: boolean) => ids.forEach((id) => (hide ? fake.hidden.add(id) : fake.hidden.delete(id))),
  };
  g.SteamUIStore = {
    get RunningApps() { return [...fake.running].map((appid) => ({ appid })); },
  };
  g.SteamClient = {
    Apps: {
      AddShortcut: async (name: string, exe: string, dir: string) => {
        const id = fake.nextShortcutId++;
        fake.log.push(`AddShortcut ${name} ${exe} ${dir}`);
        fake.overviews.set(id, { appid: id, display_name: exe, app_type: 1073741824, gameid: `gid-${id}` });
        return id;
      },
      SetShortcutName: (id: number, name: string) => {
        fake.log.push(`SetShortcutName ${id} ${name}`);
        const o = fake.overviews.get(id);
        if (o) o.display_name = name;
      },
      SetShortcutExe: (id: number, exe: string) => fake.log.push(`SetShortcutExe ${id} ${exe}`),
      SetShortcutStartDir: (id: number, dir: string) => fake.log.push(`SetShortcutStartDir ${id} ${dir}`),
      RemoveShortcut: (id: number) => { fake.log.push(`RemoveShortcut ${id}`); fake.overviews.delete(id); },
      RunGame: (gameId: string, opts: string, p: number, src: number) => {
        fake.log.push(`RunGame ${gameId} ${JSON.stringify(opts)} ${p} ${src}`);
        fake.onRunGame(gameId);
      },
    },
  };
  return fake;
}
