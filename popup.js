const SOURCE_NAMES = {
  ytmusic: 'YouTube Music',
  youtube: 'YouTube',
  spotify: 'Spotify',
};

function formatDuration(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function dayKey(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function sumLastDays(days, count) {
  let total = 0;
  const cursor = new Date();
  for (let i = 0; i < count; i++) {
    const entry = days[dayKey(cursor)];
    if (entry) total += entry.total;
    cursor.setDate(cursor.getDate() - 1);
  }
  return total;
}

const YT_ID = /^[\w-]{11}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

// Where a track row should take you: straight to the track when we captured a
// usable id, otherwise a search on the service it was played on.
function trackUrl(track) {
  const id = track.id || '';
  const query = encodeURIComponent([track.artist, track.title].filter(Boolean).join(' '));

  if (track.source === 'spotify') {
    return SPOTIFY_ID.test(id)
      ? `https://open.spotify.com/track/${id}`
      : `https://open.spotify.com/search/${query}`;
  }
  if (track.source === 'ytmusic') {
    return YT_ID.test(id)
      ? `https://music.youtube.com/watch?v=${id}`
      : `https://music.youtube.com/search?q=${query}`;
  }
  return YT_ID.test(id)
    ? `https://www.youtube.com/watch?v=${id}`
    : `https://www.youtube.com/results?search_query=${query}`;
}

function artistUrl(name, source) {
  const query = encodeURIComponent(name);
  if (source === 'spotify') return `https://open.spotify.com/search/${query}`;
  if (source === 'ytmusic') return `https://music.youtube.com/search?q=${query}`;
  return `https://www.youtube.com/results?search_query=${query}`;
}

// Which tabs count as "the tab for this service". YouTube proper covers both
// the desktop and mobile hosts; music.youtube.com is a service of its own.
const SERVICE_TABS = {
  spotify: ['https://open.spotify.com/*'],
  ytmusic: ['https://music.youtube.com/*'],
  youtube: ['https://www.youtube.com/*', 'https://m.youtube.com/*'],
};

function sourceOf(url) {
  if (url.includes('open.spotify.com')) return 'spotify';
  if (url.includes('music.youtube.com')) return 'ytmusic';
  return 'youtube';
}

// Of the candidate tabs, the one the user would think of as "the YouTube tab":
// this window before another, the foreground tab before a buried one, and the
// most recently looked at before the rest.
function byRelevance(windowId) {
  return (a, b) => (
    (a.windowId === windowId ? 0 : 1) - (b.windowId === windowId ? 0 : 1) ||
    (a.active ? 0 : 1) - (b.active ? 0 : 1) ||
    (b.lastAccessed || 0) - (a.lastAccessed || 0)
  );
}

function bestTab(tabs, windowId) {
  return tabs.slice().sort(byRelevance(windowId))[0];
}

const MUSIC_TABS = [
  ...SERVICE_TABS.spotify,
  ...SERVICE_TABS.ytmusic,
  ...SERVICE_TABS.youtube,
];

// What is playing *right now*, asked of the pages themselves. Every music tab
// answers from a fresh look at its own player, so a paused or closed tab simply
// stops answering and the row disappears at once.
async function queryNowPlaying() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: MUSIC_TABS });
  } catch (err) {
    return null;
  }
  if (tabs.length === 0) return null;

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const ordered = tabs.slice().sort(byRelevance(active ? active.windowId : chrome.windows.WINDOW_ID_NONE));

  const replies = await Promise.all(ordered.map(async (tab) => {
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, { type: 'nowPlaying' });
      // Remember which tab answered: clicking the row should go to the tab the
      // sound is coming from, not open the song somewhere else.
      return reply && reply.playing ? { ...reply.playing, tabId: tab.id } : null;
    } catch (err) {
      // No content script in that tab (injected before the last reload, or the
      // tab is still loading); nothing to report.
      return null;
    }
  }));

  // Two tabs can play at once; show the one the user would call theirs.
  return replies.find(Boolean) || null;
}

