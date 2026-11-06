"""Talking to Apollo (or Sunshine) on the Windows PC.

Two interfaces are used:

* GameStream ``/serverinfo`` over plain HTTP (port 47989). It needs no pairing
  and tells us whether Apollo is up, its hostname/UUID and whether a stream is
  running. This is our "is the PC online?" probe.
* The Apollo web UI REST API over HTTPS (port 47990), optional. Apollo uses a
  cookie session (``POST /api/login``); upstream Sunshine uses HTTP Basic auth.
  It lets us read each app's command line (for exact Steam AppID matching) and
  create a missing app. Requires the web UI username/password.
"""

from __future__ import annotations

import base64
import hashlib
import http.client
import json
import ssl
import uuid
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional, Tuple

from .mapping import steam_appids_in_app

_CLIENT_UNIQUE_ID = "0123456789ABCDEF"


class ApolloError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _host_for_url(address: str) -> str:
    if ":" in address and not address.startswith("["):
        return f"[{address}]"  # bare IPv6
    return address


def probe_serverinfo(address: str, port: int = 47989, timeout: float = 2.5) -> Dict[str, Any]:
    """Return ``{"online": bool, ...}``. Never raises for network errors."""
    if not address:
        return {"online": False, "error": "No host address configured"}
    path = f"/serverinfo?uniqueid={_CLIENT_UNIQUE_ID}&uuid={uuid.uuid4().hex}"
    conn = http.client.HTTPConnection(address, port, timeout=timeout)
    try:
        conn.request("GET", path, headers={"Connection": "close"})
        resp = conn.getresponse()
        body = resp.read(256 * 1024)
    except (OSError, http.client.HTTPException) as e:
        return {"online": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        conn.close()
    if resp.status != 200:
        return {"online": False, "error": f"HTTP {resp.status} from serverinfo"}
    return parse_serverinfo(body)


def parse_serverinfo(body: bytes) -> Dict[str, Any]:
    try:
        root = ET.fromstring(body)
    except ET.ParseError as e:
        return {"online": False, "error": f"Invalid serverinfo XML: {e}"}

    def text(tag: str) -> str:
        el = root.find(tag)
        return (el.text or "").strip() if el is not None else ""

    mac = text("mac")
    current_game = text("currentgame")
    return {
        "online": True,
        "hostname": text("hostname"),
        "uniqueid": text("uniqueid"),
        "appversion": text("appversion"),
        "state": text("state"),
        "mac": mac if mac and mac != "00:00:00:00:00:00" else "",
        "current_game": int(current_game) if current_game.isdigit() else 0,
        # Apollo-only field; absent on Sunshine.
        "virtual_display": text("VirtualDisplayCapable").lower() == "true",
        "is_apollo": root.find("VirtualDisplayCapable") is not None,
    }


class ApolloWebClient:
    """Minimal client for the Apollo/Sunshine web UI API."""

    def __init__(self, address: str, port: int, username: str, password: str,
                 pinned_sha256: str = "", timeout: float = 6.0):
        self.address = address
        self.port = port
        self.username = username
        self.password = password
        self.pinned_sha256 = (pinned_sha256 or "").lower()
        self.timeout = timeout
        self.cookie: Optional[str] = None
        self.use_basic = False
        self.seen_sha256: str = ""

    # The web UI uses a self-signed certificate generated on the PC, so normal
    # CA validation cannot work. Instead the certificate fingerprint is pinned
    # the first time the user saves working credentials (trust on first use);
    # a later mismatch is refused before any password is sent.
    def _connect(self) -> http.client.HTTPSConnection:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        conn = http.client.HTTPSConnection(self.address, self.port, timeout=self.timeout, context=ctx)
        conn.connect()
        der = conn.sock.getpeercert(binary_form=True) if conn.sock else None
        self.seen_sha256 = hashlib.sha256(der).hexdigest() if der else ""
        if self.pinned_sha256 and self.seen_sha256 != self.pinned_sha256:
            conn.close()
            raise ApolloError("CERT_MISMATCH",
                              "The Apollo web UI certificate changed since it was first trusted. "
                              "If you reinstalled Apollo, clear the pinned certificate in settings.")
        return conn

    def _request(self, method: str, path: str, body: Optional[Dict[str, Any]] = None,
                 auth: bool = True) -> Tuple[int, Dict[str, str], bytes]:
        headers = {"Connection": "close", "Accept": "application/json"}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        if auth:
            if self.use_basic:
                token = base64.b64encode(f"{self.username}:{self.password}".encode()).decode()
                headers["Authorization"] = f"Basic {token}"
            elif self.cookie:
                headers["Cookie"] = f"auth={self.cookie}"
        try:
            conn = self._connect()
        except ApolloError:
            raise
        except (OSError, ssl.SSLError, http.client.HTTPException) as e:
            raise ApolloError("WEB_UNREACHABLE", f"Cannot reach Apollo web UI on port {self.port}: {e}")
        try:
            conn.request(method, path, body=data, headers=headers)
            resp = conn.getresponse()
            payload = resp.read(4 * 1024 * 1024)
            resp_headers = {k.lower(): v for k, v in resp.getheaders()}
            return resp.status, resp_headers, payload
        except (OSError, http.client.HTTPException) as e:
            raise ApolloError("WEB_UNREACHABLE", f"Apollo web UI request failed: {e}")
        finally:
            conn.close()

    def login(self) -> None:
        if not self.username or not self.password:
            raise ApolloError("WEB_NO_CREDENTIALS", "Apollo web UI username/password not configured")
        status, headers, _ = self._request(
            "POST", "/api/login", {"username": self.username, "password": self.password}, auth=False)
        if status == 200:
            cookie = _extract_cookie(headers.get("set-cookie", ""), "auth")
            if not cookie:
                raise ApolloError("WEB_LOGIN_FAILED", "Apollo accepted the login but sent no session cookie")
            self.cookie = cookie
            return
        if status in (404, 405):
            # Upstream Sunshine has no /api/login and uses Basic auth instead.
            self.use_basic = True
            status, _, _ = self._request("GET", "/api/apps")
            if status == 200:
                return
        if status in (401, 403):
            raise ApolloError("WEB_LOGIN_FAILED",
                              "Apollo rejected the web UI login (wrong username/password, "
                              "or the Legion Go is outside the allowed origin)")
        raise ApolloError("WEB_LOGIN_FAILED", f"Unexpected HTTP {status} from Apollo login")

    def get_apps(self) -> List[Dict[str, Any]]:
        if not self.cookie and not self.use_basic:
            self.login()
        status, _, payload = self._request("GET", "/api/apps")
        if status == 401:
            raise ApolloError("WEB_LOGIN_FAILED", "Apollo web UI session was rejected")
        if status != 200:
            raise ApolloError("WEB_ERROR", f"HTTP {status} from /api/apps")
        try:
            tree = json.loads(payload)
        except ValueError as e:
            raise ApolloError("WEB_ERROR", f"Invalid JSON from /api/apps: {e}")
        apps = []
        for app in tree.get("apps") or []:
            if not isinstance(app, dict) or not app.get("name"):
                continue
            apps.append({
                "name": str(app["name"]),
                "uuid": str(app.get("uuid") or ""),
                "steam_appids": steam_appids_in_app(app),
                "hidden": False,
            })
        return apps

    def add_steam_app(self, name: str, steam_appid: int) -> None:
        """Create an Apollo app that launches ``steam://rungameid/<appid>`` on the PC."""
        if not self.cookie and not self.use_basic:
            self.login()
        body = {
            "name": name,
            "output": "",
            "cmd": "",
            "exclude-global-prep-cmd": False,
            "elevated": False,
            "auto-detach": True,
            "wait-all": True,
            "exit-timeout": 5,
            "prep-cmd": [],
            "detached": [f"steam://rungameid/{int(steam_appid)}"],
            "image-path": "",
            # Empty uuid -> Apollo generates one and appends a new app.
            "uuid": "",
        }
        status, _, payload = self._request("POST", "/api/apps", body)
        if status != 200:
            raise ApolloError("WEB_ERROR", f"Apollo refused to create the app (HTTP {status}): "
                                           f"{payload[:200].decode(errors='replace')}")


def _extract_cookie(set_cookie: str, name: str) -> Optional[str]:
    for part in set_cookie.replace(",", ";").split(";"):
        part = part.strip()
        if part.startswith(name + "="):
            return part[len(name) + 1:]
    return None
