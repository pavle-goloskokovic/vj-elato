#!/bin/sh
# VJ Elato launcher (macOS, Linux). Copies the tool to this user's application data and runs
# the server from there, so pulling the stick cannot kill the server; clips and the cache stay
# on the stick. Every launch re-copies, so updating the stick is the update.
# "./serve.sh --no-stage" runs from the stick directly.
SRC="$(cd "$(dirname "$0")" && pwd)"
STICK="$(dirname "$SRC")"
PY=""
command -v python3 >/dev/null 2>&1 && PY=python3
[ -z "$PY" ] && command -v python >/dev/null 2>&1 && PY=python
if [ -z "$PY" ]; then echo "Python 3 is needed to run the local server (it ships with macOS and most Linux)."; exit 1; fi

if [ "$1" = "--no-stage" ]; then cd "$SRC" && exec "$PY" serve.py 8765; fi

case "$(uname)" in
  Darwin) RUN="$HOME/Library/Application Support/vj-elato/run" ;;
  *)      RUN="${XDG_DATA_HOME:-$HOME/.local/share}/vj-elato/run" ;;
esac
echo "Staging the tool to $RUN ..."
rm -rf "$RUN" && mkdir -p "$RUN" && cp -R "$SRC/." "$RUN/" || { echo "Could not copy; running from the stick instead."; cd "$SRC" && exec "$PY" serve.py 8765; }
cd "$RUN" && exec "$PY" serve.py 8765 --stick "$STICK"
