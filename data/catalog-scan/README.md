# Catalog scan of Destockd and Spelunkr (2026-11-09)

Raw data behind the size estimate for the VJ tool. Everything was fetched from
public endpoints: destockd.com/api, spelunkr.tv/broadcast/, archive.org/metadata.

## Destockd (destockd.com)
- `destockd_films.json` – all 648 films; per film: archive.org URL, shot count,
  and every clip URL on clips.destockd.com (39,001 clips total).
- `destockd_ids.txt` – the 648 archive.org identifiers (FedFlix source films).
- `destockd_meta.json` – archive.org metadata per identifier: item_size and
  per-file sizes (`files`), video files only (`mp4s`).
- `clip_sample.txt` / `clip_sizes.txt` – 300 random clip URLs and their
  Content-Length. Mean 13.5 MB, median 5.9 MB → ~525 GB for all clips.
- Source films on archive.org: ~550 GB (all video files), ~109 GB taking the
  smallest .mp4 per film.

## Spelunkr (spelunkr.tv)
- `lineup.json` – the 34 channels with stats and manifest versions.
- `manifests/` – latest manifest per channel: items with archive.org `id`,
  file name (`mp4` or `file`), duration, title, year, in/out points.
- `spelunkr_items.json` – 5,091 unique (identifier|file) pairs from 33
  channels, with duration and channel list. `vs_items.json` adds the 112 items
  of vacation-slides, fetched separately.
- `spelunkr_meta.json`, `vs_meta.json` – archive.org metadata per identifier.
- Totals: 3,431 identifiers, 5,203 files, ~3,930 h, ~2.78 TB. Mean file 540 MB.
- No overlap in archive.org identifiers between the two sites.

## Scripts
- `destockd_scan.py` – enumerate films/shots via destockd.com/api (curl transport).
- `ia_sizes.py items.json out.json` – fetch archive.org metadata for every
  identifier in an items file keyed `identifier|file`.
