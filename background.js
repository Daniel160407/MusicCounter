// Aggregates listening ticks from the content scripts into chrome.storage.local.

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

async function setHistoryRetention(msg) {
  const retention = Object.prototype.hasOwnProperty.call(RETENTION_MS, msg.retention)
    ? msg.retention
    : 'forever';
  const settings = await loadSettings();
  settings.historyRetention = retention;
  const history = pruneHistory(await loadHistory(), retention);
  await chrome.storage.local.set({ settings, history });
  return { settings, history };
}

async function toggleFavorite(msg) {
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

  const artist = (msg.artist || '').trim();
  if (artist) {
    const entry = stats.artists[artist] || { seconds: 0, source };
    entry.seconds += span;
    // Remember the most recent service, so the popup can link to the right one.
    entry.source = source;
    stats.artists[artist] = entry;
  }

  const title = (msg.title || '').trim();
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'tick') {
    queue = queue.then(() => recordTick(msg)).catch(() => {});
    return false;
  }

  if (msg && msg.type === 'classifyVideo') {
    classifyVideo(msg.videoId).then((music) => sendResponse({ music })).catch(() => sendResponse({ music: false }));
    return true;
  }

  if (msg && msg.type === 'getStats') {
    queue = queue
      .then(async () => ({
        ...(await loadStats()),
        favorites: await loadFavorites(),
        history: await loadHistory(),
        settings: await loadSettings(),
      }))
      .then((stats) => sendResponse(stats))
      .catch(() => sendResponse(emptyStats()));
    return true;
  }

  if (msg && msg.type === 'toggleFavorite') {
    queue = queue
      .then(() => toggleFavorite(msg))
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ favorite: false }));
    return true;
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
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  return false;
});
