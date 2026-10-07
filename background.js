// Aggregates listening ticks from the content scripts into chrome.storage.local.

importScripts('firebase-config.js', 'sync.js', 'achievements.js', 'tabs.js', 'live.js', 'playlists.js');

function emptyStats() {
  return {
    total: 0,
    days: {},        // "YYYY-MM-DD" -> { total, youtube, ytmusic, spotify, hours }
                     // hours: 0-23 (local) -> { total, youtube, ytmusic, spotify }
    sources: {},     // source -> seconds
      artists: {},     // artist -> { seconds, source }
    tracks: {},      // key -> { id, title, artist, source, seconds, plays }
    firstSeen: null,
    // Wall-clock watermark. Two tabs playing at once can never double-count,
    // because only the part of a tick after this timestamp is credited.
    creditedUntil: 0,
  };
}

const MAX_ARTISTS = 800;
const MAX_TRACKS = 1500;
const MAX_FAVORITES = 300;

// History is one entry per counted play (see `newPlay` below), oldest first.
// MAX_HISTORY is a hard safety cap independent of the retention setting, so
// "Forever" can't grow the stored record without bound.
const MAX_HISTORY = 5000;
const RETENTION_MS = {
  week: 7 * 24 * 60 * 60 * 1000,
  '2weeks': 14 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  forever: 0,
};
const DEFAULT_SETTINGS = { historyRetention: 'forever' };

// Serialise read-modify-write so concurrent ticks can't clobber each other.
let queue = Promise.resolve();

// Runs `task` on the queue and hands back its result. Never call it from inside
// a task that is already on the queue: it would wait on itself.
function serialized(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

function dayKey(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfNextDay(ts) {
  const d = new Date(ts);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

function startOfNextHour(ts) {
  const d = new Date(ts);
  d.setMinutes(60, 0, 0);
  return d.getTime();
}

async function loadStats() {
  const stored = await chrome.storage.local.get('stats');
  // Merge onto a fresh template so a partial or missing record still has every
  // field, and so no two loads ever share the same nested objects.
  const stats = Object.assign(emptyStats(), stored.stats || {});
  // Artists used to be plain second counts; upgrade them in place so records
  // written by an older version keep working.
  for (const [name, value] of Object.entries(stats.artists)) {
    if (typeof value === 'number') stats.artists[name] = { seconds: value, source: 'youtube' };
  }
  return stats;
}

function prune(map, limit, valueOf, keep) {
  const keys = Object.keys(map);
  if (keys.length <= limit) return map;
  const kept = keys
    .sort((a, b) => valueOf(map[b]) - valueOf(map[a]))
    .slice(0, Math.floor(limit / 2));
  const next = {};
  for (const k of kept) next[k] = map[k];
  // A starred track survives however little it was played; otherwise marking an
  // old song a favourite would be the very thing that got its counts dropped.
  if (keep) for (const k of keys) if (keep[k] && !next[k]) next[k] = map[k];
  return next;
}

// Favourites live under their own storage key, not inside stats: they are a
// choice the user made, so pruning and Reset both leave them alone.
async function loadFavorites() {
  const stored = await chrome.storage.local.get('favorites');
  return stored.favorites || {};
}

async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  return Object.assign({}, DEFAULT_SETTINGS, stored.settings || {});
}

async function loadHistory() {
  const stored = await chrome.storage.local.get('history');
  return stored.history || [];
}

function pruneHistory(history, retention) {
  let next = history;
  const ms = RETENTION_MS[retention];
  if (ms) {
    const cutoff = Date.now() - ms;
    next = next.filter((entry) => entry.at >= cutoff);
  }
  if (next.length > MAX_HISTORY) next = next.slice(next.length - MAX_HISTORY);
  return next;
}

async function applyHistoryRetention(value) {
  const retention = Object.prototype.hasOwnProperty.call(RETENTION_MS, value) ? value : 'forever';
  const settings = await loadSettings();
  settings.historyRetention = retention;
  const history = pruneHistory(await loadHistory(), retention);
  await chrome.storage.local.set({ settings, history });
  return { settings, history };
}

async function setHistoryRetention(msg) {
  const result = await applyHistoryRetention(msg.retention);
  await noteRetentionChange(result.settings.historyRetention);
  return result;
}

// --- Achievements --------------------------------------------------------------
//
// Earned badges live under their own key, like favourites: Reset erases the
// numbers but not what they already earned. `unseen` drives the toolbar badge
// until the popup's Awards tab is opened.

async function loadAchievements() {
  const stored = await chrome.storage.local.get('achievements');
  return Object.assign({ unlocked: {}, unseen: [] }, stored.achievements || {});
}

function showAchievementBadge(unseen) {
  chrome.action.setBadgeText({ text: unseen.length ? String(unseen.length) : '' });
  if (unseen.length) chrome.action.setBadgeBackgroundColor({ color: '#b191ff' });
}

// The same chime the iOS app plays. A service worker can't play audio, so it
// goes through an offscreen page (Chrome closes it again once it falls silent).
async function playChime() {
  if (!chrome.offscreen) return;
  const url = chrome.runtime.getURL('offscreen.html');
  const open = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (!open.length) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Plays a chime when an achievement is unlocked or the daily goal is reached.',
    });
  }
  await chrome.runtime.sendMessage({ type: 'offscreen-play-sound', src: 'sounds/achievement.wav' });
}

