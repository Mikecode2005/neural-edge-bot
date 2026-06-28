#!/usr/bin/env python3
"""File writer utility - writes content to path, creating directories."""
import os, sys, base64
path = sys.argv[1]
b64 = sys.argv[2]
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "wb") as f:
    f.write(base64.b64decode(b64))
print(f"Written {path}")
