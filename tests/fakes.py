"""Test doubles: a fake Apollo host and a fake Moonlight executable."""

from __future__ import annotations

import http.server
import json
import os
import ssl
import subprocess
import tempfile
import threading
from typing import Any, Dict, List, Optional

SERVERINFO_XML = """<?xml version="1.0" encoding="utf-8"?>
<root status_code="200">
  <hostname>GAMING-PC</hostname>
  <appversion>7.1.431.-1</appversion>
  <GfeVersion>3.23.0.74</GfeVersion>
  <uniqueid>4D7BB6F7-1111-2222-3333-444455556666</uniqueid>
  <HttpsPort>47984</HttpsPort>
  <ExternalPort>47989</ExternalPort>
  <mac>00:00:00:00:00:00</mac>
  <VirtualDisplayCapable>true</VirtualDisplayCapable>
  <currentgame>0</currentgame>
  <state>SUNSHINE_SERVER_FREE</state>
</root>
"""


class _Handler(http.server.BaseHTTPRequestHandler):
    server_version = "FakeApollo/1.0"

    def log_message(self, *args: Any) -> None:  # silence test output
        pass

    @property
    def state(self) -> "FakeApollo":
        return self.server.fake  # type: ignore[attr-defined]

    def _send(self, status: int, body: bytes, ctype: str = "application/json",
              headers: Optional[Dict[str, str]] = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path.startswith("/serverinfo"):
            self.state.requests.append(self.path)
            return self._send(200, SERVERINFO_XML.encode(), "application/xml")
        if self.path == "/api/apps":
            if not self._authed():
                return self._send(401, b'{"status":false}')
            return self._send(200, json.dumps({"apps": self.state.apps, "host_name": "GAMING-PC"}).encode())
        self._send(404, b"{}")

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        if self.path == "/api/login":
            if self.state.basic_only:
                return self._send(404, b"{}")
            if body.get("username") == "admin" and body.get("password") == "secret":
                return self._send(200, b"", headers={"Set-Cookie": "auth=COOKIE123; Secure; SameSite=Strict; Path=/"})
            return self._send(401, b"")
        if self.path == "/api/apps":
            if not self._authed():
                return self._send(401, b"")
            if self.headers.get("Content-Type") != "application/json":
                return self._send(400, b"")
            # Same semantics as Apollo's proc::migrate_apps: an existing uuid
            # replaces that app, an empty uuid appends a new one.
            if body.get("uuid"):
                for i, app in enumerate(self.state.apps):
                    if app.get("uuid") == body["uuid"]:
                        self.state.apps[i] = body
                        break
                else:
                    self.state.apps.append(body)
            else:
                body["uuid"] = f"uuid-{len(self.state.apps)}"
                self.state.apps.append(body)
            return self._send(200, b'{"status":true}')
        self._send(404, b"{}")

    def _authed(self) -> bool:
        if self.headers.get("Cookie") == "auth=COOKIE123":
            return True
        # base64("admin:secret")
        return self.headers.get("Authorization") == "Basic YWRtaW46c2VjcmV0"


class _QuietServer(http.server.ThreadingHTTPServer):
    def handle_error(self, request, client_address):  # client hung up mid-TLS: irrelevant
        pass


class FakeApollo:
    """Serves GameStream /serverinfo over HTTP and the web UI API over HTTPS."""

    def __init__(self, basic_only: bool = False):
        self.apps: List[Dict[str, Any]] = [
            {"name": "Desktop", "uuid": "u1"},
            {"name": "Steam Big Picture", "uuid": "u2", "detached": ["steam://open/bigpicture"]},
            {"name": "Cyberpunk 2077", "uuid": "u3", "detached": ["steam://rungameid/1091500"]},
            {"name": "Elden Ring (PC)", "uuid": "u4", "cmd": "C:\\Steam\\steam.exe -applaunch 1245620"},
        ]
        self.basic_only = basic_only
        self.requests: List[str] = []
        self._tmp = tempfile.TemporaryDirectory()
        cert = os.path.join(self._tmp.name, "cert.pem")
        key = os.path.join(self._tmp.name, "key.pem")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
                        "-out", cert, "-days", "1", "-subj", "/CN=Sunshine Gamestream Host"],
                       check=True, capture_output=True)
        self.http = _QuietServer(("127.0.0.1", 0), _Handler)
        self.http.fake = self  # type: ignore[attr-defined]
        self.https = _QuietServer(("127.0.0.1", 0), _Handler)
        self.https.fake = self  # type: ignore[attr-defined]
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        self.https.socket = ctx.wrap_socket(self.https.socket, server_side=True)
        self.http_port = self.http.server_address[1]
        self.https_port = self.https.server_address[1]
        self._threads = [threading.Thread(target=s.serve_forever, daemon=True) for s in (self.http, self.https)]

    def __enter__(self) -> "FakeApollo":
        for t in self._threads:
            t.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        for s in (self.http, self.https):
            s.shutdown()
            s.server_close()
        self._tmp.cleanup()


FAKE_MOONLIGHT = r"""#!/usr/bin/env bash
# Fake moonlight-qt CLI used by the tests.
echo "$@" >> "$FAKE_ML_LOG"
case "$1" in
  list)
    if [[ "${FAKE_ML_MODE:-}" == "unpaired" ]]; then
      echo "Computer GAMING-PC has not been paired. Please open Moonlight to pair before retrieving games list." >&2
      exit 255
    fi
    echo 'Name, ID, HDR Support, App Collection Game, Hidden, Direct Launch, Boxart URL'
    echo '"Desktop",1,false,false,false,false,"file:///x/1.png"'
    echo '"Cyberpunk 2077",2,true,false,false,false,"file:///x/2.png"'
    echo '"Hades II",3,false,false,false,false,"file:///x/3.png"'
    echo '"Hidden Thing",4,false,false,true,false,"file:///x/4.png"'
    echo '"Say "Hi", World",5,false,false,false,false,"file:///x/5.png"'
    ;;
  stream)
    echo "streaming $3 from $2"
    if [[ "${FAKE_ML_MODE:-}" == "fail" ]]; then
      echo "Failed to find application $3" >&2
      exit 1
    fi
    if [[ -n "${FAKE_ML_SLEEP:-}" ]]; then sleep "$FAKE_ML_SLEEP"; fi
    exit 0
    ;;
esac
"""


def write_fake_moonlight(directory: str) -> str:
    path = os.path.join(directory, "moonlight")
    with open(path, "w") as f:
        f.write(FAKE_MOONLIGHT)
    os.chmod(path, 0o755)
    return path