// Must run on the queue: it read-modify-writes the stored record.
async function recordAchievements(stats, favorites, history) {
  const saved = await loadAchievements();
  const list = evaluateAchievements(stats, favorites, history, saved.unlocked);
  // Forget unseen badges that have since been retired, so they can't hold up the count.
  saved.unseen = saved.unseen.filter((id) => ACHIEVEMENTS.some((a) => a.id === id));
  const fresh = list.filter((a) => a.unlockedAt && !saved.unlocked[a.id]);
  // New badges, and once the badges that predate this, are dated from when the
  // listening actually reached them. Only ever moves a date earlier, so a badge
  // kept through Reset holds on to its original date.
  if (fresh.length || !saved.dated) {
    for (const a of fresh) saved.unlocked[a.id] = a.unlockedAt;
    const replayed = replayUnlockTimes(stats, history, favorites);
    for (const [id, at] of Object.entries(replayed)) {
      if (saved.unlocked[id] && at < saved.unlocked[id]) saved.unlocked[id] = at;
    }
    for (const a of list) if (saved.unlocked[a.id]) a.unlockedAt = saved.unlocked[a.id];
    saved.dated = true;
    saved.unseen = saved.unseen.concat(fresh.map((a) => a.id));
    await chrome.storage.local.set({ achievements: saved });
    if (fresh.length) {
      showAchievementBadge(saved.unseen);
      playChime().catch(() => {});
    }
  }
  return { list, unseen: saved.unseen };
}

// Checked on each new play, so a badge lights up without opening the popup.
async function checkAchievements() {
  const merged = await mergeRemote(await loadStats(), await loadHistory());
  await recordAchievements(merged.stats, await loadFavorites(), merged.history);
}

// --- Daily goal ----------------------------------------------------------------
//
// The goal grows with you: one hour more than you listened yesterday, on every
// device — the same goal the iOS app sets. Reaching it is announced once a day,
// with a notification and the achievement chime.

const DAILY_GOAL_BONUS = 60 * 60;
const GOAL_CHECK_MS = 30 * 1000;
let lastGoalCheck = 0;

function dailyGoal(days, now = Date.now()) {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const entry = (key) => (days[key] && days[key].total) || 0;
  return { today: entry(dayKey(now)), goal: entry(dayKey(yesterday.getTime())) + DAILY_GOAL_BONUS };
}

function goalDuration(seconds) {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m === 0 ? `${h}h` : `${h}h ${m}m`;
  return m > 0 ? `${m}m` : `${s}s`;
}

