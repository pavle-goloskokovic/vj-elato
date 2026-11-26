#!/bin/sh
# VJ Elato launcher for macOS: double-click this file in Finder. It opens a Terminal window and
# runs serve.sh from the same folder. The first time macOS may refuse a downloaded file:
# right-click it, choose Open, then Open again.
cd "$(dirname "$0")" && exec sh ./serve.sh "$@"
