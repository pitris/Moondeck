"""Loads main.py the way Decky Loader does, with a stand-in ``decky`` module.

If ``out/moondeck-apollo.zip`` exists (``pnpm run package``) the test runs
against the extracted zip, which also verifies the package layout.
"""

from __future__ import annotations

import asyncio
import importlib.util
import logging
import os
import shutil
import sys
import tempfile
import types
import unittest
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ZIP = os.path.join(ROOT, "out", "moondeck-apollo.zip")


class PluginEntryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        if os.path.exists(ZIP):
            with zipfile.ZipFile(ZIP) as z:
                z.extractall(os.path.join(self.tmp, "plugins"))
            self.plugin_dir = os.path.join(self.tmp, "plugins", "moondeck-apollo")
            for rel in ("plugin.json", "main.py", "dist/index.js", "bin/moonlight-runner.sh",
                        "py_modules/moondeck_apollo/service.py", "LICENSE"):
                self.assertTrue(os.path.exists(os.path.join(self.plugin_dir, rel)), rel)
        else:
            self.plugin_dir = ROOT
        self.events = []

        async def emit(event, *args):
            self.events.append((event, args))

        home = os.path.join(self.tmp, "home")
        decky = types.ModuleType("decky")
        decky.DECKY_PLUGIN_SETTINGS_DIR = os.path.join(home, "homebrew", "settings", "moondeck-apollo")
        # Simulate a plugin folder with a space to exercise the fallback path.
        decky.DECKY_PLUGIN_RUNTIME_DIR = os.path.join(home, "homebrew", "data", "Moondeck Apollo")
        decky.DECKY_PLUGIN_DIR = self.plugin_dir
        decky.DECKY_USER_HOME = home
        decky.emit = emit
        decky.logger = logging.getLogger("decky-test")
        sys.modules["decky"] = decky
        spec = importlib.util.spec_from_file_location("plugin_main", os.path.join(self.plugin_dir, "main.py"))
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.home = home

    def tearDown(self):
        sys.modules.pop("decky", None)
        shutil.rmtree(self.tmp)

    def test_lifecycle(self):
        p = self.module.Plugin()

        async def flow():
            await p._main()
            info = await p.get_runner_info()
            self.assertTrue(info["ok"])
            self.assertNotIn(" ", info["path"])
            self.assertEqual(info["path"], os.path.join(self.home, ".local", "share", "moondeck-apollo",
                                                        "moonlight-runner.sh"))
            self.assertTrue(os.access(info["path"], os.X_OK))
            s = await p.get_settings()
            self.assertEqual(s["host"]["http_port"], 47989)
            r = await p.save_settings({"host": {"address": "192.168.1.50"}})
            self.assertTrue(r["ok"])
            r = await p.prepare_launch(1091500, "Cyberpunk 2077")
            self.assertFalse(r["ok"])
            self.assertIn(r["error"], ("MOONLIGHT_MISSING", "UNMAPPED", "HOST_OFFLINE"))
            self.assertTrue((await p.set_mapping(1091500, "Cyberpunk 2077", "Cyberpunk 2077"))["ok"])
            self.assertTrue((await p.backup_settings("t"))["ok"])
            self.assertTrue(await p.log("info", "hello"))
            await p._unload()
            await p._uninstall()
            self.assertFalse(os.path.exists(os.path.dirname(info["path"])))

        asyncio.run(flow())


if __name__ == "__main__":
    unittest.main()