// Runs on the queue (from recordTick), throttled: ticks arrive every few seconds.
async function checkDailyGoal() {
  const now = Date.now();
  if (now - lastGoalCheck < GOAL_CHECK_MS) return;
  lastGoalCheck = now;

  const key = dayKey(now);
  const stored = await chrome.storage.local.get('dailyGoal');
  if (stored.dailyGoal && stored.dailyGoal.announced === key) return;

  const merged = await mergeRemote(await loadStats(), []);
  const { today, goal } = dailyGoal(merged.stats.days || {}, now);
  if (today < goal) return;

  await chrome.storage.local.set({ dailyGoal: { announced: key } });
  if (chrome.notifications) {
    chrome.notifications.create(`daily-goal-${key}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Daily goal reached',
      message: `You've listened ${goalDuration(today)} today — an hour more than yesterday.`,
      // The chime below is the sound, so the system one doesn't play over it.
      silent: true,
    });
  }
  playChime().catch(() => {});
}

// A click on the goal notification opens the popup, where the goal is shown.
if (chrome.notifications) {
  chrome.notifications.onClicked.addListener((id) => {
    if (!id.startsWith('daily-goal-')) return;
    chrome.notifications.clear(id);
    if (chrome.action.openPopup) chrome.action.openPopup().catch(() => {});
  });
}

async function markAchievementsSeen() {
  const saved = await loadAchievements();
  saved.unseen = [];
  await chrome.storage.local.set({ achievements: saved });
  showAchievementBadge([]);
}

async function toggleFavorite(msg) {
  const before = await loadFavorites();
  const result = await toggleFavoriteLocally(msg);
  await noteFavoriteChanges(before, await loadFavorites());
  return result;
}

async function toggleFavoriteLocally(msg) {
  const key = String((msg && msg.key) || '');
  if (!key) return { favorite: false };

  const favorites = await loadFavorites();
  if (favorites[key]) {
    delete favorites[key];
    await chrome.storage.local.set({ favorites });
    return { favorite: false };
  }

  // Store a snapshot so the row still reads properly if the track later falls
  // out of stats.tracks.
  const track = msg.track || {};
  favorites[key] = {
    id: track.id || '',
    title: track.title || '',
    artist: track.artist || '',
    source: track.source || 'youtube',
    addedAt: Date.now(),
  };

  const keys = Object.keys(favorites);
  if (keys.length > MAX_FAVORITES) {
    const next = {};
    for (const k of keys.sort((a, b) => favorites[b].addedAt - favorites[a].addedAt).slice(0, MAX_FAVORITES)) {
      next[k] = favorites[k];
    }
    await chrome.storage.local.set({ favorites: next });
    return { favorite: !!next[key] };
  }

  await chrome.storage.local.set({ favorites });
  return { favorite: true };
}

function addToDays(stats, source, from, to) {
  // Split across midnight so daily buckets stay honest.
  let cursor = from;
  while (cursor < to) {
    const boundary = Math.min(startOfNextDay(cursor), to);
    const key = dayKey(cursor);
    const day = stats.days[key] || { total: 0, youtube: 0, ytmusic: 0, spotify: 0, hours: {} };
    if (!day.hours) day.hours = {};

    // Further split this day's slice by hour, so the popup can show what a
    // single day looked like rather than only the all-time hourly shape.
    let hourCursor = cursor;
    while (hourCursor < boundary) {
      const hourBoundary = Math.min(startOfNextHour(hourCursor), boundary);
      const hourSeconds = (hourBoundary - hourCursor) / 1000;
      const hourKey = String(new Date(hourCursor).getHours());
      const hourEntry = day.hours[hourKey] || { total: 0, youtube: 0, ytmusic: 0, spotify: 0 };
      hourEntry.total += hourSeconds;
      hourEntry[source] = (hourEntry[source] || 0) + hourSeconds;
      day.hours[hourKey] = hourEntry;
      hourCursor = hourBoundary;
    }

    const seconds = (boundary - cursor) / 1000;
    day.total += seconds;
    day[source] = (day[source] || 0) + seconds;
    stats.days[key] = day;
    cursor = boundary;
  }
}

// Collaborations are often credited in the title rather than the channel —
// "Irina Rimes x Delia - Petale" on Irina Rimes's channel. Any artist already
// in the stats who appears in the title's credit part (the side of " - " that
// names the artist, or after "feat." / "ft." / "(with") is attached:
// "Irina Rimes, Delia", the same shape Spotify uses for several artists.
// Longer names win, so a known "Delia Matache" is not also read as "Delia".
const TITLE_DASH = /\s[-–—]\s/;
const TITLE_FEATURE = /(?:\bfeat\.?|\bft\.?|\bfeaturing|[([]\s*with)\s+([^)\]]+)/giu;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nameMatcher(name, flags = 'iu') {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, flags);
}

