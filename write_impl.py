#!/usr/bin/env python3
"""Write the auto-trading bot implementation files."""
import json, os, base64, sys
BASE = "c:/Users/HP/Desktop/neural-edge-bot"

def w(path, b64):
    full = os.path.join(BASE, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8") as f:
        f.write(base64.b64decode(b64).decode("utf-8"))
    print(f"OK {path}")
