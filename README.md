# VJ Elato

A two-tab browser VJ tool. One tab is the **player** (goes on the projector), the other is the **controller**. They talk over `BroadcastChannel`, so there is no server and nothing to install. It runs from GitHub Pages or any static folder served over http.

## Sources

- **Local clips** from a folder you pick (a USB stick, say). Chrome and Edge remember the folder between sessions.
- **Destockd** – 39,001 public domain shots cut from 648 FedFlix films, played straight from destockd.com. The 12 curated collections (658 clips, 8.9 GB) are the natural "greatest hits" to keep on a stick; the tool matches local copies to catalog entries automatically.
- **Spelunkr** – the 34 channels of spelunkr.tv, 5,222 archive.org items with in/out points, streamed from archive.org.
- **Moving Image Archive** – movingimagearchive.com, public domain films cut by the shot (640x480), 24 curated collections (film grain, countdowns, glowing lines, objects on black, cursors, cats, technology ...) plus every shot in their listing, streamed from their Cloudflare bucket. With the local server their **describe a shot** search is available: it matches words against the picture, not the title.
- **Any URL** of a video file.

## Use

1. Open `player.html`, move it to the projector screen, click it for fullscreen.
2. Open `controller.html` in another tab of the same browser.
3. Browse, click a clip to load it into deck A or B, mix with the crossfader, blend modes and filters.

## Effects

Local clips are composited in WebGL2: per deck crop (Destockd clips carry a 4:3 picture inside a 16:9 frame; the **4:3 bars** button trims it so cover and zoom work on the real picture), zoom, rotate, mirror, kaleidoscope, pixelate, RGB shift, posterize, threshold, blur, plus the colour controls, and on the master a feedback trail (decay, zoom, rotate, hue drift) and a strobe. The internal render size is adjustable (50/75/100 % of the window) for weaker GPUs.

Streamed clips cannot be read by WebGL on the web version: neither Destockd's CDN nor archive.org's storage nodes send CORS headers on video, so a streamed deck is drawn as a plain `<video>` layer with CSS filters (hue, saturation, contrast, brightness, invert, blur, zoom, rotate, crop, blend mode, strobe). The controls that only the shader can do are greyed out on such a deck. Run from the stick, the local proxy lifts this. The controller shows `webgl` or `css only` next to each deck.

**Safe loading.** A new clip loads into a hidden standby element while the current one keeps playing, and the two swap only once the new one can play. A source that fails or does not answer within 45 s (15 s for a local file) leaves the picture untouched, the controller falls back to the previous clip and shows the reason. The same applies to the controller's previews. **Offline**, the catalog tabs list only what the stick holds, the YouTube tab says so, and the header shows it.

**Web version versus stick.** On GitHub Pages everything that the browser alone can do is there: local clips from a picked folder (Chrome and Edge), their thumbnails and collections, the full effect chain on local clips, streams from Destockd and archive.org as CSS layers. What needs the local server is what the browser forbids: effects on streams (CORS), YouTube (yt-dlp), the cache, link measurement, and a library without a folder picker.

Keys on the controller: `1`/`2` play-pause A/B, `←`/`→` crossfader, `B` blackout. On the player: `F` fullscreen, `H` hide the overlay, `B` blackout.

## Offline and portable

`python tools/make_portable.py F:\` copies the tool to `F:j-elato\` on a stick, including the official embeddable Python for Windows (10 MB, no installer), so `serve.cmd` works on any Windows laptop; `serve.sh` uses the python3 that macOS and Linux ship. The server listens on `http://localhost:8765/` and opens the browser. Nothing is installed. Both tabs must share an origin, which is why a server is needed; plain `file://` pages cannot talk to each other.

### Proxy and cache

The local server also proxies video (`/proxy?url=…`). Served through it a stream is same-origin, so the browser lets WebGL read it and Destockd and archive.org clips get the full effect chain whenever the laptop has internet. The controller detects the proxy and routes streams through it on its own; on GitHub Pages there is no proxy and streams stay on the CSS layer.