function withTitleArtists(artist, title, knownArtists) {
  const credited = artist ? artist.split(', ') : [];
  const regions = [];
  const dash = title.search(TITLE_DASH);
  if (dash > 0) {
    // Usually "Artists - Song", but "Song - Artists" exists too: take the side
    // that names the artist we already have.
    const head = title.slice(0, dash);
    const tail = title.slice(dash).replace(TITLE_DASH, '');
    const namesArtist = (side) => credited.some((c) => nameMatcher(c).test(side));
    regions.push(!namesArtist(head) && namesArtist(tail) ? tail : head);
  }
  for (const match of title.matchAll(TITLE_FEATURE)) regions.push(match[1]);
  if (!regions.length) return artist;

  const names = new Set();
  for (const key of knownArtists) {
    names.add(key.trim());
    for (const part of key.split(', ')) names.add(part.trim());
  }

  // Blank out the artists already credited so their names, or pieces of them,
  // can't match again; then each found name, longest first.
  let credits = regions.join(' | ');
  const blank = (name) => {
    const at = credits.search(nameMatcher(name));
    if (at >= 0) credits = credits.replace(nameMatcher(name, 'giu'), (m) => ' '.repeat(m.length));
    return at;
  };
  for (const name of credited) blank(name);

  const found = [];
  const candidates = [...names]
    .filter((n) => n.length >= 2 && !['unknown artist', '<unknown>', 'unknown'].includes(n.toLowerCase()))
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  for (const name of candidates) {
    if (credited.some((c) => nameMatcher(name).test(c))) continue;
    const at = blank(name);
    if (at >= 0) found.push({ name, at });
  }
  if (!found.length) return artist;

  found.sort((a, b) => a.at - b.at);
  return [...credited, ...found.map((f) => f.name)].join(', ');
}

async function recordTick(msg) {
  const stats = await loadStats();
  const now = Date.now();

  let from = Math.max(msg.from, stats.creditedUntil);
  const to = Math.min(msg.to, now);
  if (!(to > from)) return;

  stats.creditedUntil = to;
  if (stats.firstSeen === null) stats.firstSeen = from;

  const span = (to - from) / 1000;
  const source = ['youtube', 'ytmusic', 'spotify'].includes(msg.source) ? msg.source : 'youtube';

  addToDays(stats, source, from, to);
  stats.total += span;
  stats.sources[source] = (stats.sources[source] || 0) + span;

  const title = (msg.title || '').trim();
  const artist = withTitleArtists((msg.artist || '').trim(), title, Object.keys(stats.artists));
  if (artist) {
    const entry = stats.artists[artist] || { seconds: 0, source };
    entry.seconds += span;
    // Remember the most recent service, so the popup can link to the right one.
    entry.source = source;
    stats.artists[artist] = entry;
  }

  if (title) {
    const key = `${source}:${msg.id || title}`;
    const track = stats.tracks[key] || { id: msg.id || '', title, artist, source, seconds: 0, plays: 0 };
    track.id = msg.id || track.id || '';
    track.title = title;
    if (artist) track.artist = artist;
    track.seconds += span;
    if (msg.newPlay) track.plays = (track.plays || 0) + 1;
    stats.tracks[key] = track;
  }

  stats.artists = prune(stats.artists, MAX_ARTISTS, (v) => v.seconds);
  stats.tracks = prune(stats.tracks, MAX_TRACKS, (v) => v.seconds, await loadFavorites());

  await chrome.storage.local.set({ stats });

  // One row per counted play, not per tick, so scrubbing through a song
  // doesn't spam the history with duplicates.
  if (msg.newHistoryEntry && title) {
    const settings = await loadSettings();
    let history = await loadHistory();
    history.push({ id: msg.id || '', title, artist, source, artwork: (msg.artwork || '').trim(), at: to });
    history = pruneHistory(history, settings.historyRetention);
    await chrome.storage.local.set({ history });
  }

  if (msg.newPlay || msg.newHistoryEntry) await checkAchievements();
  await checkDailyGoal();
}


