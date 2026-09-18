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
function bestTab(tabs, windowId) {
  return tabs.slice().sort((a, b) => (
    (a.windowId === windowId ? 0 : 1) - (b.windowId === windowId ? 0 : 1) ||
    (a.active ? 0 : 1) - (b.active ? 0 : 1) ||
    (b.lastAccessed || 0) - (a.lastAccessed || 0)
  ))[0];
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

  const max = entries[0][1];
  list.innerHTML = entries.map(([source, seconds]) => `
    <li>
      <div class="row">
        <span>${SOURCE_NAMES[source] || source}</span>
        <span>${formatDuration(seconds)}</span>
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

function render(stats) {
  const days = stats.days || {};
  const favorites = stats.favorites || {};
  document.getElementById('today-value').textContent = formatDuration(sumLastDays(days, 1));
  document.getElementById('week-value').textContent = formatDuration(sumLastDays(days, 7));
  document.getElementById('month-value').textContent = formatDuration(sumLastDays(days, 30));
  document.getElementById('all-value').textContent = formatDuration(stats.total || 0);

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
  const stats = await chrome.runtime.sendMessage({ type: 'getStats' });
  render(stats || {});
}

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
