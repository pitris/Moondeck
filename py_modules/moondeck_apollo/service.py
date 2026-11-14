"""Backend service: everything the frontend can ask for.

Kept free of the ``decky`` module so it can be exercised by unit tests with a
fake Apollo server and a fake Moonlight binary.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional

from . import apollo, launch, mapping, moonlight, moonlight_conf, wol
from .settings import SettingsError, SettingsStore, redacted

EmitFn = Callable[..., Awaitable[None]]

APPS_CACHE_FRESH = 10 * 60  # seconds before we re-check the Apollo app list at launch


def _err(code: str, message: str, **extra: Any) -> Dict[str, Any]:
    out = {"ok": False, "error": code, "message": message}
    out.update(extra)
    return out


class Service:
    def __init__(self, settings_dir: str, runtime_dir: str, plugin_dir: str, user_home: str,
                 emit: Optional[EmitFn] = None, logger: Optional[logging.Logger] = None):
        self.store = SettingsStore(settings_dir)
        self.runtime_dir = runtime_dir
        self.plugin_dir = plugin_dir
        self.user_home = user_home
        self.emit = emit
        self.log = logger or logging.getLogger("moondeck_apollo")
        self._launch_lock = asyncio.Lock()
        self._cancelled = False
        self._web: Optional[apollo.ApolloWebClient] = None
        self._web_key: tuple = ()
        os.makedirs(runtime_dir, exist_ok=True)

    # ------------------------------------------------------------------ setup
    def install_runner(self) -> str:
        src = os.path.join(self.plugin_dir, "bin", launch.RUNNER_NAME)
        return launch.install_runner(src, self.runtime_dir)

    async def _progress(self, stage: str, message: str) -> None:
        self.log.info("progress %s: %s", stage, message)
        if self.emit:
            try:
                await self.emit("launch_progress", {"stage": stage, "message": message})
            except Exception:  # never let UI notification failures abort a launch
                self.log.exception("emit failed")

    # --------------------------------------------------------------- settings
    async def get_settings(self) -> Dict[str, Any]:
        return redacted(self.store.load())

    async def save_settings(self, patch: Dict[str, Any]) -> Dict[str, Any]:
        patch = dict(patch or {})
        web = dict(patch.get("apollo_web") or {})
        web.pop("password_set", None)
        # The UI never receives the stored password; an empty/missing value
        # means "keep the current one". clear_password=True removes it.
        if web.pop("clear_password", False):
            web["password"] = ""
        elif not web.get("password"):
            web.pop("password", None)
        current = self.store.load()
        # Pointing at a different web UI port invalidates the pinned certificate.
        if "port" in web and str(web["port"]) != str(current["apollo_web"]["port"]):
            web["cert_sha256"] = ""
        if web:
            patch["apollo_web"] = web
        host = patch.get("host") or {}
        if host.get("address") and host["address"] != current["host"]["address"]:
            patch.setdefault("apollo_web", {})["cert_sha256"] = ""
            patch["apps_cache"] = {"fetched_at": 0, "source": "", "apps": []}
        try:
            return {"ok": True, "settings": redacted(self.store.update(patch))}
        except SettingsError as e:
            return _err("INVALID_SETTINGS", str(e))

    async def set_mapping(self, steam_appid: int, app_name: Optional[str], steam_name: str = "") -> Dict[str, Any]:
        data = self.store.set_mapping(int(steam_appid), app_name or None, "manual", steam_name)
        return {"ok": True, "mappings": data["mappings"]}

    async def backup_settings(self, label: str = "manual") -> Dict[str, Any]:
        return {"ok": True, "name": self.store.backup(label), "backups": self.store.list_backups()}

    async def list_backups(self) -> Dict[str, Any]:
        return {"ok": True, "backups": self.store.list_backups()}

    async def restore_backup(self, name: str) -> Dict[str, Any]:
        try:
            data = self.store.restore(name)
        except (OSError, ValueError, SettingsError) as e:
            return _err("RESTORE_FAILED", str(e))
        return {"ok": True, "settings": redacted(data)}

    async def set_runner_appid(self, appid: int) -> Dict[str, Any]:
        self.store.update({"runner": {"shortcut_appid": int(appid)}})
        return {"ok": True}

    async def get_runner_info(self) -> Dict[str, Any]:
        path = self.install_runner()
        return {"ok": True, "path": path, "start_dir": self.runtime_dir,
                "appid": self.store.load()["runner"]["shortcut_appid"]}

    async def import_moonlight_hosts(self) -> Dict[str, Any]:
        try:
            hosts = moonlight_conf.read_hosts(self.user_home)
        except OSError as e:
            return _err("READ_FAILED", str(e))
        return {"ok": True, "hosts": hosts}

    async def uninstall_cleanup(self, keep_backups: bool = True) -> Dict[str, Any]:
        """Remove runtime files (runner, request, logs). Settings backups stay unless asked."""
        name = self.store.backup("pre-uninstall")
        shutil.rmtree(self.runtime_dir, ignore_errors=True)
        if not keep_backups:
            shutil.rmtree(self.store.dir, ignore_errors=True)
        return {"ok": True, "backup": name if keep_backups else None}

    # ----------------------------------------------------------------- status
    async def host_status(self) -> Dict[str, Any]:
        s = self.store.load()
        info = await asyncio.to_thread(apollo.probe_serverinfo, s["host"]["address"], s["host"]["http_port"])
        if info.get("online") and not s["host"]["mac"]:
            mac = await self._learn_mac(s)
            if mac:
                info["learned_mac"] = mac
        return info

    async def _learn_mac(self, s: Dict[str, Any]) -> str:
        ip = await asyncio.to_thread(wol.resolve_ipv4, s["host"]["address"])
        mac = wol.lookup_mac_in_arp(ip) if ip else None
        if mac:
            self.store.update({"host": {"mac": mac}})
            self.log.info("learned host MAC %s from ARP cache", mac)
        return mac or ""

    async def status(self) -> Dict[str, Any]:
        s = self.store.load()
        host, ml = await asyncio.gather(self.host_status(), moonlight.detect(s))
        return {
            "ok": True,
            "host": host,
            "moonlight": ml,
            "configured": bool(s["host"]["address"]),
            "apps_cached": len(s["apps_cache"]["apps"]),
            "apps_fetched_at": s["apps_cache"]["fetched_at"],
            "last_session": launch.read_result(self.runtime_dir),
        }

    async def detect_mac(self) -> Dict[str, Any]:
        s = self.store.load()
        info = await asyncio.to_thread(apollo.probe_serverinfo, s["host"]["address"], s["host"]["http_port"])
        if not info.get("online"):
            return _err("HOST_OFFLINE", "Turn the PC on first: the MAC is read from the network while it is online.")
        mac = info.get("mac") or await self._learn_mac(s)
        if not mac:
            return _err("MAC_UNKNOWN", "Could not determine the MAC address (is the PC on another subnet?). Enter it manually.")
        self.store.update({"host": {"mac": mac}})
        return {"ok": True, "mac": mac}

    async def wake_host(self) -> Dict[str, Any]:
        s = self.store.load()
        if not s["host"]["mac"]:
            return _err("NO_MAC", "No MAC address configured for Wake-on-LAN.")
        sent = await asyncio.to_thread(wol.send_magic_packet, s["host"]["mac"], s["host"]["address"],
                                       s["host"]["wol_broadcast"])
        return {"ok": sent > 0, "sent": sent}

    # ------------------------------------------------------------------- apps
    async def refresh_apps(self) -> Dict[str, Any]:
        """Fetch the Apollo app list (web API when configured, else Moonlight CLI)."""
        s = self.store.load()
        if not s["host"]["address"]:
            return _err("NO_HOST", "Configure the Apollo host first.")
        errors: List[str] = []
        apps: Optional[List[Dict[str, Any]]] = None
        source = ""
        if s["apollo_web"]["enabled"]:
            try:
                apps = await asyncio.to_thread(self._web_apps, s)
                source = "apollo_web"
            except apollo.ApolloError as e:
                errors.append(f"Apollo web UI: {e.message}")
                if e.code == "CERT_MISMATCH":
                    return _err(e.code, e.message)
        if apps is None:
            try:
                apps = await moonlight.list_apps(s)
                source = "moonlight"
            except moonlight.MoonlightError as e:
                errors.append(f"Moonlight: {e.message}")
                return _err(e.code if not errors[:-1] else "APPS_UNAVAILABLE", "; ".join(errors),
                            output=e.output)
        for app in apps:
            if app.get("name") == apollo.SLEEP_APP_NAME:
                app["hidden"] = True  # never offered as a game
        self.store.update({"apps_cache": {"fetched_at": time.time(), "source": source, "apps": apps}})
        return {"ok": True, "apps": apps, "source": source, "warnings": errors}

    def _web_client(self, s: Dict[str, Any]) -> apollo.ApolloWebClient:
        """Web client that keeps its login, so time-critical calls (putting the
        PC to sleep right before the handheld suspends) need a single request."""
        w = s["apollo_web"]
        key = (s["host"]["address"], w["port"], w["username"], w["password"], w["cert_sha256"])
        if self._web is None or self._web_key != key:
            self._web = apollo.ApolloWebClient(s["host"]["address"], w["port"], w["username"], w["password"],
                                               pinned_sha256=w["cert_sha256"])
            self._web_key = key
        return self._web

    def _web_apps(self, s: Dict[str, Any]) -> List[Dict[str, Any]]:
        client = self._web_client(s)
        apps = client.get_apps()
        if not s["apollo_web"]["cert_sha256"] and client.seen_sha256:
            self.store.update({"apollo_web": {"cert_sha256": client.seen_sha256}})
        return apps

    async def get_apps(self) -> Dict[str, Any]:
        cache = self.store.load()["apps_cache"]
        return {"ok": True, **cache}

    async def resolve(self, steam_appid: int, steam_name: str) -> Dict[str, Any]:
        s = self.store.load()
        res = mapping.resolve(int(steam_appid), steam_name, s["mappings"], s["apps_cache"]["apps"])
        return {"ok": True, **res.to_dict(), "apps": [a["name"] for a in s["apps_cache"]["apps"] if not a.get("hidden")]}

    async def create_apollo_app(self, steam_appid: int, steam_name: str) -> Dict[str, Any]:
        s = self.store.load()
        if not s["apollo_web"]["enabled"]:
            return _err("WEB_DISABLED", "Enable Apollo web UI access in settings to create apps from here.")
        if int(steam_appid) <= 0:
            return _err("NOT_STEAM", "Only Steam games can be added to Apollo automatically.")
        name = steam_name.strip() or f"Steam {steam_appid}"
        try:
            result = await asyncio.to_thread(self._create_app, s, name, int(steam_appid))
        except apollo.ApolloError as e:
            return _err(e.code, e.message)
        self.store.set_mapping(int(steam_appid), name, "created", steam_name)
        refreshed = await self.refresh_apps()
        return {"ok": True, "app_name": name, "result": result, "refreshed": refreshed.get("ok", False)}

    def _create_app(self, s: Dict[str, Any], name: str, appid: int) -> str:
        client = self._web_client(s)
        result = client.ensure_steam_app(name, appid, s["apollo_web"]["new_app_virtual_display"])
        if not s["apollo_web"]["cert_sha256"] and client.seen_sha256:
            self.store.update({"apollo_web": {"cert_sha256": client.seen_sha256}})
        return result

    # ------------------------------------------------------------------ power
    POWER_LOG = "power.log"

    def power_note(self, message: str) -> None:
        """Append to the small sleep/wake history shown under Diagnostics."""
        self.log.info("power: %s", message)
        path = os.path.join(self.runtime_dir, self.POWER_LOG)
        try:
            os.makedirs(self.runtime_dir, exist_ok=True)
            lines: List[str] = []
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    lines = f.read().splitlines()[-59:]
            lines.append(time.strftime("%Y-%m-%d %H:%M:%S") + "  " + message)
            with open(path, "w", encoding="utf-8") as f:
                f.write("\n".join(lines) + "\n")
        except OSError:
            pass

    async def power_event(self, message: str) -> Dict[str, Any]:
        self.power_note(str(message)[:300])
        return {"ok": True}

    async def power_log(self) -> Dict[str, Any]:
        path = os.path.join(self.runtime_dir, self.POWER_LOG)
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                lines = f.read().splitlines()[-60:]
        except OSError:
            lines = []
        s = self.store.load()
        return {"ok": True, "lines": lines, "sleep_enabled": s["power"]["sleep_pc_on_suspend"],
                "wake_enabled": s["power"]["wake_on_resume"], "web_enabled": s["apollo_web"]["enabled"],
                "sleep_app_ready": bool(s["power"]["sleep_app_uuid"])}

    async def prepare_sleep_app(self) -> Dict[str, Any]:
        """Create the Sleep PC app now, so going to sleep later needs one request."""
        s = self.store.load()
        if not s["apollo_web"]["enabled"]:
            return _err("WEB_DISABLED", "Putting the PC to sleep needs Apollo web UI access (Apps & mappings).")
        try:
            uuid = await asyncio.to_thread(lambda: self._web_client(s).ensure_sleep_app())
        except apollo.ApolloError as e:
            self.power_note(f"could not set up the Sleep PC app: {e.message}")
            return _err(e.code, e.message)
        self.store.update({"power": {"sleep_app_uuid": uuid}})
        self.power_note("Sleep PC app is set up in Apollo")
        return {"ok": True, "uuid": uuid}

    async def sleep_pc(self) -> Dict[str, Any]:
        """Ask Apollo to run the Sleep PC app. Called right before the handheld suspends."""
        s = self.store.load()
        if not s["apollo_web"]["enabled"]:
            self.power_note("PC sleep skipped: Apollo web UI access is off")
            return _err("WEB_DISABLED", "Apollo web UI access is off.")

        def run() -> str:
            client = self._web_client(s)
            uuid = s["power"]["sleep_app_uuid"]
            if uuid:
                try:
                    client.launch_app(uuid)
                    return uuid
                except apollo.ApolloError as e:
                    if e.code != "APP_NOT_FOUND":
                        raise
            uuid = client.ensure_sleep_app()
            client.launch_app(uuid)
            return uuid

        started = time.monotonic()
        try:
            uuid = await asyncio.to_thread(run)
        except apollo.ApolloError as e:
            self.power_note(f"PC sleep FAILED: {e.message}")
            return _err(e.code, e.message)
        if uuid != s["power"]["sleep_app_uuid"]:
            self.store.update({"power": {"sleep_app_uuid": uuid}})
        self.power_note(f"PC sleep requested: Apollo accepted it ({time.monotonic() - started:.1f}s)")
        return {"ok": True}

    def _clear_sleep_app(self, s: Dict[str, Any]) -> bool:
        """If Apollo still lists the Sleep PC app as running, end it."""
        uuid = s["power"]["sleep_app_uuid"]
        if not (s["apollo_web"]["enabled"] and uuid):
            return False
        client = self._web_client(s)
        if client.current_app_uuid() != uuid:
            return False
        client.close_app()
        return True

    async def end_session(self) -> Dict[str, Any]:
        """End Apollo's session after a stream, so Moonlight does not report it as still running."""
        s = self.store.load()
        if not s["moonlight"]["end_session_on_exit"]:
            return {"ok": True, "method": "off"}
        errors: List[str] = []
        if s["apollo_web"]["enabled"]:
            try:
                await asyncio.to_thread(lambda: self._web_client(s).close_app())
                self.log.info("ended Apollo session via web API")
                return {"ok": True, "method": "apollo_web"}
            except apollo.ApolloError as e:
                errors.append(e.message)
        try:
            await moonlight.quit_app(s)
            self.log.info("ended Apollo session via moonlight quit")
            return {"ok": True, "method": "moonlight"}
        except moonlight.MoonlightError as e:
            errors.append(e.message)
        self.log.warning("could not end Apollo session: %s", "; ".join(errors))
        return _err("END_SESSION_FAILED", "; ".join(errors))

    # ----------------------------------------------------------------- launch
    async def prepare_launch(self, steam_appid: int, steam_name: str) -> Dict[str, Any]:
        """Run every pre-flight check and write the runner request.

        Returns ``{"ok": True, "app_name": ...}`` when the frontend should ask
        Steam to start the runner shortcut, otherwise an error code the UI
        turns into a dialog: NO_HOST, MOONLIGHT_MISSING, UNMAPPED, HOST_OFFLINE,
        APP_MISSING, BUSY.
        """
        if self._launch_lock.locked():
            return _err("BUSY", "A Moonlight launch is already being prepared.")
        async with self._launch_lock:
            self._cancelled = False
            result = await self._prepare_launch(int(steam_appid), steam_name)
            if self._cancelled:
                launch.clear_request(self.runtime_dir)
                return _err("CANCELLED", "Launch cancelled.")
            return result

    async def _prepare_launch(self, steam_appid: int, steam_name: str) -> Dict[str, Any]:
        s = self.store.load()
        launch.clear_request(self.runtime_dir)
        if not s["host"]["address"]:
            return _err("NO_HOST", "Set up your Apollo PC in the Moondeck Apollo settings first.")

        ml = await moonlight.detect(s)
        if not ml["installed"]:
            return _err("MOONLIGHT_MISSING", "Moonlight was not found. Install it from Discover "
                                             "(Flatpak com.moonlight_stream.Moonlight) or set a custom path.")

        res = mapping.resolve(steam_appid, steam_name, s["mappings"], s["apps_cache"]["apps"])
        if not res.app_name and not s["apps_cache"]["apps"]:
            # Nothing cached yet - try to fetch once so auto-matching can work.
            await self._ensure_online(s)
            if (await self.refresh_apps()).get("ok"):
                s = self.store.load()
                res = mapping.resolve(steam_appid, steam_name, s["mappings"], s["apps_cache"]["apps"])
        if not res.app_name:
            return _err("UNMAPPED", res.detail, candidates=res.candidates,
                        apps=[a["name"] for a in s["apps_cache"]["apps"] if not a.get("hidden")],
                        can_create=s["apollo_web"]["enabled"] and steam_appid > 0)

        online = await self._ensure_online(s)
        if not online:
            hint = "" if s["host"]["mac"] else " Wake-on-LAN is not set up (no MAC address)."
            return _err("HOST_OFFLINE", f"Your PC ({s['host']['address']}) is not responding.{hint}",
                        can_wake=bool(s["host"]["mac"]))

        # Verify the Apollo app still exists. Use the cache when fresh; refresh
        # otherwise. If the list cannot be fetched we still launch and let
        # Moonlight report the problem rather than blocking the user.
        cache = s["apps_cache"]
        if time.time() - cache["fetched_at"] > APPS_CACHE_FRESH or not mapping.app_exists(res.app_name, cache["apps"]):
            await self._progress("apps", "Checking Apollo app list…")
            refreshed = await self.refresh_apps()
            if refreshed.get("ok") and not mapping.app_exists(res.app_name, refreshed["apps"]):
                return _err("APP_MISSING", f"Apollo has no app named “{res.app_name}” any more.",
                            app_name=res.app_name,
                            apps=[a["name"] for a in refreshed["apps"] if not a.get("hidden")],
                            can_create=s["apollo_web"]["enabled"] and steam_appid > 0)

        # After the PC was put to sleep, Apollo can still list "Sleep PC" as its
        # running app; Moonlight would then ask to quit it. Clear that first.
        try:
            if await asyncio.to_thread(self._clear_sleep_app, s):
                self.power_note("cleared the finished Sleep PC app in Apollo")
        except apollo.ApolloError as e:
            self.log.warning("could not check Apollo's running app: %s", e.message)

        self.install_runner()
        argv = moonlight.build_stream_argv(s, res.app_name)
        launch.write_request(self.runtime_dir, argv, {
            "app_name": res.app_name, "steam_appid": steam_appid, "steam_name": steam_name,
        })
        self.log.info("launch prepared for %s (%s) -> %r", steam_name, steam_appid, argv)
        await self._progress("ready", f"Starting {res.app_name}…")
        return {"ok": True, "app_name": res.app_name, "resolution": res.status}

    async def _ensure_online(self, s: Dict[str, Any]) -> bool:
        host = s["host"]
        await self._progress("probe", f"Contacting {host['address']}…")
        info = await asyncio.to_thread(apollo.probe_serverinfo, host["address"], host["http_port"])
        if info.get("online"):
            if not host["mac"]:
                await self._learn_mac(s)
            return True
        if not (host["wol_enabled"] and host["mac"]):
            return False
        await self._progress("wake", "PC is asleep – sending Wake-on-LAN…")
        deadline = time.monotonic() + host["wake_timeout"]
        last_packet = 0.0
        while time.monotonic() < deadline and not self._cancelled:
            if time.monotonic() - last_packet > 10:
                await asyncio.to_thread(wol.send_magic_packet, host["mac"], host["address"], host["wol_broadcast"])
                last_packet = time.monotonic()
            await asyncio.sleep(2)
            info = await asyncio.to_thread(apollo.probe_serverinfo, host["address"], host["http_port"], 2.0)
            if info.get("online"):
                await self._progress("woke", "PC is awake – waiting for Apollo…")
                # Apollo answers serverinfo slightly before it can stream.
                await asyncio.sleep(3)
                return True
            remaining = int(deadline - time.monotonic())
            await self._progress("wake", f"Waiting for PC to wake… ({max(remaining, 0)}s)")
        return False

    async def cancel_launch(self) -> Dict[str, Any]:
        self._cancelled = True
        launch.clear_request(self.runtime_dir)
        return {"ok": True}

    async def last_session(self) -> Dict[str, Any]:
        result = launch.read_result(self.runtime_dir)
        if not result:
            return {"ok": True, "session": None}
        code, message = ("", "")
        if result.get("exit_code"):
            code, message = moonlight.classify_output(result.get("log_tail", ""))
        result["error"] = code
        result["message"] = message
        return {"ok": True, "session": result}
