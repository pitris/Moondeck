"""Backend library for the Moondeck Apollo Decky plugin.

Everything in this package is plain standard-library Python so it can be unit
tested outside of Decky Loader (see ``tests/``). ``main.py`` at the plugin root
is the only file that imports the ``decky`` module.
"""

__all__ = [
    "apollo",
    "launch",
    "mapping",
    "moonlight",
    "moonlight_conf",
    "procenv",
    "service",
    "settings",
    "wol",
]
