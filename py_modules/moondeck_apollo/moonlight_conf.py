"""Read hosts that Moonlight already knows (so the user does not retype them).

Moonlight-qt stores paired hosts with QSettings in INI format, e.g. (Flatpak):
``~/.var/app/com.moonlight_stream.Moonlight/config/Moonlight Game Streaming Project/Moonlight.conf``

    [hosts]
    1\\hostname=GAMING-PC
    1\\localaddress=192.168.1.50
    1\\manualaddress=
    1\\uuid=...
    1\\mac=@ByteArray(\\xaa\\xbb...)
    size=1

This module is read-only: we never write Moonlight's configuration.
"""

from __future__ import annotations

import os
import re
from typing import Dict, List, Optional

CONF_CANDIDATES = (
    ".var/app/com.moonlight_stream.Moonlight/config/Moonlight Game Streaming Project/Moonlight.conf",
    ".config/Moonlight Game Streaming Project/Moonlight.conf",
)


def find_conf(home: str) -> Optional[str]:
    for rel in CONF_CANDIDATES:
        p = os.path.join(home, rel)
        if os.path.isfile(p):
            return p
    return None


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        value = value[1:-1]
    return value


def decode_qbytearray(value: str) -> bytes:
    """Best-effort decode of QSettings' ``@ByteArray(...)`` INI escaping."""
    m = re.match(r'^"?@ByteArray\((.*)\)"?$', value.strip(), re.DOTALL)
    if not m:
        return b""
    s = m.group(1)
    out = bytearray()
    i = 0
    simple = {"a": 7, "b": 8, "f": 12, "n": 10, "r": 13, "t": 9, "v": 11, "0": 0,
              "\\": 92, '"': 34, "'": 39, "?": 63}
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            nxt = s[i + 1]
            if nxt == "x":
                j = i + 2
                while j < len(s) and s[j] in "0123456789abcdefABCDEF" and j - (i + 2) < 2:
                    j += 1
                if j > i + 2:
                    out.append(int(s[i + 2:j], 16))
                i = j
                continue
            if nxt in simple:
                out.append(simple[nxt])
                i += 2
                continue
            out.append(ord(nxt) & 0xFF)
            i += 2
            continue
        out.extend(c.encode("latin-1", errors="replace"))
        i += 1
    return bytes(out)


def parse_hosts(text: str) -> List[Dict[str, str]]:
    section = ""
    entries: Dict[str, Dict[str, str]] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith(";") or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1]
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().replace("/", "\\")
        if section != "General" and section:
            key = section + "\\" + key
        parts = key.split("\\")
        if len(parts) != 3 or parts[0] != "hosts" or not parts[1].isdigit():
            continue
        entries.setdefault(parts[1], {})[parts[2]] = value
    hosts = []
    for idx in sorted(entries, key=int):
        e = entries[idx]
        mac_bytes = decode_qbytearray(e.get("mac", ""))
        mac = ":".join(f"{b:02X}" for b in mac_bytes) if len(mac_bytes) == 6 else ""
        address = _unquote(e.get("manualaddress", "")) or _unquote(e.get("localaddress", "")) \
            or _unquote(e.get("remoteaddress", ""))
        hosts.append({
            "name": _unquote(e.get("hostname", "")),
            "uuid": _unquote(e.get("uuid", "")),
            "address": address,
            "local_address": _unquote(e.get("localaddress", "")),
            "mac": mac,
        })
    return [h for h in hosts if h["name"] or h["address"]]


def read_hosts(home: str) -> List[Dict[str, str]]:
    path = find_conf(home)
    if not path:
        return []
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return parse_hosts(f.read())
