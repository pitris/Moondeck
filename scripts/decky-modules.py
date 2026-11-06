#!/usr/bin/env python3
"""List the Python modules a Decky Loader release makes available to plugin backends.

Decky's PluginLoader is a PyInstaller binary; plugin backends can only import
modules frozen into it. Usage (needs `pip install pyinstaller`):

    curl -LO https://github.com/SteamDeckHomebrew/decky-loader/releases/download/v3.3.1/PluginLoader
    python3 scripts/decky-modules.py PluginLoader > tests/decky_stdlib_modules.txt
"""
import io
import re
import sys
import zipfile

from PyInstaller.archive.readers import CArchiveReader, ZlibArchiveReader

arch = CArchiveReader(sys.argv[1])
mods = set()
for name in arch.toc:
    if name.endswith(".pyz"):
        open("/tmp/_decky.pyz", "wb").write(arch.extract(name))
        mods |= set(ZlibArchiveReader("/tmp/_decky.pyz").toc)
    elif "base_library" in name:
        z = zipfile.ZipFile(io.BytesIO(arch.extract(name)))
        mods |= {n[:-4].replace("/__init__", "").replace("/", ".") for n in z.namelist() if n.endswith(".pyc")}
    elif "lib-dynload/" in name:
        mods.add(re.sub(r"\..*$", "", name.rsplit("/", 1)[1]))
    elif "/" not in name and "." not in name:
        mods.add(name)  # modules PyInstaller stores at the archive top level (e.g. struct)
    elif "libpython" in name:
        mods |= {m.decode() for m in re.findall(rb"PyInit_([A-Za-z0-9_]+)\x00", arch.extract(name))}
mods |= {"sys", "builtins", "_imp", "marshal", "_frozen_importlib", "_frozen_importlib_external"}
print(f"# Python modules available to plugin backends inside {sys.argv[1]}")
print("\n".join(sorted(mods)))