**YouTube** works through the same proxy when yt-dlp is available (the portable copy bundles `yt-dlp.exe`; elsewhere install it on PATH): paste a watch, shorts or youtu.be link in the URL tab, the server resolves it to a 1080p H.264 video-only stream (the player is muted anyway), proxies it with the effects, and caches it under `cache\youtube\` by video id. Resolving takes a few seconds. The rendition follows the link: the server measures each host's throughput from its cache downloads and a short probe on the first resolve, and picks the highest rendition up to 1080p whose bitrate is at most half of it (`--yt-max 720` caps it, `--no-adapt` always takes the best). The controller header shows the measured link speeds, and a deck whose stream is heavier than the link can carry is marked "may stall". Only content whose owner permits it, please.

**Pulling the stick.** `serve.cmd` and `serve.sh` copy the tool to the laptop (`%LOCALAPPDATA%\vj-elato\run`, `~/Library/Application Support/vj-elato/run`, `~/.local/share/vj-elato/run`) and run the server from there, so a stick pulled by accident cannot kill it; every launch re-copies, so updating the stick is the update (`--no-stage` runs from the stick and leaves nothing behind). While the stick is out the server says so, the controller shows "stick removed", stick clips that were fully buffered keep looping, and the cache is bypassed. When it is back the controller rescans the library and restarts any stick clip that stalled, at the time it stopped. If the server itself dies, the controller shows "server down" and resumes when `serve.cmd` is run again.

**Session log.** Every session writes one JSON line per event, loads, failures, stalls, stick and server events, uncaught errors, link and cache problems, to `logs\session-<date>.jsonl` next to the staged server on the laptop and to `vj-elato-logs\` on the stick. Status chatter is never logged, repeats are folded, a flood is capped, a file stops at 2 MB and old sessions are pruned (10 on the laptop, 5 on the stick). The **log** button in the header opens the current file; on the web version, where there is no server, it downloads the browser's recent events instead. Hand the file to whoever debugs the set.

**Running from the stick, the server is also the library.** The controller takes the clip list, thumbnails, Destockd index, collections and cache from `stick/index` and plays clips as same-origin URLs: no folder picker, no permission prompts after a reload, any browser, and the ★ button saves through the server. The picker remains for the web version. "rescan" in the header re-reads the stick after you add files.

**YouTube tab.** With yt-dlp present a YouTube tab appears: type a search or paste a playlist or channel link and press Enter; results come from yt-dlp's flat listing, no account. A click resolves the video for the current link speed and plays it through the proxy. **SponsorBlock**: on resolve the server asks the public SponsorBlock API for community-marked ranges (sponsor reads, intros, outros, non-music parts of music videos, ...) and the player jumps over them; "skip sponsor segments" in the YouTube tab turns that off. Coverage depends on someone having marked the video.

With **fetch on play** (default on, toggle in the header) the first play of a stream also downloads the whole file to `<stick>\cache\`. A clip is listed only once complete. The cache is capped at 2 GB (`--cache-gb`) and keeps 500 MB of the stick free (`--reserve-mb`); least recently used clips are removed to make room, and only files the proxy wrote are ever deleted. Cached clips show up in the Stick tab, carry the `stick` badge in the catalogs and play offline like any other local clip.

With the stick as clip folder everything local works without internet: clips, their thumbnails (the `.jpg` next to each clip, or a frame grabbed from the video and cached), effects, and collections. Only the Destockd and Spelunkr catalogs' hotlinked thumbnails and streams need a connection.

## Stick collections

The Stick tab's filter lists, besides every file: your own collections from `vj-elato-collections.json` on the stick (the ★ button on a card adds it to **Starred**; the file is plain JSON you can edit by hand), every top-level folder, and the Destockd collection tags carried by `destockd-index.json`. Picking the folder asks for write access so the ★ button can save; a read-only stick still works, the collection then lives only for the session.

## Catalog

`catalog/*.json` are built by `tools/build_catalog.py` from the raw scan in `data/catalog-scan/` (film list, shot numbers, collection membership, Spelunkr manifests, archive.org file sizes; the large metadata files are kept gzipped, see the README there). `tools/download_destockd.py` fetches a set of Destockd clips to a folder and writes the `destockd-index.json` the controller uses to recognise them.

## Repository layout

| | |
|---|---|
| `index.html`, `player.html`, `controller.html`, `css/`, `js/`, `catalog/` | the tool; this is all that gets published |
| `tools/` | catalog build, Destockd download, local server with proxy and cache, portable copy |
| `data/catalog-scan/` | raw scan of Destockd and Spelunkr, 2026-11-09 |
| `tests/` | browser tests, see `tests/README.md` |
| `.github/workflows/pages.yml` | stages the runtime files with `make_portable.py`, deploys them to GitHub Pages and keeps a zip as a workflow artifact |

Pages is published by the workflow, not from the branch, so the scan data and tests never go to the site. Pushes that touch only `data/` or `tests/` do not redeploy.

The footage is public domain, hosted by the Internet Archive and indexed by two small independent sites. Donate to them if you use this.

## MIDI

The controller speaks Web MIDI (Chrome, Edge). A device file in `midi/` describes a controller: its physical controls (message numbers, captured with a guided wizard) and the roles they play. `midi/numark-mixtrack-pro.json` is the Numark Mixtrack Pro, laid out as an effects surface:

| | |
|---|---|
| crossfader, channel faders | crossfade, deck opacity |
| pitch faders | deck speed, centre = normal, ends = half and double |
| treble, mid, bass | hue, saturation, contrast; with SCRATCH held: zoom, rotate, crop |
| jog wheels | rotate the picture; with SCRATCH held: scrub |
| effect SELECT / CONTROL encoders | pixelate, RGB shift, posterize |
| EFFECT button | hold for kaleidoscope |
| hot cues 1-3 | mirror modes; with SCRATCH: kaleidoscope presets |
| PLAY, CUE, SYNC, STUTTER | play-pause, restart, loop, hold for invert |
| pitch bend, KEYLOCK, MODE, DELETE | kaleido step, 4:3 bars, cover, reset fx |
| loop IN / OUT / RELOOP | hold for zoom 1.5 / 2.5, reset zoom and rotate |
| cue gain, cue mix, headphone cue A / B | feedback, strobe rate, hold for blackout / strobe burst |
| browse, LOAD A / B, BACK | library cursor, load, next tab |
| pitch LEDs, FOLDER / FILE LEDs | deck off normal speed; load target A / B |

**Idle light show.** When the controller has not been touched for ten seconds (adjustable in the lights panel), its LEDs play animations, wave, ripples, radar sweeps around the jog wheels, rain, a bouncing ball, breathing, a chase, Game of Life, sparkle, curtains, cycling in random order, until the next touch, when the state LEDs return. The device file places every LED on the panel; the animations are written for the whole panel as a function of position and time, and each LED samples its own spot, so the sparse lights still read as one picture. A preview canvas in the controller shows the virtual display with the LEDs on it, which also runs without the hardware. Button LEDs: 

Knobs and faders use soft takeover: after a reload or a shift change a control only takes over once it passes the on-screen value. Button LEDs show state (playing, loop, mirror, cover, bars, shift, held effects, loaded decks); clicking the midi pill runs an LED sweep. Roles are plain JSON: edit the file to change the layout. The master gain and mic controls of the Mixtrack Pro are analog and send nothing.

## Roadmap

- Chroma key, LFO modulation of parameters
- Cue points, beat-synced clip switching, playlists
- MIDI input (Web MIDI)
- Remote controller over WebRTC for a phone or second laptop
