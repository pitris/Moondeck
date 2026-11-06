"""Environment for running host binaries (flatpak) from the Decky backend.

Decky Loader is a PyInstaller bundle started by a systemd *system* service.
Child processes therefore inherit PyInstaller's ``LD_LIBRARY_PATH`` (which
breaks system binaries) and lack the user session variables flatpak expects.
"""

from __future__ import annotations

import os
from typing import Dict, Optional


def host_env(extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    env = dict(os.environ)
    # PyInstaller keeps the original value in *_ORIG.
    orig = env.pop("LD_LIBRARY_PATH_ORIG", None)
    if orig:
        env["LD_LIBRARY_PATH"] = orig
    else:
        env.pop("LD_LIBRARY_PATH", None)
    env.pop("LD_PRELOAD", None)
    env.pop("PYTHONHOME", None)
    env.pop("PYTHONPATH", None)

    uid = os.getuid()
    runtime_dir = env.get("XDG_RUNTIME_DIR") or f"/run/user/{uid}"
    if os.path.isdir(runtime_dir):
        env["XDG_RUNTIME_DIR"] = runtime_dir
        bus = os.path.join(runtime_dir, "bus")
        if "DBUS_SESSION_BUS_ADDRESS" not in env and os.path.exists(bus):
            env["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={bus}"
    path = env.get("PATH", "")
    for p in ("/usr/local/bin", "/usr/bin", "/bin"):
        if p not in path.split(":"):
            path = f"{path}:{p}" if path else p
    env["PATH"] = path
    if extra:
        env.update(extra)
    return env
