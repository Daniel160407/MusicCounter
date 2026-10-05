// What this browser is playing, shared with the phone, and the phone's
// previous / play-pause / next presses and volume changes carried back. Loaded into the service
// worker by background.js, after sync.js and tabs.js.
//
//   users/{uid}/live/{deviceId}      platform, name, updatedAt, track
//                                    track: source, id, title, artist, artwork, paused,
//                                           volume (0–maxVolume, null when the page can't tell),
//                                           maxVolume (2 where the page can be boosted past 100%, else 1),
//                                           playlist ({ id, name, index, count } while one plays, else null)
//                                           (null when nothing is loaded)
//   users/{uid}/commands/{deviceId}  command: { id, action, at }, written by the phone;
//                                    action 'volume' also carries value (0–2);
//                                    action 'open' also carries source, trackId, title, artist;
//                                    action 'playlist' also carries playlistId, index (0-based)
//
// The page's player is asked directly, the way the popup does it, every
// couple of seconds while something is loaded. A write only goes out when the
// track, the play state or the volume changes, plus a heartbeat
// while playing, so the phone can tell a closed browser from a quiet one.
// Firestore's REST API can't push, so the phone's presses are polled for:
// every few seconds while something is loaded, and every 30 seconds (the
// alarm) otherwise, so "Play on computer" works with nothing playing yet.

const LIVE_ALARM = 'live';
const LIVE_CHECK_MS = 1500;
const COMMAND_POLL_MS = 3000;
// A track paused this long polls less often, and after LIVE_PAUSED_LIMIT_MS not at all:
// the phone stops showing it then too.
const COMMAND_POLL_IDLE_MS = 15000;
const LIVE_IDLE_AFTER_MS = 5 * 60 * 1000;
const LIVE_PAUSED_LIMIT_MS = 30 * 60 * 1000;
const LIVE_HEARTBEAT_MS = 60 * 1000;
// The phone's clock and this one can disagree a little; older presses are dropped.
const COMMAND_MAX_AGE_MS = 2 * 60 * 1000;
const CONTROL_ACTIONS = ['prev', 'playPause', 'next'];
// How long a page opened for the phone has to load and start the song.
const OPEN_TIMEOUT_MS = 30 * 1000;
// A song opened without showing its tab gets this long to start there; Chrome
// may hold back media in a tab that isn't shown, so after that the tab is shown.
const BACKGROUND_START_MS = 12 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let liveRunning = false;
let liveTabId = null;

// What was last published, kept in session storage so a worker restart doesn't
// republish (and so extend the life of) a paused track the phone already has.
async function loadLiveMeta() {
  return (await chrome.storage.session.get('liveMeta')).liveMeta || null;
}

function liveKey(track) {
  return track ? `${track.source}:${track.id || track.title}` : '';
}

function liveTrack(playing, playlist) {
  return {
    source: playing.source,
    id: playing.id || '',
    title: playing.title || '',
    artist: playing.artist || '',
    artwork: playing.artwork || '',
    paused: Boolean(playing.paused),
    // Two decimals, so a slider dragged in the page writes once per step the
    // phone could show rather than on every pixel.
    volume: Number.isFinite(playing.volume) ? Math.round(playing.volume * 100) / 100 : null,
    maxVolume: playing.maxVolume || 1,
    // Only on the tab the playlist is playing in.
    playlist: playlist && playlist.tabId === playing.tabId
      ? { id: playlist.id, name: playlist.name, index: playlist.index, count: playlist.count }
      : null,
  };
}

function needsPublish(meta, track, now) {
  if (!meta) return true;
  if (!track || !meta.track) return Boolean(track) !== Boolean(meta.track);
  if (liveKey(track) !== liveKey(meta.track) || track.paused !== meta.track.paused) return true;
  if (track.volume !== (meta.track.volume ?? null)) return true;
  if (JSON.stringify(track.playlist || null) !== JSON.stringify(meta.track.playlist || null)) return true;
  return !track.paused && now - meta.publishedAt >= LIVE_HEARTBEAT_MS;
}

