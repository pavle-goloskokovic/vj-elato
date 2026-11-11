# Tests

`e2e.py` drives the real pages in Google Chrome: it stages the site, serves it with
`tools/serve.py`, opens the player and the controller as two tabs and checks the things
that broke while the tool was built.

```
pip install playwright pillow
python tests/e2e.py                 # all scenarios
python tests/e2e.py --scenario reload
python tests/e2e.py --clip path/to/clip.mp4
```

Scenarios:

- **smoke** – cards render without overlapping, the tabs find each other, a local clip
  plays on WebGL, a Destockd stream falls back to the CSS layer, deck and master effects
  change the picture, strobe blinks, the crossfader is linear, reset fx resets.
- **reload** – reloading the controller restores clips and settings, leaves the player
  playing and resumes the previews in sync; reloading the player resumes where it was.
- **crop** – the 4:3 bars button trims the pillarbox so cover differs from contain.
- **proxy** – a Destockd stream goes through the local proxy and plays on WebGL, fetch on play
  stores the whole clip in the cache, a second play comes from the cache, the toggle reaches the server.
- **youtube** – a YouTube link resolves through yt-dlp and plays on WebGL (skipped without yt-dlp).

Why it is set up the way it is:

- **Installed Chrome, not Playwright's Chromium.** The bundled Chromium has no H.264
  decoder, so every Destockd and archive.org clip fails to load in it.
- **GPU flags.** Without `--use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist` headless
  Chrome renders WebGL in software and crawls.
- **A server with byte ranges.** Python's `http.server` has none; a `<video>` served by it
  cannot seek, and the preview drift correction then looks broken.
- **The clip comes from the stick.** It is 12 MB and not worth committing; the test finds
  the first drive with `destockd-index.json`, or takes `--clip`.

These cannot run on GitHub's runners (no GPU, no H.264 Chrome), which is why the Pages
workflow does not call them.
