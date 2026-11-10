#!/bin/sh
# VJ Elato: serve this folder on http://localhost:8765/ and open it (macOS, Linux).
cd "$(dirname "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then exec python3 serve.py 8765; fi
if command -v python >/dev/null 2>&1; then exec python serve.py 8765; fi
echo "Python 3 is needed to run the local server (it ships with macOS and most Linux)."; exit 1
