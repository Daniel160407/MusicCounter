// Playlists that mix YouTube, YouTube Music and Spotify songs, played one after
// another across their tabs. Loaded into the service worker by background.js,
// after live.js (which opens the songs).
//
// Stored under `playlists` (id -> { id, name, tracks, createdAt, updatedAt }),
// each track { source, id, title, artist }. Like favorites they are a choice the
// user made, so Reset leaves them alone, and sync.js shares them with the phone:
//
//   users/{uid}/playlists/{id}   id, name, tracks, createdAt, updatedAt
//
// Playing: the worker opens a song in its service's tab (live.js's openSong) and
// asks that page to watch it. The page reports back when the song finished — or
// when you moved on to something else, which stops the playlist rather than
// skipping through it — and the worker opens the next one, in whichever tab its
// service lives. What is being played is kept in session storage so a worker
// restart mid-song picks up where it was.

const MAX_PLAYLISTS = 100;
const MAX_PLAYLIST_TRACKS = 500;
const MAX_PLAYLIST_NAME = 80;
const PLAYLIST_SOURCES = ['youtube', 'ytmusic', 'spotify', 'ios'];

async function loadPlaylists() {
  return (await chrome.storage.local.get('playlists')).playlists || {};
}

function playlistTrack(track) {
  const t = track || {};
  return {
    source: PLAYLIST_SOURCES.includes(t.source) ? t.source : 'youtube',
    id: String(t.id || ''),
    title: String(t.title || '').trim(),
    artist: String(t.artist || '').trim(),
  };
}

// Built the way the stats key their tracks, so "already in this playlist" means
// the same song the lists show.
function playlistTrackKey(track) {
  return `${track.source}:${track.id || track.title}`;
}

function playlistName(name) {
  return String(name || '').trim().slice(0, MAX_PLAYLIST_NAME) || 'Untitled playlist';
}

// --- Editing -------------------------------------------------------------------
//
// Every edit runs on background.js's queue, and is recorded for sync there.

async function savePlaylist(playlist) {
  const playlists = await loadPlaylists();
  if (playlist.deleted) delete playlists[playlist.id];
  else playlists[playlist.id] = playlist;
  await chrome.storage.local.set({ playlists });
  await notePlaylistChange(playlist.id, playlist.deleted ? null : playlist);
}

async function createPlaylist(msg) {
  const playlists = await loadPlaylists();
  if (Object.keys(playlists).length >= MAX_PLAYLISTS) {
    return { error: `You can keep up to ${MAX_PLAYLISTS} playlists.` };
  }
  const now = Date.now();
  const playlist = {
    id: crypto.randomUUID(),
    name: playlistName(msg.name),
    tracks: msg.track ? [playlistTrack(msg.track)] : [],
    createdAt: now,
    updatedAt: now,
  };
  await savePlaylist(playlist);
  return { playlist };
}

// `change` edits a copy and returns false to leave the stored one untouched.
async function changePlaylist(id, change) {
  const stored = (await loadPlaylists())[id];
  if (!stored) return { error: 'That playlist no longer exists.' };
  const playlist = { ...stored, tracks: stored.tracks.slice() };
  const result = change(playlist);
  if (result && result.error) return result;
  if (result === false) return { playlist: stored };
  playlist.updatedAt = Date.now();
  await savePlaylist(playlist);
  return { playlist, ...(result || {}) };
}

function renamePlaylist(msg) {
  return changePlaylist(msg.id, (p) => {
    const name = playlistName(msg.name);
    if (name === p.name) return false;
    p.name = name;
    return undefined;
  });
}

async function deletePlaylist(msg) {
  const stored = (await loadPlaylists())[msg.id];
  if (!stored) return { ok: true };
  const player = await loadPlaylistPlayer();
  if (player && player.playlistId === msg.id) await stopPlaylist({ pause: false });
  await savePlaylist({ id: msg.id, deleted: true });
  return { ok: true };
}

