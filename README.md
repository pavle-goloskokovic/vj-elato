# VJ Elato

A two-tab browser VJ tool. One tab is the **player** (goes on the projector), the other is the **controller**. They talk over `BroadcastChannel`, so there is no server and nothing to install. It runs from GitHub Pages or any static folder served over http.

## Sources

- **Local clips** from a folder you pick (a USB stick, say). Chrome and Edge remember the folder between sessions.
- **Destockd** – 39,001 public domain shots cut from 648 FedFlix films, played straight from destockd.com. The 12 curated collections (658 clips, 8.9 GB) are the natural "greatest hits" to keep on a stick; the tool matches local copies to catalog entries automatically.
- **Spelunkr** – the 34 channels of spelunkr.tv, 5,222 archive.org items with in/out points, streamed from archive.org.
- **Any URL** of a video file.

## Use

1. Open `player.html`, move it to the projector screen, click it for fullscreen.
2. Open `controller.html` in another tab of the same browser.
3. Browse, click a clip to load it into deck A or B, mix with the crossfader, blend modes and filters.

Keys on the controller: `1`/`2` play-pause A/B, `←`/`→` crossfader, `B` blackout. On the player: `F` fullscreen, `H` hide the overlay, `B` blackout.

Local files need `file://`-free hosting: both tabs must share an origin. Locally, run `python -m http.server` in this folder and open `http://localhost:8000/`.

## Catalog

`catalog/*.json` are built by `tools/build_catalog.py` from a scan of both sites (film list, shot numbers, collection membership, Spelunkr manifests, archive.org file sizes). `tools/download_destockd.py` fetches a set of Destockd clips to a folder and writes the `destockd-index.json` the controller uses to recognise them.

The footage is public domain, hosted by the Internet Archive and indexed by two small independent sites. Donate to them if you use this.

## Roadmap

- WebGL compositing with shader effects (feedback, kaleidoscope, chroma key)
- Cue points, beat-synced clip switching, playlists
- MIDI input (Web MIDI)
- Remote controller over WebRTC for a phone or second laptop
