"""Persistent settings with schema defaults, validation, atomic writes and backups."""

from __future__ import annotations

import copy
import json
import os
import re
import time
from typing import Any, Dict, List, Optional

SCHEMA_VERSION = 2

DEFAULTS: Dict[str, Any] = {
    "version": SCHEMA_VERSION,
    "host": {
        # IP address or DNS name of the Windows PC running Apollo.
        "address": "",
        # Optional: the name Moonlight knows the host by. Empty = use address.
        "moonlight_name": "",
        # GameStream HTTP port (Apollo default 47989).
        "http_port": 47989,
        "mac": "",
        "wol_enabled": True,
        "wol_broadcast": "255.255.255.255",
        # Seconds to wait for the PC to come online after sending Wake-on-LAN.
        "wake_timeout": 90,
    },
    "apollo_web": {
        # Optional Apollo/Sunshine web UI access: enables exact Steam AppID
        # matching and creating missing Apollo apps from the handheld.
        "enabled": False,
        "port": 47990,
        "username": "",
        "password": "",
        # SHA-256 fingerprint of the web UI certificate, pinned on first use.
        "cert_sha256": "",
        # Apps created from the handheld get Apollo's "Always create Virtual
        # Display" option (stream on a virtual screen sized for the Legion).
        "new_app_virtual_display": True,
    },
    "moonlight": {
        "flatpak_id": "com.moonlight_stream.Moonlight",
        # Optional absolute path to a non-Flatpak Moonlight binary/AppImage.
        "custom_path": "",
        # Empty string = use whatever is saved in Moonlight's own settings.
        "resolution": "",
        "fps": "",
        "bitrate_kbps": "",
        "display_mode": "",
        "video_codec": "",
        "hdr": "",
        "performance_overlay": "",
        # Quit the game on the PC when the stream session ends.
        "quit_app_after": False,
        # When a stream ends, also end Apollo's session so nothing is left
        # "running" on the host (the game itself keeps running on the PC).
        "end_session_on_exit": True,
        "extra_args": "",
    },
    "power": {
        # When the Legion wakes and a Moonlight stream was running, send
        # Wake-on-LAN so the stream can resume.
        "wake_on_resume": True,
        # When the Legion goes to sleep during a Moonlight stream, put the PC to
        # sleep too (needs Apollo web UI access; uses the "Moondeck: Sleep PC" app).
        "sleep_pc_on_suspend": False,
        "sleep_app_uuid": "",
    },
    "ui": {
        # "play_row" (next to Steam's Play button), "below_play" or "hero"
        "placement": "play_row",
        "label": "Moonlight",
        "rename_runner_per_launch": True,
        "show_on_non_steam": True,
    },
    "runner": {
        "shortcut_appid": 0,
    },
    # steam appid (string) -> {"app_name": str, "source": "manual"|"created"}
    "mappings": {},
    "apps_cache": {
        "fetched_at": 0,
        "source": "",
        "apps": [],
    },
}

_MAC_RE = re.compile(r"^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$", re.IGNORECASE)
_RES_RE = re.compile(r"^\d{3,5}x\d{3,5}$")
_HOST_RE = re.compile(r"^[A-Za-z0-9._:\-\[\]%]+$")

DISPLAY_MODES = ("", "fullscreen", "windowed", "borderless")
VIDEO_CODECS = ("", "auto", "H.264", "HEVC", "AV1")
TRISTATE = ("", "on", "off")
PLACEMENTS = ("play_row", "below_play", "hero")


class SettingsError(ValueError):
    pass


def deep_merge(base: Dict[str, Any], patch: Dict[str, Any]) -> Dict[str, Any]:
    """Return a new dict with ``patch`` merged into ``base`` recursively.

    ``mappings`` and ``apps_cache.apps`` are replaced wholesale when present in
    the patch so callers can delete entries.
    """
    out = copy.deepcopy(base)
    for key, value in patch.items():
        if key in ("mappings", "apps") or not isinstance(value, dict) or not isinstance(out.get(key), dict):
            out[key] = copy.deepcopy(value)
        else:
            out[key] = deep_merge(out[key], value)
    return out