// --- YouTube category lookup -------------------------------------------------
//
// The watch page's <meta itemprop="genre"> tag is only rendered on a full page
// load. Arriving at a video through an in-page navigation (from search, the
// home feed, a related video) leaves it absent for good, so the content script
// asks us to classify those videos instead. We fetch the watch page — with
// hl=en so the category name is not localised, and without credentials so no
// cookies are sent — and read the category out of the embedded player data.

const CATEGORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CATEGORY_ENTRIES = 2000;

const pendingLookups = new Map();

async function loadCategoryCache() {
  const stored = await chrome.storage.local.get('ytCategories');
  return stored.ytCategories || {};
}

async function classifyVideo(videoId) {
  if (!/^[\w-]{5,20}$/.test(videoId)) return false;

  const cache = await loadCategoryCache();
  const hit = cache[videoId];
  if (hit && Date.now() - hit.at < CATEGORY_TTL_MS) return hit.music;

  if (pendingLookups.has(videoId)) return pendingLookups.get(videoId);

  const lookup = (async () => {
    let isMusic = false;
    try {
      const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
        credentials: 'omit',
      });
      const html = await res.text();
      const match = html.match(/"category":"([^"]+)"/);
      isMusic = match ? match[1] === 'Music' : false;

      const next = await loadCategoryCache();
      next[videoId] = { music: isMusic, at: Date.now() };
      const keys = Object.keys(next);
      if (keys.length > MAX_CATEGORY_ENTRIES) {
        // Drop the oldest half rather than growing without bound.
        const fresh = {};
        for (const k of keys.sort((a, b) => next[b].at - next[a].at).slice(0, MAX_CATEGORY_ENTRIES / 2)) {
          fresh[k] = next[k];
        }
        await chrome.storage.local.set({ ytCategories: fresh });
      } else {
        await chrome.storage.local.set({ ytCategories: next });
      }
    } catch (err) {
      // Offline or blocked: stay silent and let a later probe retry.
    } finally {
      pendingLookups.delete(videoId);
    }
    return isMusic;
  })();

  pendingLookups.set(videoId, lookup);
  return lookup;
}

// Playlist edits that answer the popup with their result; each runs on the queue.
const PLAYLIST_EDITS = {
  createPlaylist,
  renamePlaylist,
  deletePlaylist,
  addToPlaylist,
  removeFromPlaylist,
  moveInPlaylist,
};

// Pinning: a toolbar popup always closes when it loses focus, so "pinned" means
// the same page in a window of its own that stays until it is closed. While it
// is open the toolbar button brings it forward instead of opening a second copy.
const PINNED_KEY = 'pinnedWindowId';

async function pinnedWindowId() {
  const { [PINNED_KEY]: id } = await chrome.storage.session.get(PINNED_KEY);
  return typeof id === 'number' ? id : null;
}

async function unpinned() {
  await chrome.storage.session.remove(PINNED_KEY);
  await chrome.action.setPopup({ popup: 'popup.html' });
}

async function pinPopup() {
  const existing = await pinnedWindowId();
  if (existing !== null) {
    try {
      await chrome.windows.update(existing, { focused: true });
      return;
    } catch (err) {
      // Closed while the worker was asleep; open a fresh one.
    }
  }
  const win = await chrome.windows.create({
    url: 'popup.html?pinned=1',
    type: 'popup',
    width: 352,
    height: 640,
    focused: true,
  });
  await chrome.storage.session.set({ [PINNED_KEY]: win.id });
  await chrome.action.setPopup({ popup: '' });
}

chrome.action.onClicked.addListener(async () => {
  const id = await pinnedWindowId();
  try {
    if (id !== null) {
      await chrome.windows.update(id, { focused: true });
      return;
    }
  } catch (err) {
    // The window is gone; fall through.
  }
  await unpinned();
  // A click on a button with no popup can't open one, so reopen pinned.
  await pinPopup();
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  if (windowId === await pinnedWindowId()) await unpinned();
});