// Cmd/Ctrl-click and middle-click mean "new tab" everywhere else in the
// browser, so they mean it here too.
function wantsNewTab(event) {
  return Boolean(event) && (event.metaKey || event.ctrlKey || event.button === 1);
}

async function openUrl(url, event) {
  if (wantsNewTab(event)) {
    // Matching the browser: the new tab opens in the background (foreground
    // when Shift is held) and the popup stays open, so several songs can be
    // queued up in one go.
    const active = Boolean(event.shiftKey);
    await chrome.tabs.create({ url, active });
    if (active) window.close();
    return;
  }

  try {
    const tabs = await chrome.tabs.query({ url: SERVICE_TABS[sourceOf(url)] });
    if (tabs.length > 0) {
      const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = bestTab(tabs, current ? current.windowId : chrome.windows.WINDOW_ID_NONE);
      await chrome.tabs.update(tab.id, { url, active: true });
      // The tab may live in another window; bring that window forward too.
      if (!current || tab.windowId !== current.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      window.close();
      return;
    }
  } catch (err) {
    // No permission yet, or the tab vanished between the query and the update:
    // fall through and just open a new one.
  }

  await chrome.tabs.create({ url });
  window.close();
}

function renderSources(stats) {
  const list = document.getElementById('sources');
  const entries = Object.entries(stats.sources || {})
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) {
    list.innerHTML = '<li class="empty">Nothing recorded yet.</li>';
    return;
  }

  // Plays are recorded per track, so the per-service figure is their sum. Only
  // tracks that were listened at least halfway ever counted a play.
  const plays = {};
  for (const track of Object.values(stats.tracks || {})) {
    plays[track.source] = (plays[track.source] || 0) + (track.plays || 0);
  }

  const max = entries[0][1];
  // The share is of listening time across the services, so the figures add up
  // to 100% however many of them you use.
  const total = entries.reduce((sum, [, seconds]) => sum + seconds, 0);
  list.innerHTML = entries.map(([source, seconds]) => `
    <li>
      <div class="row">
        <span>${SOURCE_NAMES[source] || source}<span class="share">${Math.round((seconds / total) * 100)}%</span></span>
        <span>${plays[source] ? `<span class="count">${plays[source]} ${plays[source] === 1 ? 'song' : 'songs'}</span>` : ''}${formatDuration(seconds)}</span>
      </div>
      <div class="track"><div class="fill ${source}" style="width:${(seconds / max) * 100}%"></div></div>
    </li>
  `).join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderTop(elementId, entries, emptyText) {
  const list = document.getElementById(elementId);
  // The popup re-renders every couple of seconds; don't yank a scrolled list
  // back to the top while it is being read.
  const scroll = list.scrollTop;
  if (entries.length === 0) {
    list.innerHTML = `<li class="empty">${emptyText}</li>`;
    return;
  }
  list.innerHTML = entries.map(({ name, sub, seconds, plays, url, key, favorite }, index) => `
    <li class="clickable" data-index="${index}" title="Open in ${escapeHtml(serviceOf(url))}">
      ${key ? `<button class="star${favorite ? ' on' : ''}" data-index="${index}"
        aria-pressed="${favorite ? 'true' : 'false'}"
        title="${favorite ? 'Remove from favorites' : 'Add to favorites'}">★</button>` : ''}
      <span class="name">${escapeHtml(name)}${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</span>
      <span class="meta">
        ${plays ? `<span class="plays" title="${plays} play${plays === 1 ? '' : 's'}">${plays}×</span>` : ''}
        <span class="time">${formatDuration(seconds)}</span>
      </span>
    </li>
  `).join('');

  list.scrollTop = scroll;

  list.querySelectorAll('li.clickable').forEach((li) => {
    const open = (event) => {
      // The star sits inside the row; it has its own job.
      if (event.target.closest('button.star')) return;
      openUrl(entries[Number(li.dataset.index)].url, event);
    };
    li.addEventListener('click', open);
    // Chrome reports middle clicks as auxclick, never as click.
    li.addEventListener('auxclick', (event) => {
      if (event.button === 1) open(event);
    });
  });

  list.querySelectorAll('button.star').forEach((button) => {
    button.addEventListener('click', async (event) => {
      // The row itself opens the track; the star must not do that too.
      event.stopPropagation();
      const entry = entries[Number(button.dataset.index)];
      await chrome.runtime.sendMessage({
        type: 'toggleFavorite',
        key: entry.key,
        track: entry.track,
      });
      load();
    });
  });
}

function serviceOf(url) {
  return SOURCE_NAMES[sourceOf(url)];
}

// One row of the two track lists, carrying what the star needs to toggle it.
function trackRow(track, favorites) {
  return {
    key: track.key,
    name: track.title,
    sub: track.artist,
    seconds: track.seconds || 0,
    plays: track.plays || 0,
    url: trackUrl(track),
    favorite: Boolean(favorites[track.key]),
    track: { id: track.id || '', title: track.title, artist: track.artist, source: track.source },
  };
}

// The track the "now playing" row currently stands for, so its click handlers —
// attached once, not on every poll — always act on what is on screen.
let current = null;

function renderNowPlaying(stats) {
  const section = document.getElementById('now');
  const playing = stats.nowPlaying || null;

  if (!playing) {
    current = null;
    section.hidden = true;
    return;
  }

  // Keys are built exactly as the worker builds them, so the star here and the
  // star in the lists below toggle the same record.
  const key = `${playing.source}:${playing.id || playing.title}`;
  const favorite = Boolean((stats.favorites || {})[key]);
  current = { ...playing, key, favorite };

  document.getElementById('now-title').textContent = playing.title;
  const artist = document.getElementById('now-artist');
  artist.textContent = playing.artist || '';
  // A plain `hidden` would lose to the stylesheet's display:block.
  artist.style.display = playing.artist ? '' : 'none';

  document.getElementById('now-pulse').className = `pulse ${playing.source}`;
  document.getElementById('now-row').title = `Go to the ${SOURCE_NAMES[playing.source] || playing.source} tab playing this`;

  const star = document.getElementById('now-star');
  star.classList.toggle('on', favorite);
  star.setAttribute('aria-pressed', favorite ? 'true' : 'false');
  star.title = favorite ? 'Remove from favorites' : 'Add to favorites';

  section.hidden = false;
}

function render(stats) {
  const days = stats.days || {};
  const favorites = stats.favorites || {};
  document.getElementById('today-value').textContent = formatDuration(sumLastDays(days, 1));
  document.getElementById('week-value').textContent = formatDuration(sumLastDays(days, 7));
  document.getElementById('month-value').textContent = formatDuration(sumLastDays(days, 30));
  document.getElementById('all-value').textContent = formatDuration(stats.total || 0);

  renderNowPlaying(stats);
  renderSources(stats);

  const artists = Object.entries(stats.artists || {})
    // Entries written by an older version are bare numbers.
    .map(([name, value]) => (
      typeof value === 'number'
        ? { name, seconds: value, source: 'youtube' }
        : { name, seconds: value.seconds, source: value.source }
    ))
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 5)
    .map(({ name, seconds, source }) => ({ name, sub: '', seconds, url: artistUrl(name, source) }));
  renderTop('artists', artists, 'No artists yet.');

  const played = Object.entries(stats.tracks || {})
    // Records written before ids were stored still carry one in the key.
    .map(([key, t]) => ({ key, ...t, id: t.id || key.slice(key.indexOf(':') + 1) }));

  const tracks = played
    .slice()
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 5)
    .map((t) => trackRow(t, favorites));
  renderTop('tracks', tracks, 'No tracks yet.');

  // A favourite the counters no longer know about — pruned, or erased by Reset —
  // falls back to the snapshot taken when it was starred, and shows zero plays.
  const byKey = new Map(played.map((t) => [t.key, t]));
  const favorited = Object.entries(favorites)
    .map(([key, fav]) => {
      const t = byKey.get(key) || {};
      return {
        key,
        id: t.id || fav.id || '',
        title: t.title || fav.title || '',
        artist: t.artist || fav.artist || '',
        source: t.source || fav.source || 'youtube',
        seconds: t.seconds || 0,
        plays: t.plays || 0,
        addedAt: fav.addedAt || 0,
      };
    })
    // Most played first; listening time then the newest star break the ties.
    .sort((a, b) => b.plays - a.plays || b.seconds - a.seconds || b.addedAt - a.addedAt)
    .map((t) => trackRow(t, favorites));
  renderTop('favorites', favorited, 'Star a track to keep it here.');

  const footer = document.getElementById('footer');
  footer.textContent = stats.firstSeen
    ? `Counting since ${new Date(stats.firstSeen).toLocaleDateString()}`
    : 'Play something on YouTube, YouTube Music or Spotify web.';
}