def _fill_defaults(defaults: Dict[str, Any], data: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for key, dval in defaults.items():
        if key not in data:
            out[key] = copy.deepcopy(dval)
        elif isinstance(dval, dict) and key not in ("mappings",) and isinstance(data[key], dict):
            out[key] = _fill_defaults(dval, data[key])
        else:
            out[key] = data[key]
    # Preserve unknown keys inside mappings only; drop unknown top-level keys.
    return out


def normalize_mac(mac: str) -> str:
    mac = (mac or "").strip().replace("-", ":").upper()
    if len(mac) == 12 and ":" not in mac:
        mac = ":".join(mac[i:i + 2] for i in range(0, 12, 2))
    return mac


def validate(data: Dict[str, Any]) -> Dict[str, Any]:
    """Validate and normalise a full settings document. Raises SettingsError."""
    d = _fill_defaults(DEFAULTS, data)
    # v1 -> v2: the old default placement did not show on current Steam
    # clients; move users who never changed it to the new play-row default.
    if int(data.get("version") or 1) < 2 and d["ui"].get("placement") == "below_play":
        d["ui"]["placement"] = "play_row"
    d["version"] = SCHEMA_VERSION

    host = d["host"]
    host["address"] = str(host["address"]).strip()
    if host["address"] and not _HOST_RE.match(host["address"]):
        raise SettingsError("Host address contains invalid characters")
    host["moonlight_name"] = str(host["moonlight_name"]).strip()
    host["mac"] = normalize_mac(str(host["mac"]))
    if host["mac"] and not _MAC_RE.match(host["mac"]):
        raise SettingsError("MAC address must look like AA:BB:CC:DD:EE:FF")
    host["http_port"] = _int_in(host["http_port"], 1, 65535, "HTTP port")
    host["wake_timeout"] = _int_in(host["wake_timeout"], 5, 600, "Wake timeout")
    host["wol_enabled"] = bool(host["wol_enabled"])
    host["wol_broadcast"] = str(host["wol_broadcast"]).strip() or "255.255.255.255"

    web = d["apollo_web"]
    web["enabled"] = bool(web["enabled"])
    web["port"] = _int_in(web["port"], 1, 65535, "Web UI port")
    web["username"] = str(web["username"])
    web["password"] = str(web["password"])
    web["cert_sha256"] = str(web["cert_sha256"]).strip().lower()
    web["new_app_virtual_display"] = bool(web["new_app_virtual_display"])

    ml = d["moonlight"]
    ml["flatpak_id"] = str(ml["flatpak_id"]).strip() or DEFAULTS["moonlight"]["flatpak_id"]
    ml["custom_path"] = str(ml["custom_path"]).strip()
    ml["resolution"] = str(ml["resolution"]).strip().lower()
    if ml["resolution"] and not _RES_RE.match(ml["resolution"]):
        raise SettingsError("Resolution must look like 1920x1200")
    ml["fps"] = _optional_int(ml["fps"], 10, 480, "FPS")
    ml["bitrate_kbps"] = _optional_int(ml["bitrate_kbps"], 500, 500000, "Bitrate")
    _choice(ml, "display_mode", DISPLAY_MODES)
    _choice(ml, "video_codec", VIDEO_CODECS)
    _choice(ml, "hdr", TRISTATE)
    _choice(ml, "performance_overlay", TRISTATE)
    ml["quit_app_after"] = bool(ml["quit_app_after"])
    ml["end_session_on_exit"] = bool(ml["end_session_on_exit"])
    ml["extra_args"] = str(ml["extra_args"]).strip()

    pw = d["power"]
    pw["wake_on_resume"] = bool(pw["wake_on_resume"])
    pw["sleep_pc_on_suspend"] = bool(pw["sleep_pc_on_suspend"])
    pw["sleep_app_uuid"] = str(pw.get("sleep_app_uuid") or "")

    ui = d["ui"]
    _choice(ui, "placement", PLACEMENTS)
    ui["label"] = (str(ui["label"]).strip() or "Moonlight")[:24]
    ui["rename_runner_per_launch"] = bool(ui["rename_runner_per_launch"])
    ui["show_on_non_steam"] = bool(ui["show_on_non_steam"])

    d["runner"]["shortcut_appid"] = int(d["runner"].get("shortcut_appid") or 0)

    mappings: Dict[str, Any] = {}
    for key, value in (d["mappings"] or {}).items():
        if not str(key).isdigit():
            continue
        if isinstance(value, str):
            value = {"app_name": value, "source": "manual"}
        if not isinstance(value, dict) or not str(value.get("app_name", "")).strip():
            continue
        mappings[str(key)] = {
            "app_name": str(value["app_name"]).strip(),
            "source": str(value.get("source") or "manual"),
            "steam_name": str(value.get("steam_name") or ""),
        }
    d["mappings"] = mappings

    cache = d["apps_cache"]
    cache["apps"] = [a for a in (cache.get("apps") or []) if isinstance(a, dict) and a.get("name")]
    cache["fetched_at"] = float(cache.get("fetched_at") or 0)
    cache["source"] = str(cache.get("source") or "")
    return d


def _int_in(value: Any, lo: int, hi: int, label: str) -> int:
    try:
        iv = int(value)
    except (TypeError, ValueError):
        raise SettingsError(f"{label} must be a number")
    if not lo <= iv <= hi:
        raise SettingsError(f"{label} must be between {lo} and {hi}")
    return iv


def _optional_int(value: Any, lo: int, hi: int, label: str) -> str:
    if value in ("", None):
        return ""
    return str(_int_in(value, lo, hi, label))


def _choice(section: Dict[str, Any], key: str, choices: tuple) -> None:
    value = str(section.get(key) or "")
    if value not in choices:
        raise SettingsError(f"Invalid value for {key}: {value!r}")
    section[key] = value


class SettingsStore:
    """JSON settings file with atomic writes and timestamped backups."""

    FILE_NAME = "settings.json"

    def __init__(self, settings_dir: str):
        self.dir = settings_dir
        self.path = os.path.join(settings_dir, self.FILE_NAME)
        self.backup_dir = os.path.join(settings_dir, "backups")
        os.makedirs(self.backup_dir, exist_ok=True)
        self._data: Optional[Dict[str, Any]] = None

    # -- basic IO -------------------------------------------------------
    def load(self) -> Dict[str, Any]:
        if self._data is not None:
            return copy.deepcopy(self._data)
        raw: Dict[str, Any] = {}
        if os.path.exists(self.path):
            try:
                with open(self.path, "r", encoding="utf-8") as f:
                    raw = json.load(f)
            except (OSError, ValueError):
                # Corrupt file: keep it for inspection and start from defaults.
                corrupt = self.path + f".corrupt-{int(time.time())}"
                try:
                    os.replace(self.path, corrupt)
                except OSError:
                    pass
                raw = {}
        try:
            self._data = validate(raw)
        except SettingsError:
            self._data = validate({})
        return copy.deepcopy(self._data)

    def save(self, data: Dict[str, Any]) -> Dict[str, Any]:
        valid = validate(data)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(valid, f, indent=2, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        try:
            os.chmod(tmp, 0o600)  # may contain the Apollo web UI password
        except OSError:
            pass
        os.replace(tmp, self.path)
        self._data = valid
        return copy.deepcopy(valid)

    def update(self, patch: Dict[str, Any]) -> Dict[str, Any]:
        return self.save(deep_merge(self.load(), patch))

    # -- mappings -------------------------------------------------------
    def set_mapping(self, steam_appid: int, app_name: Optional[str], source: str = "manual",
                    steam_name: str = "") -> Dict[str, Any]:
        data = self.load()
        key = str(int(steam_appid))
        if app_name:
            data["mappings"][key] = {"app_name": app_name, "source": source, "steam_name": steam_name}
        else:
            data["mappings"].pop(key, None)
        return self.save(data)

    # -- backups --------------------------------------------------------
    def backup(self, label: str = "manual") -> str:
        data = self.load()
        safe = re.sub(r"[^A-Za-z0-9_-]", "", label)[:32] or "backup"
        name = time.strftime("%Y%m%d-%H%M%S") + f"-{safe}.json"
        path = os.path.join(self.backup_dir, name)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, sort_keys=True)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        self._prune_backups(keep=20)
        return name

    def list_backups(self) -> List[Dict[str, Any]]:
        out = []
        for name in sorted(os.listdir(self.backup_dir), reverse=True):
            if not name.endswith(".json"):
                continue
            p = os.path.join(self.backup_dir, name)
            out.append({"name": name, "size": os.path.getsize(p), "mtime": os.path.getmtime(p)})
        return out

    def restore(self, name: str) -> Dict[str, Any]:
        if os.path.basename(name) != name or not name.endswith(".json"):
            raise SettingsError("Invalid backup name")
        path = os.path.join(self.backup_dir, name)
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        # Keep the current runner shortcut id: it belongs to this Steam install,
        # not to the backup.
        current_runner = self.load()["runner"]
        self.backup("pre-restore")
        data["runner"] = current_runner
        return self.save(data)

    def _prune_backups(self, keep: int) -> None:
        names = sorted(n for n in os.listdir(self.backup_dir) if n.endswith(".json"))
        for name in names[:-keep]:
            try:
                os.remove(os.path.join(self.backup_dir, name))
            except OSError:
                pass


def redacted(data: Dict[str, Any]) -> Dict[str, Any]:
    """Copy of settings safe to send to the UI: the password is never echoed back."""
    out = copy.deepcopy(data)
    out["apollo_web"]["password_set"] = bool(out["apollo_web"].get("password"))
    out["apollo_web"]["password"] = ""
    return out
