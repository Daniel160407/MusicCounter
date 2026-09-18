# Music Counter

A Chrome extension that measures how much time you actually spend **listening to music** on
YouTube, YouTube Music and the Spotify web player.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick this folder
4. Pin the extension and click the icon to see your stats

## What counts

| Site | Counted | Not counted |
| --- | --- | --- |
| `music.youtube.com` | every track | podcasts |
| `youtube.com` | videos YouTube classifies in the **Music** category, plus `- Topic` artist channels | everything else |

The category comes from YouTube's own metadata. The page's `<meta itemprop="genre">` tag is
only rendered on a full page load and is **not refreshed when you navigate in-page**, so it is
trusted only when the sibling `identifier` meta still matches the video on screen. Otherwise the
service worker looks the category up directly and caches the answer for 30 days.
| `open.spotify.com` | tracks | podcast / audiobook episodes |

Time only accrues while audio is genuinely playing — paused, muted, zero-volume and
finished playback are all ignored, and two tabs playing at once are counted once, not twice.

The **play count** (the `3×` badge) is separate from time: a song earns a play only once you
have listened to **half of it**. Pausing keeps that progress; skipping to the next song throws
it away, so flicking through a playlist adds no plays. Replaying a song from the start earns
another one. Where the track length cannot be read — a live stream, an older Spotify layout —
a flat minute of listening counts instead.

## Opening a song

Clicking a row opens that song in the tab you already have for its service — your open
Spotify or YouTube tab is reused and brought to the front, and a new tab is only created when
there isn't one. That is what the `host_permissions` for the three sites are for.

Cmd-click (Ctrl-click on Windows/Linux) or middle-click opens the song in a **new background
tab** instead and leaves the popup open, so you can queue several up; add Shift to jump
straight to it.

## Favorites

Every row in **Top tracks** and **Favorites** has a star. Click it to keep that song in the
**Favorites** section, which is ordered from most played to least played (listening time breaks
a tie, then the most recently starred). A starred song is never dropped when old tracks are
pruned, and **Reset** leaves favorites alone — they are stored separately, under `favorites`.

## Known limits

- **The Spotify desktop app is invisible to any Chrome extension.** Only the web player
  (`open.spotify.com`) is tracked. Covering the desktop app would require the Spotify Web API
  with an OAuth login.
- YouTube's Music category is a heuristic: a music-category video you watched for the visuals
  still counts, and a song inside a vlog does not. Videos that merely *contain* licensed music
  (a gaming video with a backing track) are deliberately not counted — only the category decides.
- A listening stretch is recognised within ~5 seconds of starting, so each session can
  under-count by a few seconds.

## Layout

```
manifest.json      MV3 manifest
background.js      service worker: aggregates ticks into chrome.storage.local
content/common.js  shared heartbeat: turns probes into elapsed-time ticks
content/youtube.js youtube.com adapter (music-category detection)
content/ytmusic.js music.youtube.com adapter
content/spotify.js open.spotify.com adapter
popup.html/.css/.js  stats UI
```

Data lives in `chrome.storage.local` under `stats` (and starred songs under `favorites`) and
never leaves your machine. The **Reset** button in the popup erases the stats; favorites stay
until you unstar them.