async function load() {
  const [stats, playing] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'getStats' }),
    queryNowPlaying(),
  ]);
  render({ ...(stats || {}), nowPlaying: playing });
}

const nowRow = document.getElementById('now-row');

// Go to the tab that is actually playing. Navigating it to the track's URL —
// what the list rows do — would restart the very song you are listening to.
async function focusPlayingTab() {
  try {
    const tab = await chrome.tabs.get(current.tabId);
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    window.close();
    return true;
  } catch (err) {
    // The tab closed between the poll and the click.
    return false;
  }
}

const openCurrent = async (event) => {
  if (!current || event.target.closest('button.star')) return;
  // A modifier still means "open it separately", as everywhere else.
  if (wantsNewTab(event) || !current.tabId) {
    openUrl(trackUrl(current), event);
    return;
  }
  if (!await focusPlayingTab()) openUrl(trackUrl(current), event);
};
nowRow.addEventListener('click', openCurrent);
nowRow.addEventListener('auxclick', (event) => {
  if (event.button === 1) openCurrent(event);
});

document.getElementById('now-star').addEventListener('click', async (event) => {
  event.stopPropagation();
  if (!current) return;
  await chrome.runtime.sendMessage({
    type: 'toggleFavorite',
    key: current.key,
    track: { id: current.id, title: current.title, artist: current.artist, source: current.source },
  });
  load();
});