async function publishLive(auth, track, now) {
  const path = `${documentsRoot()}/users/${auth.uid}/live/${await getDeviceId()}`;
  await commit([{
    update: {
      name: path,
      fields: toFields({ platform: 'chrome', name: deviceName(), updatedAt: now, track }),
    },
  }]);
  const meta = await loadLiveMeta();
  const pausedSince = track && track.paused
    ? (meta && meta.track && meta.track.paused && liveKey(meta.track) === liveKey(track) ? meta.pausedSince : now)
    : null;
  await chrome.storage.session.set({ liveMeta: { track, publishedAt: now, pausedSince } });
}

// A song picked on the phone or next in a playlist: open it on its service, in
// that service's tab if there is one (`preferTabId` first, when it is one), and
// keep asking the page to start it until it plays. Whatever else was playing is
// paused so the two don't overlap. With `activate` false (a playlist's songs)
// the tab is left where it is, unless the song won't start there.
// Resolves to the tab, or null if it was closed.
async function openSong(song, { preferTabId = null, activate = true } = {}) {
  let url = trackUrl({
    source: song.source || 'ios',
    id: song.id || '',
    title: song.title || '',
    artist: song.artist || '',
  });
  // Spotify's track list, where the first row is a track, not an artist or album.
  if (url.startsWith('https://open.spotify.com/search/')) url += '/tracks';

  let tabId;
  try {
    const tabs = await chrome.tabs.query({ url: SERVICE_TABS[sourceOf(url)] });
    if (tabs.length > 0) {
      const preferred = tabs.find((tab) => tab.id === preferTabId);
      tabId = (preferred || bestTab(tabs, chrome.windows.WINDOW_ID_NONE)).id;
      await chrome.tabs.update(tabId, { url, ...(activate ? { active: true } : {}) });
    }
  } catch (err) {
    tabId = undefined;
  }
  if (tabId === undefined) tabId = (await chrome.tabs.create({ url, active: activate })).id;

  const playing = await queryNowPlaying();
  if (playing && !playing.paused && playing.tabId !== tabId) {
    chrome.tabs.sendMessage(playing.tabId, { type: 'control', action: 'playPause' }).catch(() => {});
  }

  // Give the navigation a moment to start, so the old page isn't the one asked.
  await sleep(1000);
  const deadline = Date.now() + OPEN_TIMEOUT_MS;
  const showAt = activate ? Infinity : Date.now() + BACKGROUND_START_MS;
  while (Date.now() < deadline) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (err) {
      return null; // Closed.
    }
    if (Date.now() >= showAt && !tab.active) {
      chrome.tabs.update(tabId, { active: true }).catch(() => {});
    }
    if (tab.status === 'complete') {
      try {
        const reply = await chrome.tabs.sendMessage(tabId, { type: 'autoplay' });
        if (reply && reply.result === 'done') return tabId;
      } catch (err) {
        // Content script not injected yet.
      }
    }
    await sleep(1000);
  }
  return tabId;
}

function openFromPhone(command) {
  return openSong({
    source: command.source || 'ios',
    id: command.trackId || '',
    title: command.title || '',
    artist: command.artist || '',
  });
}