function addToPlaylist(msg) {
  const track = playlistTrack(msg.track);
  if (!track.title && !track.id) return { error: 'Nothing to add.' };
  return changePlaylist(msg.id, (p) => {
    const key = playlistTrackKey(track);
    if (p.tracks.some((t) => playlistTrackKey(t) === key)) return { duplicate: true, error: `Already in ${p.name}.` };
    if (p.tracks.length >= MAX_PLAYLIST_TRACKS) return { error: `A playlist holds up to ${MAX_PLAYLIST_TRACKS} songs.` };
    p.tracks.push(track);
    return undefined;
  });
}

function removeFromPlaylist(msg) {
  return changePlaylist(msg.id, (p) => {
    const index = Number(msg.index);
    if (!(index >= 0 && index < p.tracks.length)) return false;
    p.tracks.splice(index, 1);
    return undefined;
  });
}

function moveInPlaylist(msg) {
  return changePlaylist(msg.id, (p) => {
    const from = Number(msg.from);
    const to = Number(msg.to);
    if (!(from >= 0 && from < p.tracks.length && to >= 0 && to < p.tracks.length) || from === to) return false;
    const [track] = p.tracks.splice(from, 1);
    p.tracks.splice(to, 0, track);
    return undefined;
  });
}

// --- Adding by link --------------------------------------------------------------
//
// A pasted YouTube, YouTube Music or Spotify link. The title comes from the
// site's public oEmbed endpoint, which needs no sign-in; offline, the song is
// still added under its id and plays fine, since the link is what opens it.

function parseSongLink(text) {
  let url;
  try {
    url = new URL(String(text || '').trim());
  } catch (err) {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return YT_ID.test(id) ? { source: 'youtube', id } : null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const shorts = url.pathname.match(/^\/shorts\/([\w-]+)/);
    const id = shorts ? shorts[1] : url.searchParams.get('v') || '';
    if (!YT_ID.test(id)) return null;
    return { source: host === 'music.youtube.com' ? 'ytmusic' : 'youtube', id };
  }
  if (host === 'open.spotify.com') {
    // Localised links carry a prefix: /intl-de/track/{id}.
    const match = url.pathname.match(/\/track\/([A-Za-z0-9]+)/);
    return match && SPOTIFY_ID.test(match[1]) ? { source: 'spotify', id: match[1] } : null;
  }
  return null;
}

async function resolveSongLink(text) {
  const link = parseSongLink(text);
  if (!link) return { error: 'Paste a link to a YouTube, YouTube Music or Spotify song.' };
  const track = { ...link, title: link.id, artist: '' };
  const page = link.source === 'spotify'
    ? `https://open.spotify.com/track/${link.id}`
    : `https://www.youtube.com/watch?v=${link.id}`;
  const endpoint = link.source === 'spotify'
    ? `https://open.spotify.com/oembed?url=${encodeURIComponent(page)}`
    : `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(page)}`;
  try {
    const res = await fetch(endpoint, { credentials: 'omit' });
    if (res.ok) {
      const data = await res.json();
      if (data.title) track.title = String(data.title);
      // Spotify's answer names the track only; YouTube's names the channel.
      if (link.source !== 'spotify' && data.author_name) track.artist = String(data.author_name).replace(/ - Topic$/, '');
    }
  } catch (err) {
    // Offline: keep the id as the title.
  }
  return { track };
}

// --- Playing -------------------------------------------------------------------

async function loadPlaylistPlayer() {
  return (await chrome.storage.session.get('playlistPlayer')).playlistPlayer || null;
}

async function savePlaylistPlayer(player) {
  if (player) await chrome.storage.session.set({ playlistPlayer: player });
  else await chrome.storage.session.remove('playlistPlayer');
}

// Where the song being played sits now: the playlist may have been edited (here
// or on the phone) since it started, so its position is looked up again.
function playerIndex(player, playlist) {
  const at = playlist.tracks.findIndex((t, i) => i === player.index && playlistTrackKey(t) === player.key);
  if (at >= 0) return at;
  const found = playlist.tracks.findIndex((t) => playlistTrackKey(t) === player.key);
  return found >= 0 ? found : -1;
}

function unwatch(tabId) {
  if (tabId === null || tabId === undefined) return;
  chrome.tabs.sendMessage(tabId, { type: 'playlistUnwatch' }).catch(() => {});
}

