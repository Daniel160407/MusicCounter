# Music Counter

A Chrome extension that measures how much time you actually spend **listening to music** on
YouTube, YouTube Music and the Spotify web player.

## Install

1. Clone the repository:
   ```
   git clone https://github.com/Daniel160407/MusicCounter.git
   ```
2. Open `chrome://extensions`
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and pick the `MusicCounter` folder
5. Pin the extension and click the icon to see your stats

## Updating

1. Pull the latest changes:
   ```
   cd MusicCounter
   git pull
   ```
2. Open `chrome://extensions` and click the **reload icon** on the Music Counter card
   (no need to remove and re-add the extension)

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

## Achievements

The **Awards** tab lists 44 badges across listening time, single-day sessions, streaks, plays,
variety, favorites and milestones, each with a progress bar towards its goal. They are measured on the
merged numbers, so listening synced from your other devices counts too. A badge earned since
you last opened the tab shows a count on the toolbar icon and a **New** tag. Earned badges are
stored under `achievements` and, like favorites, survive **Reset**.

The definitions live in `achievements.js`; the iOS app mirrors them in `Achievements.swift`,
so keep ids and goals in step when adding one.

## Sync with the iOS app

Signed in with Google, the extension and the [iOS app](https://github.com/Daniel160407/MusicCounterIOS)
share one set of numbers through Firebase (Cloud Firestore). Each device uploads only its own
listening, so nothing is double counted, and every device shows **everything combined**: totals,
the by-service split (the phone appears as **iPhone**), top tracks and artists, the charts and
the play history. **Favorites** and the **Keep history for** setting are shared as well.

Uploads happen whenever the music stops (paused, muted, or its tab closed), and an upload that
fails offline is retried every minute until it goes through. Other devices are checked every two
minutes, and every 20 seconds while the popup is open. **Refresh** syncs at once. **Reset**
erases only this browser's share; the other devices keep theirs. Clicking an iPhone song opens
a YouTube Music search for it, since no web page can reach the phone's library.

Sync is off, and the bar at the bottom of the popup hidden, until you set it up:

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com).
2. **Build → Firestore Database → Create database** (production mode). Under **Rules**, paste
   [`firestore.rules`](firestore.rules) and publish.
3. **Build → Authentication → Sign-in method** → enable **Google**.
4. **Project settings → General → Your apps** → add a **Web** app. Copy its `apiKey` and
   `projectId` into [`firebase-config.js`](firebase-config.js).
5. **Authentication → Sign-in method → Google → Web SDK configuration**: copy the **Web client
   ID** into `firebase-config.js` as `googleClientId`.
6. In [Google Cloud console](https://console.cloud.google.com/auth/clients) for the same project,
   open that web client (named "Web client (auto created by Google Service)") and add
   `https://<extension-id>.chromiumapp.org/` under **Authorized redirect URIs**. The extension ID
   is on its card in `chrome://extensions`.
7. Reload the extension and click **Sign in** at the bottom of the popup.

An unpacked extension keeps the same ID as long as it is loaded from the same folder. Load it
from somewhere else and the ID changes, so add the new redirect URI as well. Sign-in uses
`chrome.identity.launchWebAuthFlow` rather than `getAuthToken`, because Google rejects the
latter's flow for newly created Chrome-extension OAuth clients.

Firestore layout (the iOS app reads and writes the same):

```
users/{uid}                              historyRetention, settingsUpdatedAt, favoritesUpdatedAt
users/{uid}/favorites/{key}              key, id, title, artist, source, addedAt
users/{uid}/devices/{deviceId}           platform, name, updatedAt, total, firstSeen, sources, parts
users/{uid}/devices/{deviceId}/parts/{n} json — tracks, artists, days-YYYY, history-YYYY-MM-N
```

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
achievements.js    achievement definitions and the metrics they are measured by
sync.js            Firebase sync: Google sign-in, Firestore over REST, merging other devices
firebase-config.js your Firebase project's apiKey and projectId
firestore.rules    Firestore security rules to paste into the console
```

Data lives in `chrome.storage.local` under `stats` (and starred songs under `favorites`). It
never leaves your machine unless you sign in to sync. The **Reset** button in the popup erases the stats; favorites stay
until you unstar them.