// Windows don't outlive the browser, so neither does a pin.
chrome.runtime.onStartup.addListener(() => { unpinned(); });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'pinPopup') {
    pinPopup().then(() => sendResponse({ ok: true }), (err) => sendResponse({ error: String(err) }));
    return true;
  }

  if (msg && msg.type === 'tick') {
    queue = queue.then(() => recordTick(msg)).catch(() => {});
    startLive();
    return false;
  }

  if (msg && msg.type === 'stopped') {
    startLive();
    // pushLocal reads the stats through the queue, so ticks already sent land first.
    runSync({ push: true });
    return false;
  }

  if (msg && msg.type === 'classifyVideo') {
    classifyVideo(msg.videoId).then((music) => sendResponse({ music })).catch(() => sendResponse({ music: false }));
    return true;
  }

  if (msg && msg.type === 'getStats') {
    pullIfStale();
    serialized(async () => ({
      stats: await loadStats(),
      history: await loadHistory(),
      favorites: await loadFavorites(),
      settings: await loadSettings(),
      playlists: await loadPlaylists(),
    }))
      // Merged outside the queue: it only reads the cached remote data.
      .then(async ({ stats, history, favorites, settings, playlists }) => {
        const merged = await mergeRemote(stats, history);
        const achievements = await serialized(() => recordAchievements(merged.stats, favorites, merged.history));
        return {
          ...merged.stats,
          history: merged.history,
          favorites,
          settings,
          achievements,
          playlists,
          playlistPlaying: await playlistStatus(),
          sync: await syncStatus(),
        };
      })
      .then((stats) => sendResponse(stats))
      .catch(() => sendResponse(emptyStats()));
    return true;
  }

  if (msg && msg.type === 'signIn') {
    signIn()
      .then(() => chrome.storage.local.remove('syncSignInError'))
      .then(() => sendResponse({ ok: true }))
      .catch(async (err) => {
        const error = String((err && err.message) || err);
        // Kept for the next popup: this one has usually closed behind Google's window.
        await chrome.storage.local.set({ syncSignInError: error });
        sendResponse({ ok: false, error });
      });
    return true;
  }

  if (msg && msg.type === 'signOut') {
    signOut().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg && msg.type === 'syncNow') {
    runSync({ push: true, pull: true }).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg && msg.type === 'seenAchievements') {
    serialized(markAchievementsSeen).catch(() => {});
    return false;
  }

  if (msg && msg.type === 'toggleFavorite') {
    queue = queue
      .then(() => toggleFavorite(msg))
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ favorite: false }));
    return true;
  }

  if (msg && Object.prototype.hasOwnProperty.call(PLAYLIST_EDITS, msg.type)) {
    serialized(() => PLAYLIST_EDITS[msg.type](msg))
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ error: 'Something went wrong; try again.' }));
    return true;
  }

  if (msg && msg.type === 'resolveSongLink') {
    resolveSongLink(msg.url).then((result) => sendResponse(result)).catch(() => sendResponse({ error: 'Could not read that link.' }));
    return true;
  }

  if (msg && msg.type === 'playPlaylist') {
    startPlaylist(msg.id, msg.index);
    return false;
  }

  if (msg && msg.type === 'stepPlaylist') {
    stepPlaylist(msg.delta > 0 ? 1 : -1).catch(() => {});
    return false;
  }

  if (msg && msg.type === 'stopPlaylist') {
    stopPlaylist().catch(() => {});
    return false;
  }

  // From the page holding a playlist's song: it finished, or was left.
  if (msg && (msg.type === 'playlistEnded' || msg.type === 'playlistLeft')) {
    playlistReport(msg, sender.tab ? sender.tab.id : null).catch(() => {});
    return false;
  }

  if (msg && msg.type === 'setHistoryRetention') {
    queue = queue
      .then(() => setHistoryRetention(msg))
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ settings: DEFAULT_SETTINGS, history: [] }));
    return true;
  }

  if (msg && msg.type === 'reset') {
    queue = queue
      .then(() => chrome.storage.local.set({ stats: emptyStats(), history: [] }))
      .then(() => {
        // Only this browser's share is erased; other devices keep theirs.
        runSync({ push: true });
        sendResponse({ ok: true });
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  return false;
});

// The toolbar badge doesn't survive a browser restart; put it back.
loadAchievements().then((saved) => showAchievementBadge(saved.unseen)).catch(() => {});