async function playPlaylist(msg) {
  const playlist = (await loadPlaylists())[msg.id];
  const index = Math.max(0, Math.floor(Number(msg.index) || 0));
  if (!playlist || index >= playlist.tracks.length) {
    await stopPlaylist({ pause: false });
    return { ok: false };
  }
  const track = playlist.tracks[index];
  const before = await loadPlaylistPlayer();
  // Each song gets its own token, so a report from a page that has since been
  // replaced — or from a playlist that was restarted — is ignored.
  const token = crypto.randomUUID();
  const tabId = before ? before.tabId : null;
  // No tab while the song opens, so closing the previous one doesn't end the playlist.
  await savePlaylistPlayer({ playlistId: playlist.id, index, key: playlistTrackKey(track), tabId: null, token });
  unwatch(tabId);

  // Played where it is: its tab only comes forward if the song won't start unseen.
  const opened = await openSong(track, { preferTabId: tabId, activate: false });
  const now = await loadPlaylistPlayer();
  if (!now || now.token !== token) return { ok: true }; // Skipped or stopped meanwhile.
  if (opened === null) {
    await savePlaylistPlayer(null);
    return { ok: false };
  }
  await savePlaylistPlayer({ ...now, tabId: opened });
  try {
    await chrome.tabs.sendMessage(opened, { type: 'playlistWatch', token });
  } catch (err) {
    // The tab's script is older than this version; the song plays but won't hand over.
  }
  startLive();
  return { ok: true };
}

// Not awaited by the callers: opening a song takes a few seconds.
function startPlaylist(id, index) {
  playPlaylist({ id, index }).catch(() => {});
}

async function stepPlaylist(delta) {
  const player = await loadPlaylistPlayer();
  if (!player) return false;
  const playlist = (await loadPlaylists())[player.playlistId];
  if (!playlist) {
    await savePlaylistPlayer(null);
    return false;
  }
  const at = playerIndex(player, playlist);
  // A removed song: what took its place is the next one.
  const base = at >= 0 ? at : player.index - (delta > 0 ? 1 : 0);
  startPlaylist(playlist.id, Math.max(0, base + delta));
  return true;
}

// Ends the playlist; `pause` also stops the song it was on.
async function stopPlaylist({ pause = true } = {}) {
  const player = await loadPlaylistPlayer();
  if (!player) return;
  await savePlaylistPlayer(null);
  unwatch(player.tabId);
  if (!pause || player.tabId === null) return;
  try {
    const reply = await chrome.tabs.sendMessage(player.tabId, { type: 'nowPlaying' });
    if (reply && reply.playing && !reply.playing.paused) {
      await chrome.tabs.sendMessage(player.tabId, { type: 'control', action: 'playPause' });
    }
  } catch (err) {
    // The tab is gone; nothing to pause.
  }
}

// The page's report: the song finished, so play the next one, or it was left
// for something else, so stop following the playlist.
async function playlistReport(msg, tabId) {
  const player = await loadPlaylistPlayer();
  if (!player || player.token !== msg.token || player.tabId !== tabId) return;
  if (msg.type === 'playlistLeft') {
    await savePlaylistPlayer(null);
    return;
  }
  const playlist = (await loadPlaylists())[player.playlistId];
  if (!playlist) {
    await savePlaylistPlayer(null);
    return;
  }
  const at = playerIndex(player, playlist);
  startPlaylist(playlist.id, at >= 0 ? at + 1 : player.index);
}

// For the popup and the phone: which playlist is playing and how far along it is.
async function playlistStatus() {
  const player = await loadPlaylistPlayer();
  if (!player) return null;
  const playlist = (await loadPlaylists())[player.playlistId];
  if (!playlist) return null;
  const at = playerIndex(player, playlist);
  return {
    id: playlist.id,
    name: playlist.name,
    index: at >= 0 ? at : player.index,
    count: playlist.tracks.length,
    tabId: player.tabId,
  };
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const player = await loadPlaylistPlayer();
  if (player && player.tabId === tabId) await savePlaylistPlayer(null);
});
