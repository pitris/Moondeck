"""The backend must only import modules that exist inside Decky's frozen Python.

Decky Loader runs plugin backends in its PyInstaller binary, which contains
only the standard-library modules Decky itself uses (see
decky_stdlib_modules.txt, extracted from the v3.3.1 release binary). Importing
anything else (e.g. ``shlex`` or ``xml.etree``) crashes the backend, and
every frontend call then hangs. This test runs the plugin in a fresh
interpreter where all other standard-library imports fail.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

CHILD = textwrap.dedent(r'''
    import sys
    allowed = {l.strip() for l in open(sys.argv[1]) if l.strip() and not l.startswith("#")}
    import _imp
    # CPython's own frozen startup modules (os, abc, codecs, _collections_abc, ...)
    # live inside every libpython, including Decky's.
    allowed |= set(getattr(_imp, "_frozen_module_names", lambda: [])())
    stdlib = set(sys.stdlib_module_names)
    blocked = []

    class DeckyOnly:
        def find_spec(self, name, path=None, target=None):
            if name.split(".")[0] in stdlib and name not in allowed:
                blocked.append(name)
                raise ModuleNotFoundError(f"No module named {name!r} (not bundled in Decky)")
            return None

    sys.meta_path.insert(0, DeckyOnly())

    import asyncio, os, types, logging
    root, tmp = sys.argv[2], sys.argv[3]
    decky = types.ModuleType("decky")
    decky.DECKY_PLUGIN_SETTINGS_DIR = os.path.join(tmp, "settings")
    decky.DECKY_PLUGIN_RUNTIME_DIR = os.path.join(tmp, "data")
    decky.DECKY_PLUGIN_DIR = root
    decky.DECKY_USER_HOME = tmp
    async def emit(*a): pass
    decky.emit = emit
    decky.logger = logging.getLogger("t")
    sys.modules["decky"] = decky
    sys.path.insert(0, root)
    import main
    p = main.Plugin()

    async def flow():
        await p._main()
        assert (await p.save_settings({"host": {"address": "127.0.0.1", "http_port": 9, "wol_enabled": False},
                                       "moonlight": {"custom_path": "/bin/true", "extra_args": "--fps '60' \"a b\""},
                                       "mappings": {"1": {"app_name": "X"}}}))["ok"]
        print("status", (await p.status())["ok"])
        print("prepare", (await p.prepare_launch(1, "X"))["error"])
        from moondeck_apollo import apollo, moonlight, launch
        info = apollo.parse_serverinfo(b"<root><hostname>PC</hostname><VirtualDisplayCapable>true</VirtualDisplayCapable></root>")
        assert info["hostname"] == "PC" and info["is_apollo"], info
        s = (await p.get_settings())
        s["moonlight"]["custom_path"] = "/bin/true"
        argv = moonlight.build_stream_argv(s, "Game's Name")
        assert argv[-3:] == ["--fps", "60", "a b"], argv
        launch.write_request(os.path.join(tmp, "data"), argv, {"app_name": "x"})
        try:
            apollo.ApolloWebClient("127.0.0.1", 9, "u", "p").get_apps()
        except apollo.ApolloError:
            pass
        print("backups", (await p.backup_settings("t"))["ok"], (await p.list_backups())["ok"])
        print("hosts", (await p.import_moonlight_hosts())["ok"])
        await p._uninstall()

    asyncio.run(flow())
    print("blocked", blocked)
''')


class DeckyRuntimeTests(unittest.TestCase):
    def test_backend_uses_only_decky_bundled_modules(self):
        if sys.version_info[:2] != (3, 14):
            self.skipTest("module list matches Decky v3.3.1's Python 3.14; run with python3.14")
        with tempfile.TemporaryDirectory() as tmp:
            script = os.path.join(tmp, "child.py")
            with open(script, "w") as f:
                f.write(CHILD)
            p = subprocess.run([sys.executable, "-I", "-S", script, os.path.join(HERE, "decky_stdlib_modules.txt"),
                                ROOT, tmp], capture_output=True, text=True, timeout=120)
        out = p.stdout + p.stderr
        self.assertEqual(p.returncode, 0, out)
        self.assertIn("prepare HOST_OFFLINE", out)
        # Optional imports the stdlib itself tries and skips on Linux / newer Pythons.
        optional = {"msvcrt", "_winapi", "nt", "winreg", "_overlapped", "_compression"}
        blocked_line = [l for l in out.splitlines() if l.startswith("blocked ")][-1]
        blocked = set(eval(blocked_line[len("blocked "):]))
        self.assertTrue(blocked <= optional, f"backend imports modules missing from Decky: {blocked - optional}")


if __name__ == "__main__":
    unittest.main()
