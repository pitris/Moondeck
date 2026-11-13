"""Decky Loader entry point for Moondeck Apollo.

Thin adapter: every method forwards to ``moondeck_apollo.service.Service``,
which contains the real logic and is unit-tested outside of Decky.
"""

import os
import sys

import decky  # provided by Decky Loader at runtime

# Decky adds py_modules to sys.path for us, but be explicit for older loaders.
_PY_MODULES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "py_modules")
if _PY_MODULES not in sys.path:
    sys.path.insert(0, _PY_MODULES)

from moondeck_apollo.service import Service  # noqa: E402


class Plugin:
    service: Service = None  # type: ignore[assignment]

    async def _main(self):
        # The runner path becomes the Steam shortcut's executable. Keep it free
        # of spaces so no quoting rules of Steam's shortcut parser come into play.
        runtime_dir = decky.DECKY_PLUGIN_RUNTIME_DIR
        if " " in runtime_dir:
            runtime_dir = os.path.join(decky.DECKY_USER_HOME, ".local", "share", "moondeck-apollo")
        self.service = Service(
            settings_dir=decky.DECKY_PLUGIN_SETTINGS_DIR,
            runtime_dir=runtime_dir,
            plugin_dir=decky.DECKY_PLUGIN_DIR,
            user_home=decky.DECKY_USER_HOME,
            emit=decky.emit,
            logger=decky.logger,
        )
        try:
            path = self.service.install_runner()
            decky.logger.info("Moondeck Apollo backend ready; runner at %s", path)
        except OSError:
            decky.logger.exception("Could not install runner script")

    async def _unload(self):
        decky.logger.info("Moondeck Apollo backend unloading")

    async def _uninstall(self):
        # Steam shortcut removal must happen in the frontend (SteamClient API);
        # see docs/UNINSTALL.md. Here we only remove runtime files and keep a
        # settings backup in DECKY_PLUGIN_SETTINGS_DIR/backups.
        if self.service:
            await self.service.uninstall_cleanup(keep_backups=True)

    # --- frontend API ---------------------------------------------------
    async def get_settings(self):
        return await self.service.get_settings()

    async def save_settings(self, patch):
        return await self.service.save_settings(patch)

    async def set_mapping(self, steam_appid, app_name, steam_name=""):
        return await self.service.set_mapping(steam_appid, app_name, steam_name)

    async def status(self):
        return await self.service.status()

    async def host_status(self):
        return await self.service.host_status()

    async def detect_mac(self):
        return await self.service.detect_mac()

    async def prepare_sleep_app(self):
        return await self.service.prepare_sleep_app()

    async def sleep_pc(self):
        return await self.service.sleep_pc()

    async def wake_host(self):
        return await self.service.wake_host()

    async def refresh_apps(self):
        return await self.service.refresh_apps()

    async def get_apps(self):
        return await self.service.get_apps()

    async def resolve(self, steam_appid, steam_name):
        return await self.service.resolve(steam_appid, steam_name)

    async def create_apollo_app(self, steam_appid, steam_name):
        return await self.service.create_apollo_app(steam_appid, steam_name)

    async def prepare_launch(self, steam_appid, steam_name):
        return await self.service.prepare_launch(steam_appid, steam_name)

    async def cancel_launch(self):
        return await self.service.cancel_launch()

    async def last_session(self):
        return await self.service.last_session()

    async def get_runner_info(self):
        return await self.service.get_runner_info()

    async def set_runner_appid(self, appid):
        return await self.service.set_runner_appid(appid)

    async def import_moonlight_hosts(self):
        return await self.service.import_moonlight_hosts()

    async def backup_settings(self, label="manual"):
        return await self.service.backup_settings(label)

    async def list_backups(self):
        return await self.service.list_backups()

    async def restore_backup(self, name):
        return await self.service.restore_backup(name)

    async def uninstall_cleanup(self, keep_backups=True):
        return await self.service.uninstall_cleanup(keep_backups)

    async def log(self, level, message):
        getattr(decky.logger, level if level in ("debug", "info", "warning", "error") else "info")(
            "[frontend] %s", message)
        return True
