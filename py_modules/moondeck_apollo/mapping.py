"""Map a Steam game (AppID + display name) to an Apollo application name."""

from __future__ import annotations

import difflib
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional

# steam://rungameid/1091500, steam://run/1091500, steam://launch/1091500
_STEAM_URL_RE = re.compile(r"steam://(?:rungameid|run|launch)/(\d+)", re.IGNORECASE)
# steam.exe -applaunch 1091500
_APPLAUNCH_RE = re.compile(r"-applaunch\s+(\d+)", re.IGNORECASE)

_TRADEMARKS = str.maketrans({"™": " ", "®": " ", "©": " "})
_ROMAN = {"ii": "2", "iii": "3", "iv": "4", "v": "5", "vi": "6", "vii": "7", "viii": "8", "ix": "9", "x": "10"}


def normalize_title(title: str) -> str:
    """Normalise a game title for comparison.

    "Cyberpunk 2077™" == "cyberpunk 2077", "DOOM Eternal" == "Doom: Eternal",
    "Final Fantasy VII Remake" == "Final Fantasy 7 Remake".
    """
    t = unicodedata.normalize("NFKD", (title or "").translate(_TRADEMARKS))
    t = "".join(c for c in t if not unicodedata.combining(c)).lower()
    t = t.replace("&", " and ")
    words = re.findall(r"[a-z0-9]+", t)
    words = [_ROMAN.get(w, w) for w in words]
    return " ".join(words)


def steam_appids_in_app(app: Dict[str, Any]) -> List[int]:
    """Extract Steam AppIDs referenced by an Apollo/Sunshine app definition."""
    texts: List[str] = []
    for key in ("cmd", "detached"):
        value = app.get(key)
        if isinstance(value, str):
            texts.append(value)
        elif isinstance(value, list):
            texts.extend(str(v) for v in value)
    for prep in app.get("prep-cmd") or []:
        if isinstance(prep, dict):
            texts.append(str(prep.get("do") or ""))
    ids: List[int] = []
    for text in texts:
        for rx in (_STEAM_URL_RE, _APPLAUNCH_RE):
            for m in rx.finditer(text):
                appid = int(m.group(1))
                if appid not in ids:
                    ids.append(appid)
    return ids


@dataclass
class Resolution:
    # "manual" | "steam_appid" | "name" | "unmapped"
    status: str
    app_name: Optional[str] = None
    candidates: List[str] = field(default_factory=list)
    detail: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            "app_name": self.app_name,
            "candidates": self.candidates,
            "detail": self.detail,
            "mapped": self.app_name is not None,
        }


def _visible(apps: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [a for a in apps if a.get("name") and not a.get("hidden")]


def suggest(steam_name: str, apps: Iterable[Dict[str, Any]], limit: int = 5) -> List[str]:
    """Apollo app names ranked by similarity to ``steam_name``."""
    target = normalize_title(steam_name)
    scored = []
    for app in _visible(apps):
        norm = normalize_title(app["name"])
        ratio = difflib.SequenceMatcher(None, target, norm).ratio()
        if target and (target in norm or norm in target):
            ratio = max(ratio, 0.85)
        scored.append((ratio, app["name"]))
    scored.sort(key=lambda x: (-x[0], x[1].lower()))
    return [name for ratio, name in scored if ratio >= 0.45][:limit]


def resolve(steam_appid: int, steam_name: str, mappings: Dict[str, Any],
            apps: List[Dict[str, Any]]) -> Resolution:
    """Decide which Apollo app to stream for a Steam game.

    Priority:
      1. A mapping the user saved (always wins, even if the app list is stale).
      2. An Apollo app whose command launches this exact Steam AppID
         (needs Apollo web UI access, otherwise ``steam_appids`` is unknown).
      3. Exactly one Apollo app whose normalised name equals the Steam name.
    Anything else is reported as unmapped with ranked suggestions, so the
    user picks once and the choice is saved. We never guess silently between
    several similar names: launching the wrong game is worse than asking.
    """
    manual = mappings.get(str(steam_appid))
    if manual and manual.get("app_name"):
        return Resolution("manual", manual["app_name"], detail="Saved mapping")

    visible = _visible(apps)

    if steam_appid > 0:
        by_id = [a["name"] for a in visible if steam_appid in (a.get("steam_appids") or [])]
        if len(by_id) == 1:
            return Resolution("steam_appid", by_id[0], detail=f"Apollo app launches Steam AppID {steam_appid}")
        if len(by_id) > 1:
            return Resolution("unmapped", None, candidates=by_id,
                              detail="Several Apollo apps launch this AppID; pick one")

    target = normalize_title(steam_name)
    by_name = [a["name"] for a in visible if target and normalize_title(a["name"]) == target]
    if len(by_name) == 1:
        return Resolution("name", by_name[0], detail="Apollo app has the same name")

    candidates = by_name or suggest(steam_name, visible)
    return Resolution("unmapped", None, candidates=candidates,
                      detail="No Apollo app matches this game automatically")


def app_exists(app_name: str, apps: List[Dict[str, Any]]) -> bool:
    # Moonlight matches app names case-insensitively (see moonlight-qt
    # app/cli/startstream.cpp getAppIndex), so do the same here.
    wanted = app_name.lower()
    return any(a.get("name", "").lower() == wanted for a in apps)
