import { callable } from "@decky/api";

export type Placement = "below_play" | "hero";

export interface Settings {
  version: number;
  host: {
    address: string;
    moonlight_name: string;
    http_port: number;
    mac: string;
    wol_enabled: boolean;
    wol_broadcast: string;
    wake_timeout: number;
  };
  apollo_web: {
    enabled: boolean;
    port: number;
    username: string;
    password: string; // always "" from the backend
    password_set?: boolean;
    clear_password?: boolean;
    cert_sha256: string;
  };
  moonlight: {
    flatpak_id: string;
    custom_path: string;
    resolution: string;
    fps: string;
    bitrate_kbps: string;
    display_mode: string;
    video_codec: string;
    hdr: string;
    performance_overlay: string;
    quit_app_after: boolean;
    extra_args: string;
  };
  ui: {
    placement: Placement;
    label: string;
    rename_runner_per_launch: boolean;
    show_on_non_steam: boolean;
  };
  runner: { shortcut_appid: number };
  mappings: Record<string, { app_name: string; source: string; steam_name: string }>;
  apps_cache: { fetched_at: number; source: string; apps: ApolloApp[] };
}

export interface ApolloApp {
  name: string;
  id?: number;
  uuid?: string;
  hidden?: boolean;
  steam_appids?: number[];
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface Failure {
  ok: false;
  error: string;
  message: string;
  candidates?: string[];
  apps?: string[];
  can_create?: boolean;
  can_wake?: boolean;
  app_name?: string;
  output?: string;
}

export type Result<T> = ({ ok: true } & T) | Failure;

export interface HostInfo {
  online: boolean;
  error?: string;
  hostname?: string;
  appversion?: string;
  is_apollo?: boolean;
  current_game?: number;
  learned_mac?: string;
}

export interface SessionResult {
  exit_code: number | null;
  started_at: number | null;
  ended_at: number | null;
  duration?: number;
  app_name?: string;
  steam_appid?: string;
  error: string;
  message: string;
  log_tail: string;
}

export interface Status {
  host: HostInfo;
  moonlight: { installed: boolean; method: string; detail: string };
  configured: boolean;
  apps_cached: number;
  apps_fetched_at: number;
  last_session: SessionResult | null;
}

export interface Resolution {
  status: "manual" | "steam_appid" | "name" | "unmapped";
  app_name: string | null;
  candidates: string[];
  detail: string;
  mapped: boolean;
  apps: string[];
}

export interface Backup { name: string; size: number; mtime: number }
export interface MoonlightHost { name: string; uuid: string; address: string; local_address: string; mac: string }

export const getSettings = callable<[], Settings>("get_settings");
export const saveSettings = callable<[patch: DeepPartial<Settings>], Result<{ settings: Settings }>>("save_settings");
export const setMapping = callable<[steamAppId: number, appName: string | null, steamName: string], Result<{ mappings: Settings["mappings"] }>>("set_mapping");
export const getStatus = callable<[], Result<Status>>("status");
export const hostStatus = callable<[], HostInfo>("host_status");
export const detectMac = callable<[], Result<{ mac: string }>>("detect_mac");
export const wakeHost = callable<[], Result<{ sent: number }>>("wake_host");
export const refreshApps = callable<[], Result<{ apps: ApolloApp[]; source: string; warnings: string[] }>>("refresh_apps");
export const getApps = callable<[], Result<Settings["apps_cache"]>>("get_apps");
export const resolveApp = callable<[steamAppId: number, steamName: string], Result<Resolution>>("resolve");
export const createApolloApp = callable<[steamAppId: number, steamName: string], Result<{ app_name: string }>>("create_apollo_app");
export const prepareLaunch = callable<[steamAppId: number, steamName: string], Result<{ app_name: string; resolution: string }>>("prepare_launch");
export const cancelLaunch = callable<[], Result<object>>("cancel_launch");
export const lastSession = callable<[], Result<{ session: SessionResult | null }>>("last_session");
export const getRunnerInfo = callable<[], Result<{ path: string; start_dir: string; appid: number }>>("get_runner_info");
export const setRunnerAppId = callable<[appid: number], Result<object>>("set_runner_appid");
export const importMoonlightHosts = callable<[], Result<{ hosts: MoonlightHost[] }>>("import_moonlight_hosts");
export const backupSettings = callable<[label: string], Result<{ name: string; backups: Backup[] }>>("backup_settings");
export const listBackups = callable<[], Result<{ backups: Backup[] }>>("list_backups");
export const restoreBackup = callable<[name: string], Result<{ settings: Settings }>>("restore_backup");
export const uninstallCleanup = callable<[keepBackups: boolean], Result<{ backup: string | null }>>("uninstall_cleanup");
const logCallable = callable<[level: string, message: string], boolean>("log");

export function log(level: "debug" | "info" | "warning" | "error", message: string): void {
  console.log(`[Moondeck Apollo] ${level}: ${message}`);
  logCallable(level, message).catch(() => undefined);
}