const refreshButton = document.getElementById('refresh');

refreshButton.addEventListener('click', async () => {
  refreshButton.classList.add('busy');
  await load();
  // Brief flash so a click that changes nothing still feels like it did something.
  setTimeout(() => refreshButton.classList.remove('busy'), 200);
});

const confirmOverlay = document.getElementById('confirm');

function showConfirm(show) {
  confirmOverlay.hidden = !show;
  if (show) document.getElementById('confirm-cancel').focus();
}

document.getElementById('reset').addEventListener('click', () => showConfirm(true));
document.getElementById('confirm-cancel').addEventListener('click', () => showConfirm(false));

document.getElementById('confirm-erase').addEventListener('click', async () => {
  showConfirm(false);
  await chrome.runtime.sendMessage({ type: 'reset' });
  load();
});

// Clicking the backdrop or pressing Escape cancels, like any other dialog.
confirmOverlay.addEventListener('click', (event) => {
  if (event.target === confirmOverlay) showConfirm(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !confirmOverlay.hidden) showConfirm(false);
});

// Keep the numbers live while the popup is open; content scripts report every
// 5 seconds, so a 2 second poll never shows a stale figure for long.
const poll = setInterval(load, 2000);
window.addEventListener('unload', () => clearInterval(poll));

load();
