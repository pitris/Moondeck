"""Wake-on-LAN helpers."""

from __future__ import annotations

import ipaddress
import re
import socket
from typing import List, Optional, Tuple

_MAC_HEX_RE = re.compile(r"^[0-9a-fA-F]{12}$")


def mac_to_bytes(mac: str) -> bytes:
    cleaned = re.sub(r"[^0-9a-fA-F]", "", mac or "")
    if not _MAC_HEX_RE.match(cleaned):
        raise ValueError(f"Invalid MAC address: {mac!r}")
    return bytes.fromhex(cleaned)


def build_magic_packet(mac: str) -> bytes:
    return b"\xff" * 6 + mac_to_bytes(mac) * 16


def wake_targets(host_address: str, broadcast: str) -> List[Tuple[str, int]]:
    """Where to send the magic packet.

    A sleeping PC has no IP stack, so the packet must reach its NIC by
    broadcast. We send to the configured broadcast address, the limited
    broadcast, and the /24 directed broadcast of the host IP (the common
    home-LAN case), on both conventional WoL ports.
    """
    addrs: List[str] = []
    for candidate in (broadcast, "255.255.255.255"):
        if candidate and candidate not in addrs:
            addrs.append(candidate)
    try:
        ip = ipaddress.ip_address(host_address)
        if ip.version == 4 and ip.is_private:
            directed = str(ipaddress.ip_network(f"{ip}/24", strict=False).broadcast_address)
            if directed not in addrs:
                addrs.append(directed)
            # Unicast also works while the switch/ARP cache still knows the PC.
            addrs.append(str(ip))
    except ValueError:
        pass  # host is a DNS name; broadcasts are enough
    return [(a, port) for a in addrs for port in (9, 7)]


def send_magic_packet(mac: str, host_address: str, broadcast: str = "255.255.255.255") -> int:
    packet = build_magic_packet(mac)
    sent = 0
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        for target in wake_targets(host_address, broadcast):
            try:
                sock.sendto(packet, target)
                sent += 1
            except OSError:
                continue
    return sent


def lookup_mac_in_arp(ip: str, arp_path: str = "/proc/net/arp") -> Optional[str]:
    """Return the MAC of ``ip`` from the kernel ARP cache (needs the PC to be online)."""
    try:
        with open(arp_path, "r", encoding="ascii", errors="replace") as f:
            lines = f.read().splitlines()[1:]
    except OSError:
        return None
    for line in lines:
        parts = line.split()
        if len(parts) >= 4 and parts[0] == ip:
            mac = parts[3].upper()
            if mac != "00:00:00:00:00:00" and re.match(r"^([0-9A-F]{2}:){5}[0-9A-F]{2}$", mac):
                return mac
    return None


def resolve_ipv4(host: str) -> Optional[str]:
    try:
        return socket.gethostbyname(host)
    except OSError:
        return None
