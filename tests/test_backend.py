"""Unit and integration tests for the Moondeck Apollo backend.

Run from the repository root:  python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "py_modules"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from moondeck_apollo import apollo, launch, mapping, moonlight, moonlight_conf, wol  # noqa: E402
from moondeck_apollo.service import Service  # noqa: E402
from moondeck_apollo.settings import SettingsError, SettingsStore, validate  # noqa: E402
from fakes import FakeApollo, write_fake_moonlight  # noqa: E402


def run(coro):
    return asyncio.run(coro)


class MappingTests(unittest.TestCase):
    def test_normalize(self):
        self.assertEqual(mapping.normalize_title("Cyberpunk 2077™"), "cyberpunk 2077")
        self.assertEqual(mapping.normalize_title("DOOM: Eternal"), mapping.normalize_title("Doom Eternal"))
        self.assertEqual(mapping.normalize_title("FINAL FANTASY VII REMAKE"), "final fantasy 7 remake")
        self.assertEqual(mapping.normalize_title("Pokémon"), "pokemon")
        self.assertEqual(mapping.normalize_title("Ratchet & Clank"), "ratchet and clank")

    def test_steam_appids_in_app(self):
        self.assertEqual(mapping.steam_appids_in_app({"detached": ["steam://rungameid/1091500"]}), [1091500])
        self.assertEqual(mapping.steam_appids_in_app({"cmd": "steam.exe -applaunch 1245620 -foo"}), [1245620])
        self.assertEqual(mapping.steam_appids_in_app({"prep-cmd": [{"do": "start steam://run/70"}]}), [70])
        self.assertEqual(mapping.steam_appids_in_app({"name": "Desktop"}), [])

    def test_resolve_priority(self):
        apps = [
            {"name": "Cyberpunk 2077"},
            {"name": "CP77 HDR", "steam_appids": [1091500]},
            {"name": "Hades II"},
        ]
        # manual wins
        r = mapping.resolve(1091500, "Cyberpunk 2077", {"1091500": {"app_name": "Manual"}}, apps)
        self.assertEqual((r.status, r.app_name), ("manual", "Manual"))
        # exact AppID beats name
        r = mapping.resolve(1091500, "Cyberpunk 2077", {}, apps)
        self.assertEqual((r.status, r.app_name), ("steam_appid", "CP77 HDR"))
        # name match
        r = mapping.resolve(1145350, "Hades II", {}, apps)
        self.assertEqual((r.status, r.app_name), ("name", "Hades II"))
        # unknown -> suggestions, no guess
        r = mapping.resolve(1, "Hades", {}, apps)
        self.assertIsNone(r.app_name)
        self.assertIn("Hades II", r.candidates)

    def test_ambiguous_appid_is_not_guessed(self):
        apps = [{"name": "A", "steam_appids": [10]}, {"name": "B", "steam_appids": [10]}]
        r = mapping.resolve(10, "X", {}, apps)
        self.assertIsNone(r.app_name)
        self.assertEqual(sorted(r.candidates), ["A", "B"])

    def test_hidden_apps_ignored_and_case_insensitive_exists(self):
        apps = [{"name": "Secret", "hidden": True}, {"name": "Cyberpunk 2077"}]
        self.assertIsNone(mapping.resolve(5, "Secret", {}, apps).app_name)
        self.assertTrue(mapping.app_exists("cyberpunk 2077", apps))


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_defaults_and_roundtrip(self):
        store = SettingsStore(self.tmp)
        s = store.load()
        self.assertEqual(s["host"]["http_port"], 47989)
        s = store.update({"host": {"address": "192.168.1.50", "mac": "aa-bb-cc-dd-ee-ff"}})
        self.assertEqual(s["host"]["mac"], "AA:BB:CC:DD:EE:FF")
        self.assertEqual(SettingsStore(self.tmp).load()["host"]["address"], "192.168.1.50")
        self.assertEqual(os.stat(store.path).st_mode & 0o777, 0o600)

    def test_validation(self):
        with self.assertRaises(SettingsError):
            validate({"host": {"mac": "nope"}})
        with self.assertRaises(SettingsError):
            validate({"moonlight": {"resolution": "big"}})
        with self.assertRaises(SettingsError):
            validate({"host": {"address": "1.2.3.4; rm -rf /"}})
        self.assertEqual(validate({"moonlight": {"fps": 60}})["moonlight"]["fps"], "60")

    def test_v1_placement_migrates_to_play_row(self):
        with open(os.path.join(self.tmp, "settings.json"), "w") as f:
            json.dump({"version": 1, "ui": {"placement": "below_play"}, "host": {"address": "10.0.0.2"}}, f)
        s = SettingsStore(self.tmp).load()
        self.assertEqual((s["version"], s["ui"]["placement"], s["host"]["address"]), (2, "play_row", "10.0.0.2"))
        # an explicit choice made on v2 is kept
        store = SettingsStore(self.tmp)
        store.update({"ui": {"placement": "below_play"}})
        self.assertEqual(SettingsStore(self.tmp).load()["ui"]["placement"], "below_play")
        self.assertEqual(validate({})["ui"]["placement"], "play_row")

    def test_corrupt_file_recovers(self):
        with open(os.path.join(self.tmp, "settings.json"), "w") as f:
            f.write("{not json")
        s = SettingsStore(self.tmp).load()
        self.assertEqual(s["host"]["address"], "")
        self.assertTrue(any(n.startswith("settings.json.corrupt") for n in os.listdir(self.tmp)))

    def test_mappings_backup_restore(self):
        store = SettingsStore(self.tmp)
        store.update({"runner": {"shortcut_appid": 111}})
        store.set_mapping(1091500, "Cyberpunk 2077")
        name = store.backup("test")
        store.set_mapping(1091500, None)
        store.update({"runner": {"shortcut_appid": 222}})
        self.assertNotIn("1091500", store.load()["mappings"])
        restored = store.restore(name)
        self.assertEqual(restored["mappings"]["1091500"]["app_name"], "Cyberpunk 2077")
        # the runner id belongs to the current Steam install and is preserved
        self.assertEqual(restored["runner"]["shortcut_appid"], 222)
        with self.assertRaises(SettingsError):
            store.restore("../../etc/passwd.json")


class WolTests(unittest.TestCase):
    def test_magic_packet(self):
        p = wol.build_magic_packet("AA:BB:CC:DD:EE:FF")
        self.assertEqual(len(p), 102)
        self.assertEqual(p[:6], b"\xff" * 6)
        self.assertEqual(p[6:12], bytes.fromhex("AABBCCDDEEFF"))
        with self.assertRaises(ValueError):
            wol.build_magic_packet("xx")

    def test_targets(self):
        t = wol.wake_targets("192.168.1.50", "255.255.255.255")
        self.assertIn(("192.168.1.255", 9), t)
        self.assertIn(("255.255.255.255", 7), t)
        self.assertIn(("192.168.1.50", 9), t)
        self.assertEqual(wol.wake_targets("gaming-pc.local", "")[0], ("255.255.255.255", 9))

    def test_packet_is_sent(self):
        recv = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        recv.bind(("127.0.0.1", 0))
        recv.settimeout(2)
        port = recv.getsockname()[1]
        packet = wol.build_magic_packet("AA:BB:CC:DD:EE:FF")
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.sendto(packet, ("127.0.0.1", port))
        self.assertEqual(recv.recvfrom(200)[0], packet)
        recv.close()

    def test_arp_lookup(self):
        with tempfile.NamedTemporaryFile("w", delete=False) as f:
            f.write("IP address       HW type     Flags       HW address            Mask     Device\n")
            f.write("192.168.1.50     0x1         0x2         aa:bb:cc:dd:ee:ff     *        wlan0\n")
            f.write("192.168.1.60     0x1         0x0         00:00:00:00:00:00     *        wlan0\n")
        try:
            self.assertEqual(wol.lookup_mac_in_arp("192.168.1.50", f.name), "AA:BB:CC:DD:EE:FF")
            self.assertIsNone(wol.lookup_mac_in_arp("192.168.1.60", f.name))
        finally:
            os.remove(f.name)


class MoonlightTests(unittest.TestCase):
    def test_parse_csv(self):
        out = ("Name, ID, HDR Support, App Collection Game, Hidden, Direct Launch, Boxart URL\n"
               '"Desktop",1,false,false,false,false,"file:///a"\n'
               '"Say "Hi", World",5,false,false,true,false,"file:///b"\n'
               "garbage line\n")
        apps = moonlight.parse_list_csv(out)
        self.assertEqual([a["name"] for a in apps], ["Desktop", 'Say "Hi", World'])
        self.assertTrue(apps[1]["hidden"])

    def test_stream_argv(self):
        s = validate({"host": {"address": "192.168.1.50"},
                      "moonlight": {"custom_path": "/opt/ml", "resolution": "1920x1200", "fps": 60,
                                    "hdr": "off", "quit_app_after": True, "extra_args": "--vsync"}})
        argv = moonlight.build_stream_argv(s, "Cyberpunk 2077")
        self.assertEqual(argv[:4], ["/opt/ml", "stream", "192.168.1.50", "Cyberpunk 2077"])
        for flag in ("--resolution", "1920x1200", "--fps", "60", "--no-hdr", "--quit-after", "--vsync"):
            self.assertIn(flag, argv)
        s["host"]["moonlight_name"] = "GAMING-PC"
        self.assertEqual(moonlight.build_stream_argv(s, "X")[2], "GAMING-PC")

    def test_flatpak_argv(self):
        s = validate({"host": {"address": "pc"}})
        argv = moonlight.build_stream_argv(s, "Game")
        self.assertTrue(argv[0].endswith("flatpak"))
        self.assertEqual(argv[1:3], ["run", "com.moonlight_stream.Moonlight"])

    def test_classify(self):
        self.assertEqual(moonlight.classify_output("Computer X has not been paired. ...")[0], "NOT_PAIRED")
        self.assertEqual(moonlight.classify_output("Failed to find application Foo")[0], "APP_MISSING")
        self.assertEqual(moonlight.classify_output("Failed to connect to X")[0], "HOST_UNREACHABLE")


class MoonlightConfTests(unittest.TestCase):
    def test_parse(self):
        text = ("[General]\nlatestsupportedversion-v1=1\n\n[hosts]\n"
                "1\\hostname=GAMING-PC\n1\\localaddress=192.168.1.50\n1\\manualaddress=\n"
                "1\\uuid=ABC\n1\\mac=@ByteArray(\\xaa\\xbb\\xcc\\xdd\\xee\\xff)\n"
                "2\\hostname=LAPTOP\n2\\manualaddress=10.0.0.9\n2\\mac=@ByteArray()\nsize=2\n")
        hosts = moonlight_conf.parse_hosts(text)
        self.assertEqual(hosts[0]["name"], "GAMING-PC")
        self.assertEqual(hosts[0]["address"], "192.168.1.50")
        self.assertEqual(hosts[0]["mac"], "AA:BB:CC:DD:EE:FF")
        self.assertEqual(hosts[1]["address"], "10.0.0.9")
        self.assertEqual(hosts[1]["mac"], "")

    def test_bytearray_mixed_escapes(self):
        # printable bytes are written literally by QSettings (0x41 = "A")
        self.assertEqual(moonlight_conf.decode_qbytearray("@ByteArray(\\x1A\\x2\\0\\xf0\\x9z)"),
                         bytes([0x1a, 0x02, 0x00, 0xf0, 0x09]) + b"z")


class ApolloTests(unittest.TestCase):
    def test_serverinfo_and_offline(self):
        with FakeApollo() as fake:
            info = apollo.probe_serverinfo("127.0.0.1", fake.http_port)
            self.assertTrue(info["online"])
            self.assertEqual(info["hostname"], "GAMING-PC")
            self.assertTrue(info["is_apollo"])
            self.assertEqual(info["mac"], "")  # zeroed for unpaired clients
        closed = socket.socket()
        closed.bind(("127.0.0.1", 0))
        port = closed.getsockname()[1]
        closed.close()
        info = apollo.probe_serverinfo("127.0.0.1", port, timeout=1)
        self.assertFalse(info["online"])

    def test_web_api_cookie_login_and_create(self):
        with FakeApollo() as fake:
            c = apollo.ApolloWebClient("127.0.0.1", fake.https_port, "admin", "secret")
            apps = c.get_apps()
            by_name = {a["name"]: a for a in apps}
            self.assertEqual(by_name["Cyberpunk 2077"]["steam_appids"], [1091500])
            self.assertEqual(by_name["Elden Ring (PC)"]["steam_appids"], [1245620])
            self.assertEqual(len(c.seen_sha256), 64)
            self.assertEqual(c.add_steam_app("Hades II", 1145350), "created")
            self.assertEqual(fake.apps[-1]["detached"], ["steam://rungameid/1145350"])
            self.assertIs(fake.apps[-1]["virtual-display"], True)
            # an existing app without the virtual display option is repaired in place
            n = len(fake.apps)
            self.assertEqual(c.ensure_steam_app("cyberpunk 2077", 1091500), "updated")
            cp = [a for a in fake.apps if a["name"] == "Cyberpunk 2077"]
            self.assertEqual(len(fake.apps), n)
            self.assertEqual(len(cp), 1)
            self.assertIs(cp[0]["virtual-display"], True)
            self.assertEqual(cp[0]["uuid"], "u3")
            self.assertEqual(cp[0]["detached"], ["steam://rungameid/1091500"])  # rest untouched
            self.assertEqual(c.ensure_steam_app("Cyberpunk 2077", 1091500), "exists")
            # option off: nothing is changed on existing apps, new apps get false
            self.assertEqual(c.ensure_steam_app("Desktop", 0, virtual_display=False), "exists")
            self.assertEqual(c.ensure_steam_app("Doom", 2280, virtual_display=False), "created")
            self.assertIs(fake.apps[-1]["virtual-display"], False)
            # pinning: wrong fingerprint refuses before sending credentials
            bad = apollo.ApolloWebClient("127.0.0.1", fake.https_port, "admin", "secret", pinned_sha256="00" * 32)
            with self.assertRaises(apollo.ApolloError) as cm:
                bad.get_apps()
            self.assertEqual(cm.exception.code, "CERT_MISMATCH")
            wrong = apollo.ApolloWebClient("127.0.0.1", fake.https_port, "admin", "nope")
            with self.assertRaises(apollo.ApolloError) as cm:
                wrong.get_apps()
            self.assertEqual(cm.exception.code, "WEB_LOGIN_FAILED")

    def test_sunshine_basic_auth_fallback(self):
        with FakeApollo(basic_only=True) as fake:
            c = apollo.ApolloWebClient("127.0.0.1", fake.https_port, "admin", "secret")
            self.assertTrue(c.get_apps())
            self.assertTrue(c.use_basic)


class RunnerScriptTests(unittest.TestCase):
    """Executes bin/moonlight-runner.sh exactly as Steam would."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.runner = launch.install_runner(os.path.join(ROOT, "bin", "moonlight-runner.sh"), self.tmp)
        self.ml = write_fake_moonlight(self.tmp)
        self.env = dict(os.environ, FAKE_ML_LOG=os.path.join(self.tmp, "calls.log"), LD_LIBRARY_PATH="/bogus")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_successful_session(self):
        launch.write_request(self.tmp, [self.ml, "stream", "192.168.1.50", "Cyberpunk 2077"],
                             {"app_name": "Cyberpunk 2077", "steam_appid": 1091500})
        p = subprocess.run([self.runner], env=self.env, capture_output=True, timeout=20)
        self.assertEqual(p.returncode, 0)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, launch.REQUEST_FILE)), "request must be one-shot")
        res = launch.read_result(self.tmp)
        self.assertEqual(res["exit_code"], 0)
        self.assertEqual(res["app_name"], "Cyberpunk 2077")
        self.assertIn("streaming Cyberpunk 2077 from 192.168.1.50", res["log_tail"])

    def test_quoting_is_safe(self):
        evil = "Game'; touch PWNED; echo '$(id)`x`"
        launch.write_request(self.tmp, [self.ml, "stream", "pc", evil], {"app_name": evil})
        subprocess.run([self.runner], env=self.env, cwd=self.tmp, capture_output=True, timeout=20)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "PWNED")))
        with open(self.env["FAKE_ML_LOG"]) as f:
            self.assertEqual(f.read().strip(), f"stream pc {evil}")

    def test_failure_is_reported(self):
        env = dict(self.env, FAKE_ML_MODE="fail")
        launch.write_request(self.tmp, [self.ml, "stream", "pc", "Nope"], {"app_name": "Nope"})
        p = subprocess.run([self.runner], env=env, capture_output=True, timeout=20)
        self.assertEqual(p.returncode, 1)
        svc = Service(os.path.join(self.tmp, "s"), self.tmp, ROOT, self.tmp)
        sess = run(svc.last_session())["session"]
        self.assertEqual(sess["error"], "APP_MISSING")

    def test_stale_request_is_ignored(self):
        launch.write_request(self.tmp, [self.ml, "stream", "pc", "Old"], {})
        req = os.path.join(self.tmp, launch.REQUEST_FILE)
        with open(req) as f:
            text = f.read()
        old = int(time.time()) - 3600
        with open(req, "w") as f:
            f.write("\n".join(f"ML_CREATED={old}" if l.startswith("ML_CREATED=") else l for l in text.splitlines()))
        env = dict(self.env, PATH="/usr/bin:/bin")  # no flatpak here -> exit 1
        subprocess.run([self.runner], env=env, capture_output=True, timeout=20)
        self.assertFalse(os.path.exists(self.env["FAKE_ML_LOG"]), "stale request must not stream")

    def test_sigterm_is_forwarded(self):
        env = dict(self.env, FAKE_ML_SLEEP="30")
        launch.write_request(self.tmp, [self.ml, "stream", "pc", "Game"], {"app_name": "Game"})
        p = subprocess.Popen([self.runner], env=env)
        time.sleep(1.0)
        p.terminate()
        p.wait(timeout=10)
        res = launch.read_result(self.tmp)
        self.assertIsNotNone(res)
        self.assertNotEqual(res["exit_code"], 0)


