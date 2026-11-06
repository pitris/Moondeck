"""Moonlight-qt command line integration.

Relevant moonlight-qt CLI behaviour (verified against app/cli/*.cpp):

* ``moonlight stream <host> "<app>"`` connects to an already-paired host and
  starts the app directly - no app grid. App names are matched
  case-insensitively. When the session ends the CLI segue calls ``Qt.quit()``,
  so the process exits and Steam returns to Gaming Mode.
* ``moonlight list <host> --csv`` prints the host's app list using Moonlight's
  existing pairing. It still creates a QGuiApplication, so from a headless
  context we run it with ``QT_QPA_PLATFORM=offscreen``.
* ``--quit-after`` quits the app *on the host* after the session.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
from typing import Any, Dict, List, Optional, Tuple

from .procenv import host_env
from .shellutil import split as shell_split

# "Name",ID,HDR,AppCollector,Hidden,DirectLaunch,"BoxartURL"
_CSV_ROW_RE = re.compile(
    r'^"(?P<name>.*)",(?P<id>-?\d+),(?P<hdr>true|false),(?P<collector>true|false),'
    r'(?P<hidden>true|false),(?P<direct>true|false),"(?P<boxart>.*)"\s*$')


class MoonlightError(Exception):
    def __init__(self, code: str, message: str, output: str = ""):
        super().__init__(message)
        self.code = code
        self.message = message
        self.output = output


def base_command(settings: Dict[str, Any]) -> List[str]:
    ml = settings["moonlight"]
    if ml.get("custom_path"):
        return [ml["custom_path"]]
    flatpak = shutil.which("flatpak", path=host_env()["PATH"]) or "/usr/bin/flatpak"
    return [flatpak, "run", ml["flatpak_id"]]


def host_identifier(settings: Dict[str, Any]) -> str:
    host = settings["host"]
    return host.get("moonlight_name") or host.get("address") or ""


def build_stream_argv(settings: Dict[str, Any], app_name: str) -> List[str]:
    ml = settings["moonlight"]
    argv = base_command(settings) + ["stream", host_identifier(settings), app_name]
    if ml.get("resolution"):
        argv += ["--resolution", ml["resolution"]]
    if ml.get("fps"):
        argv += ["--fps", str(ml["fps"])]
    if ml.get("bitrate_kbps"):
        argv += ["--bitrate", str(ml["bitrate_kbps"])]
    if ml.get("display_mode"):
        argv += ["--display-mode", ml["display_mode"]]
    if ml.get("video_codec"):
        argv += ["--video-codec", ml["video_codec"]]
    for key, flag in (("hdr", "hdr"), ("performance_overlay", "performance-overlay")):
        if ml.get(key) == "on":
            argv.append(f"--{flag}")
        elif ml.get(key) == "off":
            argv.append(f"--no-{flag}")
    if ml.get("quit_app_after"):
        argv.append("--quit-after")
    if ml.get("extra_args"):
        argv += shell_split(ml["extra_args"])
    return argv


def parse_list_csv(output: str) -> List[Dict[str, Any]]:
    apps: List[Dict[str, Any]] = []
    for line in output.splitlines():
        m = _CSV_ROW_RE.match(line.strip())
        if not m:
            continue
        apps.append({
            "name": m.group("name"),
            "id": int(m.group("id")),
            "hidden": m.group("hidden") == "true",
            "steam_appids": [],
        })
    return apps


def classify_output(output: str) -> Tuple[str, str]:
    """Map Moonlight CLI error text to (code, human message)."""
    text = output or ""
    if "has not been paired" in text:
        return "NOT_PAIRED", "Moonlight is not paired with this PC. Open Moonlight once in Desktop or Game Mode and pair with Apollo."
    if "Failed to connect to" in text:
        return "HOST_UNREACHABLE", "Moonlight could not reach the PC."
    if "Failed to find application" in text:
        return "APP_MISSING", "Apollo has no application with that name."
    if "not installed" in text.lower() or "No such file" in text:
        return "MOONLIGHT_MISSING", "Moonlight is not installed."
    return "MOONLIGHT_ERROR", text.strip().splitlines()[-1] if text.strip() else "Moonlight failed."


async def _run(argv: List[str], timeout: float, extra_env: Optional[Dict[str, str]] = None) -> Tuple[int, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=host_env(extra_env),
        )
    except FileNotFoundError as e:
        raise MoonlightError("MOONLIGHT_MISSING", f"Cannot run {argv[0]}: {e}")
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        await proc.wait()
        raise MoonlightError("TIMEOUT", f"{os.path.basename(argv[0])} did not finish within {int(timeout)}s")
    return proc.returncode or 0, out.decode(errors="replace")


async def detect(settings: Dict[str, Any]) -> Dict[str, Any]:
    ml = settings["moonlight"]
    if ml.get("custom_path"):
        ok = os.path.isfile(ml["custom_path"]) and os.access(ml["custom_path"], os.X_OK)
        return {"installed": ok, "method": "custom", "detail": ml["custom_path"]}
    flatpak = shutil.which("flatpak", path=host_env()["PATH"])
    if not flatpak:
        return {"installed": False, "method": "flatpak", "detail": "flatpak not found"}
    try:
        code, out = await _run([flatpak, "info", "--show-ref", ml["flatpak_id"]], timeout=15)
    except MoonlightError as e:
        return {"installed": False, "method": "flatpak", "detail": e.message}
    return {"installed": code == 0, "method": "flatpak", "detail": out.strip()}


async def list_apps(settings: Dict[str, Any], timeout: float = 45) -> List[Dict[str, Any]]:
    host = host_identifier(settings)
    if not host:
        raise MoonlightError("NO_HOST", "No host configured")
    argv = base_command(settings) + ["list", host, "--csv"]
    code, out = await _run(argv, timeout, {"QT_QPA_PLATFORM": "offscreen"})
    apps = parse_list_csv(out)
    if code != 0 or (not apps and "Name, ID" not in out):
        err_code, message = classify_output(out)
        raise MoonlightError(err_code, message, out[-2000:])
    return apps
