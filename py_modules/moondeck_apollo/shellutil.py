"""Tiny replacements for ``shlex.quote`` / ``shlex.split``.

Decky Loader runs plugin backends inside its own PyInstaller-frozen Python,
which only contains the standard-library modules Decky itself imports.
``shlex`` is not among them, so importing it crashes the plugin backend.
(See tests/decky_stdlib_modules.txt and tests/test_decky_runtime.py.)
"""

from __future__ import annotations

from typing import List

_SAFE = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@%+=:,./-_")


def quote(s: str) -> str:
    """POSIX-shell-safe quoting, same output as ``shlex.quote``."""
    if not s:
        return "''"
    if all(c in _SAFE for c in s):
        return s
    return "'" + s.replace("'", "'\"'\"'") + "'"


def split(s: str) -> List[str]:
    """POSIX-style word splitting with '…', "…" and backslash escapes."""
    words: List[str] = []
    cur: List[str] = []
    in_word = False
    i, n = 0, len(s)
    while i < n:
        c = s[i]
        if c in " \t\r\n":
            if in_word:
                words.append("".join(cur))
                cur, in_word = [], False
            i += 1
        elif c == "'":
            end = s.find("'", i + 1)
            if end < 0:
                raise ValueError("No closing quotation")
            cur.append(s[i + 1:end])
            in_word, i = True, end + 1
        elif c == '"':
            i += 1
            while True:
                if i >= n:
                    raise ValueError("No closing quotation")
                ch = s[i]
                if ch == '"':
                    i += 1
                    break
                if ch == "\\" and i + 1 < n and s[i + 1] in '"\\$`\n':
                    cur.append(s[i + 1])
                    i += 2
                    continue
                cur.append(ch)
                i += 1
            in_word = True
        elif c == "\\":
            if i + 1 < n:
                cur.append(s[i + 1])
            in_word, i = True, i + 2
        else:
            cur.append(c)
            in_word, i = True, i + 1
    if in_word:
        words.append("".join(cur))
    return words