// The phone's latest press: a song to open, or a button or volume for the tab being shown to it.
async function pollCommand(auth) {
  const doc = await firestore('GET', `${documentsRoot()}/users/${auth.uid}/commands/${await getDeviceId()}`);
  const command = doc ? fromFields(doc.fields).command : null;
  if (!command || !command.id) return false;

  const { liveCommandId } = await chrome.storage.local.get('liveCommandId');
  if (command.id === liveCommandId) return false;
  await chrome.storage.local.set({ liveCommandId: command.id });

  if (Math.abs(Date.now() - (command.at || 0)) > COMMAND_MAX_AGE_MS) return false;
  if (command.action === 'open') {
    // Not awaited: the page takes a while to load, and the checks carry on meanwhile.
    openFromPhone(command).catch(() => {});
    return true;
  }
  if (command.action === 'playlist') {
    startPlaylist(String(command.playlistId || ''), Number(command.index) || 0);
    return true;
  }
  if (liveTabId === null) return false;
  // While a playlist plays in that tab, its songs are what previous and next step through.
  if (command.action === 'prev' || command.action === 'next') {
    const playlist = await playlistStatus();
    if (playlist && playlist.tabId === liveTabId) {
      await stepPlaylist(command.action === 'next' ? 1 : -1);
      return true;
    }
  }
  let message;
  if (command.action === 'volume') {
    const value = Number(command.value);
    if (!Number.isFinite(value)) return false;
    // The page clamps to its own maximum.
    message = { type: 'control', action: 'volume', value: Math.max(0, Math.min(2, value)) };
  } else if (CONTROL_ACTIONS.includes(command.action)) {
    message = { type: 'control', action: command.action };
  } else {
    return false;
  }
  try {
    await chrome.tabs.sendMessage(liveTabId, message);
  } catch (err) {
    // The tab closed in between; the next check publishes that.
  }
  return true;
}

// Signing out: tell the phone nothing is playing here rather than leave the last
// track showing until it goes stale.
async function clearLive() {
  if (!(await liveSignedIn())) return;
  const meta = await loadLiveMeta();
  if (meta && !meta.track) return;
  await publishLive(await freshAuth(), null, Date.now());
}

async function liveSignedIn() {
  return syncConfigured() && Boolean(await loadAuth());
}

// Runs while something is loaded in a music tab; started by the content
// scripts' ticks, the alarm and the worker waking up. Safe to call any time;
// with nothing loaded it checks for a command once and stops.
async function startLive() {
  if (liveRunning || !(await liveSignedIn())) return;
  liveRunning = true;
  // Re-created when missing or left over from the minute-long period of an older version.
  chrome.alarms.get(LIVE_ALARM).then((alarm) => {
    if (!alarm || alarm.periodInMinutes !== 0.5) chrome.alarms.create(LIVE_ALARM, { periodInMinutes: 0.5 });
  });

  let nextPoll = 0;
  let emptyChecks = 0;
  try {
    for (;;) {
      const auth = await freshAuth();
      const now = Date.now();
      const playing = await queryNowPlaying();
      liveTabId = playing ? playing.tabId : null;
      const track = playing ? liveTrack(playing, await playlistStatus()) : null;

      // A tab still loading answers nothing; give it a second look before
      // telling the phone the music is gone.
      emptyChecks = track ? 0 : emptyChecks + 1;
      const meta = await loadLiveMeta();
      if ((track || emptyChecks >= 2) && needsPublish(meta, track, now)) await publishLive(auth, track, now);

      const latest = await loadLiveMeta();
      const pausedFor = latest && latest.pausedSince ? now - latest.pausedSince : 0;

      let ran = false;
      if (now >= nextPoll) {
        ran = await pollCommand(auth);
        nextPoll = now + (pausedFor >= LIVE_IDLE_AFTER_MS ? COMMAND_POLL_IDLE_MS : COMMAND_POLL_MS);
      }
      // A press lands on the page within a moment; look again soon after. (A song
      // being opened plays on its own; its page's ticks restart this if it stopped.)
      if (ran) {
        emptyChecks = 0;
        await sleep(500);
        continue;
      }
      if (!track && emptyChecks >= 2) break;
      if (track && track.paused && pausedFor >= LIVE_PAUSED_LIMIT_MS) break;
      await sleep(LIVE_CHECK_MS);
    }
  } catch (err) {
    // Offline or signed out mid-way; the alarm tries again in half a minute.
  } finally {
    liveRunning = false;
    liveTabId = null;
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LIVE_ALARM) startLive();
});

// The worker restarts often; pick up a track that was already loaded.
startLive();