class ServiceTests(unittest.TestCase):
    """End-to-end backend flow against a fake Apollo PC and fake Moonlight."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.ml = write_fake_moonlight(self.tmp)
        os.environ["FAKE_ML_LOG"] = os.path.join(self.tmp, "calls.log")
        os.environ.pop("FAKE_ML_MODE", None)
        self.events = []

        async def emit(event, payload):
            self.events.append((event, payload))

        self.svc = Service(os.path.join(self.tmp, "settings"), os.path.join(self.tmp, "runtime"),
                           ROOT, self.tmp, emit=emit)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def configure(self, fake, **web):
        patch = {"host": {"address": "127.0.0.1", "http_port": fake.http_port},
                 "moonlight": {"custom_path": self.ml}}
        if web:
            patch["apollo_web"] = dict(enabled=True, port=fake.https_port, **web)
        r = run(self.svc.save_settings(patch))
        self.assertTrue(r["ok"], r)
        return r

    def test_password_never_returned_and_kept(self):
        with FakeApollo() as fake:
            r = self.configure(fake, username="admin", password="secret")
            self.assertEqual(r["settings"]["apollo_web"]["password"], "")
            self.assertTrue(r["settings"]["apollo_web"]["password_set"])
            # saving again from the UI with an empty password keeps the stored one
            run(self.svc.save_settings({"apollo_web": {"username": "admin", "password": ""}}))
            self.assertEqual(self.svc.store.load()["apollo_web"]["password"], "secret")

    def test_launch_with_moonlight_list_and_name_match(self):
        with FakeApollo() as fake:
            self.configure(fake)
            r = run(self.svc.prepare_launch(1091500, "Cyberpunk 2077™"))
            self.assertTrue(r["ok"], r)
            self.assertEqual(r["app_name"], "Cyberpunk 2077")
            self.assertEqual(r["resolution"], "name")
            req = os.path.join(self.tmp, "runtime", launch.REQUEST_FILE)
            self.assertTrue(os.path.exists(req))
            self.assertTrue(os.access(os.path.join(self.tmp, "runtime", launch.RUNNER_NAME), os.X_OK))
            stages = [p["stage"] for e, p in self.events]
            self.assertIn("ready", stages)

    def test_unmapped_then_manual_mapping(self):
        with FakeApollo() as fake:
            self.configure(fake)
            # "Hades 2" == "Hades II" after roman-numeral normalisation
            self.assertEqual(run(self.svc.prepare_launch(1145350, "Hades 2"))["app_name"], "Hades II")
            r = run(self.svc.prepare_launch(1145350, "Hades"))
            self.assertEqual(r["error"], "UNMAPPED")
            self.assertIn("Hades II", r["candidates"])
            self.assertNotIn("Hidden Thing", r["apps"])
            run(self.svc.set_mapping(1145350, "Hades II", "Hades"))
            r = run(self.svc.prepare_launch(1145350, "Hades"))
            self.assertTrue(r["ok"], r)
            self.assertEqual(r["resolution"], "manual")

    def test_mapping_to_removed_app_is_reported(self):
        with FakeApollo() as fake:
            self.configure(fake)
            run(self.svc.set_mapping(42, "Deleted Game"))
            r = run(self.svc.prepare_launch(42, "Deleted Game"))
            self.assertEqual(r["error"], "APP_MISSING")
            self.assertIn("Cyberpunk 2077", r["apps"])

    def test_exact_appid_via_web_api_and_cert_pinning(self):
        with FakeApollo() as fake:
            self.configure(fake, username="admin", password="secret")
            fake.apps[2]["name"] = "CP2077 (HDR, virtual display)"
            r = run(self.svc.refresh_apps())
            self.assertTrue(r["ok"], r)
            self.assertEqual(r["source"], "apollo_web")
            self.assertEqual(len(self.svc.store.load()["apollo_web"]["cert_sha256"]), 64)
            r = run(self.svc.prepare_launch(1091500, "Cyberpunk 2077"))
            self.assertEqual((r["ok"], r["app_name"], r["resolution"]),
                             (True, "CP2077 (HDR, virtual display)", "steam_appid"))

    def test_create_missing_apollo_app(self):
        with FakeApollo() as fake:
            self.configure(fake, username="admin", password="secret")
            r = run(self.svc.prepare_launch(1145350, "Hades II Deluxe"))
            self.assertEqual(r["error"], "UNMAPPED")
            self.assertTrue(r["can_create"])
            r = run(self.svc.create_apollo_app(1145350, "Hades II Deluxe"))
            self.assertTrue(r["ok"], r)
            self.assertEqual(r["result"], "created")
            self.assertEqual(fake.apps[-1]["name"], "Hades II Deluxe")
            self.assertIs(fake.apps[-1]["virtual-display"], True)
            r = run(self.svc.prepare_launch(1145350, "Hades II Deluxe"))
            self.assertTrue(r["ok"], r)

    def test_unpaired_moonlight(self):
        with FakeApollo() as fake:
            self.configure(fake)
            os.environ["FAKE_ML_MODE"] = "unpaired"
            try:
                r = run(self.svc.refresh_apps())
            finally:
                os.environ.pop("FAKE_ML_MODE")
            self.assertEqual(r["error"], "NOT_PAIRED")

    def test_offline_without_wol(self):
        closed = socket.socket()
        closed.bind(("127.0.0.1", 0))
        port = closed.getsockname()[1]
        closed.close()
        run(self.svc.save_settings({"host": {"address": "127.0.0.1", "http_port": port},
                                    "moonlight": {"custom_path": self.ml},
                                    "mappings": {"1091500": {"app_name": "Cyberpunk 2077"}}}))
        r = run(self.svc.prepare_launch(1091500, "Cyberpunk 2077"))
        self.assertEqual(r["error"], "HOST_OFFLINE")
        self.assertFalse(r["can_wake"])

    def test_offline_with_wol_times_out(self):
        closed = socket.socket()
        closed.bind(("127.0.0.1", 0))
        port = closed.getsockname()[1]
        closed.close()
        run(self.svc.save_settings({"host": {"address": "127.0.0.1", "http_port": port, "mac": "AA:BB:CC:DD:EE:FF",
                                             "wake_timeout": 5, "wol_broadcast": "127.255.255.255"},
                                    "moonlight": {"custom_path": self.ml},
                                    "mappings": {"1": {"app_name": "X"}}}))
        t0 = time.monotonic()
        r = run(self.svc.prepare_launch(1, "X"))
        self.assertEqual(r["error"], "HOST_OFFLINE")
        self.assertTrue(r["can_wake"])
        self.assertGreaterEqual(time.monotonic() - t0, 4)
        self.assertIn("wake", [p["stage"] for e, p in self.events])

    def test_no_host_and_missing_moonlight(self):
        self.assertEqual(run(self.svc.prepare_launch(1, "X"))["error"], "NO_HOST")
        run(self.svc.save_settings({"host": {"address": "127.0.0.1"},
                                    "moonlight": {"custom_path": "/nonexistent/moonlight"}}))
        self.assertEqual(run(self.svc.prepare_launch(1, "X"))["error"], "MOONLIGHT_MISSING")

    def test_uninstall_cleanup_keeps_backup(self):
        run(self.svc.save_settings({"host": {"address": "10.0.0.2"}}))
        self.svc.install_runner()
        r = run(self.svc.uninstall_cleanup(True))
        self.assertTrue(r["ok"])
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "runtime")))
        backups = os.listdir(os.path.join(self.tmp, "settings", "backups"))
        self.assertTrue(any("pre-uninstall" in b for b in backups))
        with open(os.path.join(self.tmp, "settings", "backups", backups[0])) as f:
            self.assertEqual(json.load(f)["host"]["address"], "10.0.0.2")


if __name__ == "__main__":
    unittest.main()
