#!/bin/sh
# VJ Elato launcher (Linux, macOS). Works from any folder on any drive: clips, cache and logs
# live in this folder (clips/, clips/cache/, logs/). Needs Python 3, which ships with most
# Linux systems; on macOS the first run of python3 offers to install it.
#
# From a removable drive (anything mounted under /media, /run/media, /mnt or /Volumes) the tool
# is first copied to this user's application data and run from there, so pulling the drive
# cannot kill the server; the clips, the cache and a copy of the log stay on the drive. Every
# launch re-copies, so updating the drive is the update. From anywhere else it runs in place.
#   ./serve.sh --stage      copy first, whatever the drive
#   ./serve.sh --no-stage   never copy
# Extra options for serve.py (see its first lines) go in the VJ_ELATO_ARGS variable.
SRC="$(cd "$(dirname "$0")" && pwd)"
PY=""
# one that really runs and is version 3, not merely a name on the PATH
for c in python3 python; do
  if [ -z "$PY" ] && "$c" -c 'import sys; sys.exit(sys.version_info[0] != 3)' >/dev/null 2>&1; then PY="$c"; fi
done
if [ -z "$PY" ]; then
  echo "Python 3 is needed to run the local server."
  echo "  Linux: install the python3 package.   macOS: run  xcode-select --install  or get it from python.org."
  exit 1
fi

STAGE=""
case "$SRC" in /media/*|/run/media/*|/mnt/*|/Volumes/*) STAGE=1 ;; esac
[ "$1" = "--stage" ] && STAGE=1
[ "$1" = "--no-stage" ] && STAGE=""
if [ -z "$STAGE" ]; then cd "$SRC" && exec "$PY" serve.py 8765 $VJ_ELATO_ARGS; fi

case "$(uname)" in
  Darwin) RUN="$HOME/Library/Application Support/vj-elato/run" ;;
  *)      RUN="${XDG_DATA_HOME:-$HOME/.local/share}/vj-elato/run" ;;
esac
echo "Copying the tool to $RUN ..."
# everything but the clips and the logs; the copy's own logs are kept from run to run
if mkdir -p "$RUN" && find "$RUN" -mindepth 1 -maxdepth 1 ! -name logs -exec rm -rf {} + \
   && find "$SRC" -mindepth 1 -maxdepth 1 ! -name clips ! -name logs -exec cp -R {} "$RUN/" \; ; then
  cd "$RUN" && exec "$PY" serve.py 8765 --home "$SRC" $VJ_ELATO_ARGS
fi
echo "Could not copy; running from the drive instead."
cd "$SRC" && exec "$PY" serve.py 8765 $VJ_ELATO_ARGS
