const SOURCE_NAMES = {
  ytmusic: 'YouTube Music',
  youtube: 'YouTube',
  spotify: 'Spotify',
};

function formatDuration(seconds) {
  const totalMinutes = Math.round(seconds / 60);
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// Time on its own for today ("3:45 PM"), a date for anything older, with the
// year added only once it's no longer implied.
function formatWhen(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
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

// A small cover image for a play, when one can be had without asking any
// service for it. YouTube and YouTube Music expose thumbnails at a URL
// derived straight from the video id; Spotify has no such URL, so its
// artwork has to have been captured from the page when the track was
// recorded and carried along on the entry itself.
function trackThumbnail(track) {
  const id = track.id || '';
  if ((track.source === 'youtube' || track.source === 'ytmusic') && YT_ID.test(id)) {
    return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
  }
  if (track.source === 'spotify' && track.artwork) {
    return track.artwork;
  }
  return '';
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
// answers from a fresh look at its own player, so a closed tab simply stops
// answering and the row disappears at once. A paused tab still answers — the
// transport buttons need something to resume.
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

  // Two tabs can play at once; show the one the user would call theirs. A tab
  // that is only holding a paused track loses to one actually making sound,
  // however far down the list it sits.
  return replies.find((reply) => reply && !reply.paused) || replies.find(Boolean) || null;
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

// Adds a one-shot animation class and lets it clean itself up, rather than
// leaving the class around to silently block the next replay.
function flash(el, className) {
  el.classList.add(className);
  el.addEventListener('animationend', () => el.classList.remove(className), { once: true });
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
  list.innerHTML = entries.map(({ name, sub, seconds, plays, url, key, favorite, source }, index) => `
    <li class="clickable" data-index="${index}" title="Open in ${escapeHtml(serviceOf(url))}">
      ${key ? `<button class="star${favorite ? ' on' : ''}" data-index="${index}"
        aria-pressed="${favorite ? 'true' : 'false'}"
        title="${favorite ? 'Remove from favorites' : 'Add to favorites'}">★</button>` : ''}
      <span class="name">${escapeHtml(name)}${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</span>
      <span class="meta">
        ${plays ? `<span class="plays${source ? ` ${source}` : ''}" title="${plays} play${plays === 1 ? '' : 's'}">${plays}×</span>` : ''}
        <span class="time">${formatDuration(seconds)}</span>
      </span>
    </li>
  `).join('');

  list.scrollTop = scroll;

  list.querySelectorAll('li.clickable').forEach((li) => {
    const open = (event) => {
      // The star sits inside the row; it has its own job.
      if (event.target.closest('button')) return;
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
      flash(button, 'pop');
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

// Rendered from most to least recent; capped so a heavy history doesn't
// redraw thousands of rows on every 2-second poll.
const MAX_HISTORY_ROWS = 500;

// Which day the "All plays" list is showing, 0 = today. Same must-survive-
// the-poll reasoning as dayRange/hoursDayOffset above.
let historyDayOffset = 0;

function renderHistory(history) {
  const list = document.getElementById('history');
  const note = document.getElementById('history-note');
  const all = (history || []).slice().sort((a, b) => b.at - a.at);

  const day = dayForOffset(historyDayOffset);
  const key = dayKey(day);
  const entries = all.filter((entry) => dayKey(new Date(entry.at)) === key);

  document.getElementById('history-day-label').textContent = dayNavLabel(day);
  const oldest = all.length ? new Date(all[all.length - 1].at) : null;
  if (oldest) oldest.setHours(0, 0, 0, 0);
  document.getElementById('history-prev-day').disabled = !oldest || day <= oldest;
  document.getElementById('history-next-day').disabled = historyDayOffset <= 0;

  if (entries.length === 0) {
    list.innerHTML = '<li class="empty">Nothing played that day.</li>';
    note.textContent = '';
    return;
  }

  const shown = entries.slice(0, MAX_HISTORY_ROWS);
  const scroll = list.scrollTop;
  list.innerHTML = shown.map((entry, index) => {
    const thumb = trackThumbnail(entry);
    return `
    <li class="clickable" data-index="${index}" title="Open in ${escapeHtml(SOURCE_NAMES[entry.source] || entry.source)}">
      ${thumb
        ? `<img class="thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy">`
        : '<span class="thumb thumb-empty">♪</span>'}
      <span class="name">${escapeHtml(entry.title)}${entry.artist ? `<small>${escapeHtml(entry.artist)}</small>` : ''}</span>
      <span class="meta">
        <span class="plays ${entry.source}">${escapeHtml(SOURCE_NAMES[entry.source] || entry.source)}</span>
        <span class="when">${escapeHtml(formatWhen(entry.at))}</span>
      </span>
    </li>
  `;
  }).join('');
  list.scrollTop = scroll;

  // A thumbnail that 404s (a deleted video, a stale Spotify image URL) falls
  // back to the plain note-glyph placeholder rather than showing a broken
  // image icon.
  list.querySelectorAll('img.thumb').forEach((img) => {
    img.addEventListener('error', () => {
      const placeholder = document.createElement('span');
      placeholder.className = 'thumb thumb-empty';
      placeholder.textContent = '♪';
      img.replaceWith(placeholder);
    }, { once: true });
  });

  list.querySelectorAll('li.clickable').forEach((li) => {
    const entry = shown[Number(li.dataset.index)];
    const open = (event) => openUrl(trackUrl(entry), event);
    li.addEventListener('click', open);
    li.addEventListener('auxclick', (event) => {
      if (event.button === 1) open(event);
    });
  });

  note.textContent = entries.length > shown.length
    ? `Showing the most recent ${shown.length} of ${entries.length} plays that day.`
    : `${entries.length} play${entries.length === 1 ? '' : 's'} recorded that day.`;
}

const historyRetentionSelect = document.getElementById('history-retention');
historyRetentionSelect.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({ type: 'setHistoryRetention', retention: historyRetentionSelect.value });
  load();
});

document.getElementById('history-prev-day').addEventListener('click', () => {
  historyDayOffset += 1;
  load();
});
document.getElementById('history-next-day').addEventListener('click', () => {
  if (historyDayOffset <= 0) return;
  historyDayOffset -= 1;
  load();
});

// One row of the two track lists, carrying what the star needs to toggle it.
function trackRow(track, favorites) {
  return {
    key: track.key,
    name: track.title,
    sub: track.artist,
    seconds: track.seconds || 0,
    plays: track.plays || 0,
    source: track.source,
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

  const paused = Boolean(playing.paused);
  document.getElementById('now-pulse').className = `pulse ${playing.source}${paused ? ' paused' : ''}`;
  document.getElementById('now-row').title = paused
    ? `Go to the ${SOURCE_NAMES[playing.source] || playing.source} tab holding this`
    : `Go to the ${SOURCE_NAMES[playing.source] || playing.source} tab playing this`;

  // Only a tab whose content script offers the buttons gets them; an older
  // script left over from before a reload simply does not say it can.
  const transport = document.getElementById('now-transport');
  transport.hidden = !(playing.canControl && playing.tabId);
  setPlayPause(!paused);

  const star = document.getElementById('now-star');
  star.classList.toggle('on', favorite);
  star.setAttribute('aria-pressed', favorite ? 'true' : 'false');
  star.title = favorite ? 'Remove from favorites' : 'Add to favorites';

  section.hidden = false;
}

// --- Analytics ---------------------------------------------------------------
//
// Both charts are the same shape: a row of columns, each stacked out of the
// services that made it up, scaled against the tallest column rather than an
// absolute figure — the question they answer is "when", not "how much".

const CHART_SOURCES = ['ytmusic', 'youtube', 'spotify'];

function partsOf(entry) {
  const parts = {};
  for (const source of CHART_SOURCES) parts[source] = entry[source] || 0;
  return parts;
}

// The plot's own geometry, so the renderer can tell whether a segment has the
// room to carry its share as text before it writes one in.
const PLOT_WIDTH = 288;   // popup body, less its side padding
const PLOT_HEIGHT = 86;   // .chart .plot
const COLUMN_GAP = 2;

function renderChart(elementId, columns) {
  const chart = document.getElementById(elementId);
  const max = columns.reduce((top, c) => Math.max(top, c.total), 0);

  if (max === 0) {
    chart.innerHTML = '<p class="empty">Nothing recorded yet.</p>';
    return;
  }

  const columnWidth = (PLOT_WIDTH - (columns.length - 1) * COLUMN_GAP) / columns.length;
  // Below about 24px a column's share sits shoulder to shoulder with its
  // neighbour's and the row reads as noise, so only the week view writes them
  // on the bars; the longer ranges and the hours carry them in the tooltip.
  const roomForShares = columnWidth >= 24;

  chart.innerHTML = `
    <div class="plot">
      ${columns.map((c) => {
        const known = CHART_SOURCES.reduce((sum, s) => sum + c.parts[s], 0);
        const used = CHART_SOURCES.filter((s) => c.parts[s] > 0);
        const share = (s) => Math.round((c.parts[s] / known) * 100);
        const heightPct = Math.max((c.total / max) * 100, 3);

        // Records written before the per-service split existed still have a
        // total; draw those in the accent colour rather than losing the column.
        const segments = known > 0
          ? used.map((s) => {
              // A share only goes inside the segment when it fits there; a
              // number clipped by its own bar is worse than no number.
              const segmentHeight = (heightPct / 100) * PLOT_HEIGHT * (c.parts[s] / known);
              const label = roomForShares && segmentHeight >= 12 ? `<b>${share(s)}%</b>` : '';
              return `<i class="${s}" style="flex:${c.parts[s]}">${label}</i>`;
            }).join('')
          : '<i class="other" style="flex:1"></i>';

        // A silent hour or day keeps its place as a flat line: an empty column
        // would read as a gap in the chart, and a floored one as a little music.
        const stack = c.total > 0
          ? `<span class="stack" style="height:${heightPct}%">${segments}</span>`
          : '<span class="stack zero"></span>';

        // Every column names its split in full, however narrow it is on screen.
        const title = known > 0
          ? `${c.title} · ${used.map((s) => `${SOURCE_NAMES[s]} ${share(s)}%`).join(', ')}`
          : c.title;
        // Not "now": that class belongs to the now-playing section, whose
        // margin would lift the column clean off the axis.
        return `<div class="col${c.highlight ? ' current' : ''}${c.upcoming ? ' upcoming' : ''}" title="${escapeHtml(title)}">${stack}</div>`;
      }).join('')}
    </div>
    <div class="ticks">${columns.map((c) => `<span>${escapeHtml(c.tick || '')}</span>`).join('')}</div>
  `;
}

// How many labels fit under the columns without them running together.
function tickStep(count) {
  return count <= 7 ? 1 : count <= 14 ? 2 : 5;
}

// Monday, because that is where a week reads from: Saturday and Sunday belong
// at the end of it, not split across either edge of a rolling window.
function startOfWeek(date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

// The week view is the calendar week you are in — Monday through Sunday, with
// the days still to come left as empty slots. The longer views are rolling
// windows ending today, where a fixed weekday order would mean nothing.
function dayColumns(days, count) {
  const step = tickStep(count);
  const today = dayKey(new Date());
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  if (count === 7) {
    cursor.setTime(startOfWeek(cursor).getTime());
  } else {
    cursor.setDate(cursor.getDate() - (count - 1));
  }

  const columns = [];
  let reachedToday = false;
  for (let i = 0; i < count; i++) {
    const key = dayKey(cursor);
    const entry = days[key] || {};
    const total = entry.total || 0;
    const isToday = key === today;
    const upcoming = reachedToday && !isToday;
    const stamp = cursor.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    columns.push({
      total,
      parts: partsOf(entry),
      date: new Date(cursor),
      highlight: isToday,
      upcoming,
      // Labels are counted back from the newest column, the one being read.
      tick: (count - 1 - i) % step === 0
        ? (count <= 7 ? cursor.toLocaleDateString(undefined, { weekday: 'narrow' }) : String(cursor.getDate()))
        : '',
      title: upcoming ? `${stamp} · still to come` : `${stamp} · ${formatDuration(total)}`,
    });
    if (isToday) reachedToday = true;
    cursor.setDate(cursor.getDate() + 1);
  }
  return columns;
}

function hourLabel(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

function hourColumns(hours, isToday) {
  const now = new Date().getHours();
  return Array.from({ length: 24 }, (_, hour) => {
    const entry = hours[hour] || {};
    const total = entry.total || 0;
    return {
      total,
      parts: partsOf(entry),
      hour,
      highlight: isToday && hour === now,
      tick: hour % 6 === 0 ? String(hour) : '',
      title: `${hourLabel(hour)}–${hourLabel((hour + 1) % 24)} · ${formatDuration(total)}`,
    };
  });
}

// Shared by the "Hours of the day" and "All plays" day-switchers: 0 is today,
// larger numbers step back into the past.
function dayForOffset(offset) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - offset);
  return d;
}

function dayNavLabel(date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - date) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

// The day range is a choice the user makes while the popup is open; the poll
// re-renders every couple of seconds and must not undo it.
let dayRange = 7;

// Which day the "Hours of the day" chart is showing, 0 = today. Same
// must-survive-the-poll reasoning as dayRange above.
let hoursDayOffset = 0;

function renderAnalytics(stats) {
  const days = dayColumns(stats.days || {}, dayRange);
  renderChart('chart-days', days);

  // Days that have not happened yet must not drag the average down.
  const elapsed = days.filter((d) => !d.upcoming);
  const listened = elapsed.filter((d) => d.total > 0);
  const best = days.reduce((top, d) => (d.total > top.total ? d : top), days[0]);
  const span = dayRange === 7
    ? `${listened.length} of ${elapsed.length} days so far this week`
    : `${listened.length} of ${dayRange} days`;
  const daysNote = document.getElementById('days-note');
  daysNote.textContent = listened.length === 0
    ? (dayRange === 7 ? 'Nothing yet this week.' : `Nothing in the last ${dayRange} days.`)
    : `${span} · ${formatDuration(
        elapsed.reduce((sum, d) => sum + d.total, 0) / elapsed.length)} a day on average · best was ${
        best.date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} at ${formatDuration(best.total)}.`;

  const hoursDate = dayForOffset(hoursDayOffset);
  const hoursDayEntry = (stats.days || {})[dayKey(hoursDate)];
  const hours = hourColumns((hoursDayEntry && hoursDayEntry.hours) || {}, hoursDayOffset === 0);
  renderChart('chart-hours', hours);

  document.getElementById('hours-day-label').textContent = dayNavLabel(hoursDate);
  const firstSeenDay = stats.firstSeen ? new Date(stats.firstSeen) : null;
  if (firstSeenDay) firstSeenDay.setHours(0, 0, 0, 0);
  document.getElementById('hours-prev-day').disabled = Boolean(firstSeenDay) && hoursDate <= firstSeenDay;
  document.getElementById('hours-next-day').disabled = hoursDayOffset <= 0;

  const peak = hours.reduce((top, h) => (h.total > top.total ? h : top), hours[0]);
  const hoursNote = document.getElementById('hours-note');
  hoursNote.textContent = peak.total > 0
    ? `Your busiest hour was ${hourLabel(peak.hour)}–${hourLabel((peak.hour + 1) % 24)}, with ${formatDuration(peak.total)} all told.`
    // Listening recorded before this chart existed cannot be broken back down
    // into hours, so say that rather than let it read as a fault.
    : (hoursDayEntry && hoursDayEntry.total > 0
        ? 'Not recorded by the hour that day.'
        : 'Nothing played that day.');

  // Only name the services that actually appear in the columns.
  const used = CHART_SOURCES.filter((source) => (stats.sources || {})[source] > 0);
  document.getElementById('chart-legend').innerHTML = used
    .map((source) => `<span class="key"><i class="${source}"></i>${SOURCE_NAMES[source]}</span>`)
    .join('');
}

document.querySelectorAll('.range-option').forEach((button) => {
  button.addEventListener('click', () => {
    dayRange = Number(button.dataset.days);
    document.querySelectorAll('.range-option').forEach((other) => {
      const on = other === button;
      other.classList.toggle('on', on);
      other.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    load();
  });
});

document.getElementById('hours-prev-day').addEventListener('click', () => {
  hoursDayOffset += 1;
  load();
});
document.getElementById('hours-next-day').addEventListener('click', () => {
  if (hoursDayOffset <= 0) return;
  hoursDayOffset -= 1;
  load();
});

const TABS = [
  { tab: 'tab-overview', panel: 'panel-overview' },
  { tab: 'tab-analytics', panel: 'panel-analytics' },
  { tab: 'tab-history', panel: 'panel-history' },
];

function showTab(id) {
  for (const entry of TABS) {
    const on = entry.tab === id;
    const tab = document.getElementById(entry.tab);
    tab.classList.toggle('on', on);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    document.getElementById(entry.panel).hidden = !on;
  }
}

TABS.forEach((entry) => {
  document.getElementById(entry.tab).addEventListener('click', () => showTab(entry.tab));
});

// The most recent stats the popup drew, so the share card can be built without
// asking the worker again on every click.
let latest = null;

// Pops the element only when its text is actually about to change, so the
// 2-second poll doesn't replay the animation on every tick.
function setValue(id, text) {
  const el = document.getElementById(id);
  if (el.textContent === text) return;
  el.textContent = text;
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
}

function render(stats) {
  latest = stats;
  const days = stats.days || {};
  const favorites = stats.favorites || {};
  setValue('today-value', formatDuration(sumLastDays(days, 1)));
  setValue('week-value', formatDuration(sumLastDays(days, 7)));
  setValue('month-value', formatDuration(sumLastDays(days, 30)));
  setValue('all-value', formatDuration(stats.total || 0));

  renderNowPlaying(stats);
  renderSources(stats);
  renderAnalytics(stats);
  renderHistory(stats.history);

  const retention = (stats.settings && stats.settings.historyRetention) || 'forever';
  // Don't yank the value out from under an open dropdown, and don't touch it
  // at all once it already matches — resetting it mid-interaction is what a
  // native <select> shows as the menu snapping shut.
  if (document.activeElement !== historyRetentionSelect && historyRetentionSelect.value !== retention) {
    historyRetentionSelect.value = retention;
  }

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

  // An open share card is a picture of these very numbers; keep it in step.
  refreshShare();
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
  // The star and the transport buttons sit inside the row; each has its own job.
  if (!current || event.target.closest('button')) return;
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

// --- Transport ---------------------------------------------------------------
//
// The buttons do not touch the audio themselves: they ask the content script to
// press the page's own controls, so the site handles the queue, the autoplay and
// the scrobbling exactly as it would on a real click.

const playPauseButton = document.getElementById('now-playpause');

function setPlayPause(playing) {
  playPauseButton.classList.toggle('playing', playing);
  playPauseButton.title = playing ? 'Pause' : 'Play';
  playPauseButton.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

async function sendControl(action) {
  if (!current || !current.tabId) return;
  try {
    await chrome.tabs.sendMessage(current.tabId, { type: 'control', action });
  } catch (err) {
    // The tab closed, or its content script predates this version.
    return;
  }
  // A skip takes a moment to land on the next track, and the poll is two
  // seconds away; ask again once the page has had time to catch up.
  setTimeout(load, 400);
}

const TRANSPORT = { 'now-prev': 'prev', 'now-playpause': 'playPause', 'now-next': 'next' };

for (const [id, action] of Object.entries(TRANSPORT)) {
  document.getElementById(id).addEventListener('click', (event) => {
    // The row underneath opens the tab; a button press is not that.
    event.stopPropagation();
    flash(event.currentTarget, 'press');
    // Flip the icon on the press rather than waiting for the page to answer:
    // the click is what makes it true, and a lagging icon reads as a dropped
    // press. A refused press is corrected by the reload 400ms later.
    if (action === 'playPause' && current) {
      current.paused = !current.paused;
      setPlayPause(!current.paused);
    }
    sendControl(action);
  });
}

document.getElementById('now-star').addEventListener('click', async (event) => {
  event.stopPropagation();
  if (!current) return;
  flash(event.currentTarget, 'pop');
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
  if (event.key !== 'Escape') return;
  if (!confirmOverlay.hidden) showConfirm(false);
  else if (!shareOverlay.hidden) showShare(false);
});

// Keep the numbers live while the popup is open; content scripts report every
// 5 seconds, so a 2 second poll never shows a stale figure for long.
const poll = setInterval(load, 2000);
window.addEventListener('unload', () => clearInterval(poll));

load();

// --- Sharing -----------------------------------------------------------------
//
// Neither Instagram nor Facebook lets a page hand them a picture to post: their
// web share endpoints take a link, and an extension's stats have no link. So the
// card is drawn here, saved as a PNG and copied to the clipboard, and the site
// is opened at its composer — the last step is the user's, which is also the
// only step either network allows.

const SHARE_PERIODS = {
  day: { label: 'Today', caption: 'today', chart: false },
  week: { label: 'This week', caption: 'this week', chart: true },
  month: { label: 'Past 30 days', caption: 'in the past 30 days', chart: true },
  year: { label: 'Past 12 months', caption: 'in the past year', chart: true },
};

let sharePeriod = 'week';

function startOfMonth(date, offset = 0) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  start.setDate(1);
  start.setMonth(start.getMonth() + offset);
  return start;
}

// The first day the period covers. A period always ends today: a card that
// counted days still to come would read as a drop in listening.
function periodStart(period) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (period === 'day') return today;
  if (period === 'week') return startOfWeek(today);
  if (period === 'month') {
    const start = new Date(today);
    start.setDate(start.getDate() - 29);
    return start;
  }
  // A year is the last twelve calendar months, so the number and the twelve
  // columns beneath it are counting exactly the same days.
  return startOfMonth(today, -11);
}

function eachDay(from, to) {
  const list = [];
  const cursor = new Date(from);
  while (cursor <= to) {
    list.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return list;
}

function addParts(into, entry) {
  for (const source of CHART_SOURCES) into[source] += entry[source] || 0;
  return into;
}

function emptyParts() {
  return CHART_SOURCES.reduce((parts, source) => ({ ...parts, [source]: 0 }), {});
}

// Day columns for the week and month cards, calendar-month columns for the
// year: twelve bars say "when in the year", 365 of them say nothing at all.
function shareColumns(days, period, dates) {
  if (period === 'week' || period === 'month') {
    const step = period === 'week' ? 1 : 5;
    return dates.map((date, i) => {
      const entry = days[dayKey(date)] || {};
      return {
        total: entry.total || 0,
        parts: partsOf(entry),
        tick: (dates.length - 1 - i) % step === 0
          ? (period === 'week'
              ? date.toLocaleDateString(undefined, { weekday: 'narrow' })
              : String(date.getDate()))
          : '',
      };
    });
  }

  const months = [];
  for (let i = 0; i < 12; i++) {
    const start = startOfMonth(new Date(), i - 11);
    months.push({ start, total: 0, parts: emptyParts(), tick: '' });
  }
  const index = new Map(months.map((m, i) => [`${m.start.getFullYear()}-${m.start.getMonth()}`, i]));
  for (const date of dates) {
    const slot = months[index.get(`${date.getFullYear()}-${date.getMonth()}`)];
    if (!slot) continue;
    const entry = days[dayKey(date)] || {};
    slot.total += entry.total || 0;
    addParts(slot.parts, entry);
  }
  return months.map((m, i) => ({
    ...m,
    tick: i % 2 === 11 % 2
      ? m.start.toLocaleDateString(undefined, { month: 'narrow' })
      : '',
  }));
}

// Rounding each share on its own gives cards reading 63% and 38%. Hand the
// rounding loss to the entries with most of it owing, so the figures add up.
function withPercentages(services, total) {
  if (total <= 0) return services.map((s) => ({ ...s, percent: 0 }));
  const exact = services.map((s) => ({ ...s, raw: (s.seconds / total) * 100 }));
  const rounded = exact.map((s) => ({ ...s, percent: Math.floor(s.raw) }));
  let left = 100 - rounded.reduce((sum, s) => sum + s.percent, 0);
  for (const s of [...rounded].sort((a, b) => (b.raw % 1) - (a.raw % 1))) {
    if (left <= 0) break;
    s.percent += 1;
    left -= 1;
  }
  return rounded.map(({ raw, ...s }) => s);
}

function shareData(stats, period) {
  const days = stats.days || {};
  const spec = SHARE_PERIODS[period];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dates = eachDay(periodStart(period), today);

  let seconds = 0;
  const parts = emptyParts();
  for (const date of dates) {
    const entry = days[dayKey(date)] || {};
    seconds += entry.total || 0;
    addParts(parts, entry);
  }

  const services = withPercentages(
    CHART_SOURCES
      .map((source) => ({ source, seconds: parts[source] }))
      .filter((s) => s.seconds > 0)
      .sort((a, b) => b.seconds - a.seconds),
    seconds,
  );

  // Per-track and per-artist figures are kept as running totals, not per day,
  // so the card names the all-time leaders and says as much on the label.
  const track = Object.values(stats.tracks || {})
    .sort((a, b) => (b.seconds || 0) - (a.seconds || 0))[0] || null;
  const artist = Object.entries(stats.artists || {})
    .map(([name, value]) => (typeof value === 'number' ? { name, seconds: value } : { name, seconds: value.seconds }))
    .sort((a, b) => b.seconds - a.seconds)[0] || null;

  return {
    period,
    spec,
    seconds,
    services,
    track,
    artist,
    columns: spec.chart ? shareColumns(days, period, dates) : [],
    range: dates.length === 1
      ? today.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
      : `${dates[0].toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'short',
          // Only when the range straddles new year, where "Oct 1 – Sep 18, 2026"
          // would otherwise read as a ten-month gap rather than a year.
          ...(dates[0].getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
        })} – ${today.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`,
  };
}

function shareCaption(data) {
  if (data.seconds <= 0) {
    return `No music tracked ${data.spec.caption} yet — counted by Music Counter.`;
  }
  const split = data.services
    .map((s) => `${s.percent}% ${SOURCE_NAMES[s.source]}`)
    .join(', ');
  return `🎧 ${formatDuration(data.seconds)} of music ${data.spec.caption}${split ? ` — ${split}` : ''}. Counted by Music Counter.`;
}

// --- The card ----------------------------------------------------------------

const CARD = { width: 1080, height: 1350, pad: 84 };

const CARD_COLORS = {
  bg: '#12101a',
  panel: '#1b1826',
  text: '#f2eefb',
  muted: '#9b93b3',
  accent: '#b191ff',
  axis: '#3a3350',
  youtube: '#ff4e45',
  ytmusic: '#ff8a3d',
  spotify: '#1ed760',
};

function fit(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function tracked(ctx, text, x, y, spacing) {
  ctx.letterSpacing = `${spacing}px`;
  ctx.fillText(text, x, y);
  ctx.letterSpacing = '0px';
}

function drawCardChart(ctx, columns, x, y, width, height) {
  const max = columns.reduce((top, c) => Math.max(top, c.total), 0);
  const gap = columns.length > 20 ? 4 : 10;
  const columnWidth = (width - (columns.length - 1) * gap) / columns.length;

  ctx.fillStyle = CARD_COLORS.axis;
  ctx.fillRect(x, y + height, width, 2);

  columns.forEach((column, i) => {
    const left = x + i * (columnWidth + gap);
    if (column.total <= 0) return;

    const known = CHART_SOURCES.reduce((sum, s) => sum + column.parts[s], 0);
    const columnHeight = Math.max((column.total / max) * height, 4);
    let bottom = y + height;

    // Records written before the per-service split existed still carry a total;
    // draw those in the accent colour rather than losing the column.
    const segments = known > 0
      ? CHART_SOURCES.filter((s) => column.parts[s] > 0)
          .map((s) => ({ color: CARD_COLORS[s], height: columnHeight * (column.parts[s] / known) }))
      : [{ color: CARD_COLORS.accent, height: columnHeight }];

    // Clip to the column's silhouette first: the cap is rounded, the foot sits
    // flat on the axis, and the stack inside still reads as one column.
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(left, y + height - columnHeight, columnWidth, columnHeight, [8, 8, 0, 0]);
    ctx.clip();
    for (const segment of segments) {
      ctx.fillStyle = segment.color;
      ctx.fillRect(left, bottom - segment.height, columnWidth, segment.height);
      bottom -= segment.height;
    }
    ctx.restore();
  });

  ctx.fillStyle = CARD_COLORS.muted;
  ctx.font = '500 22px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  columns.forEach((column, i) => {
    if (!column.tick) return;
    const left = x + i * (columnWidth + gap);
    ctx.fillText(column.tick, left + columnWidth / 2, y + height + 40);
  });
  ctx.textAlign = 'left';
}

const SERVICE_ROW = 78;

function drawServices(ctx, data, x, y, width) {
  data.services.forEach((service, i) => {
    const top = y + i * SERVICE_ROW;
    const share = data.seconds > 0 ? service.seconds / data.seconds : 0;

    ctx.fillStyle = CARD_COLORS.text;
    ctx.font = '600 30px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(SOURCE_NAMES[service.source], x, top + 30);

    ctx.textAlign = 'right';
    ctx.fillStyle = CARD_COLORS.muted;
    ctx.font = '500 28px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(`${formatDuration(service.seconds)} · ${service.percent}%`, x + width, top + 30);
    ctx.textAlign = 'left';

    ctx.fillStyle = '#272235';
    ctx.beginPath();
    ctx.roundRect(x, top + 50, width, 12, 6);
    ctx.fill();

    ctx.fillStyle = CARD_COLORS[service.source];
    ctx.beginPath();
    ctx.roundRect(x, top + 50, Math.max(width * share, 12), 12, 6);
    ctx.fill();
  });
}

function drawShareCard(canvas, data) {
  const ctx = canvas.getContext('2d');
  const { width, height, pad } = CARD;
  const inner = width - pad * 2;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = CARD_COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  // A single wash of accent behind the headline, so the card does not read as a
  // flat screenshot of the popup.
  const glow = ctx.createRadialGradient(width * 0.5, height * 0.22, 0, width * 0.5, height * 0.22, width * 0.75);
  glow.addColorStop(0, 'rgba(177, 145, 255, .20)');
  glow.addColorStop(1, 'rgba(177, 145, 255, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.textBaseline = 'alphabetic';
  ctx.font = '700 26px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillStyle = CARD_COLORS.muted;
  tracked(ctx, 'MUSIC COUNTER', pad, 120, 7);

  ctx.textAlign = 'right';
  ctx.font = '500 26px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText(data.range, width - pad, 120);
  ctx.textAlign = 'left';

  ctx.textAlign = 'center';
  ctx.fillStyle = CARD_COLORS.text;
  ctx.font = '600 44px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText(data.spec.label, width / 2, 252);

  ctx.fillStyle = CARD_COLORS.accent;
  ctx.font = '700 148px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText(data.seconds > 0 ? formatDuration(data.seconds) : 'Nothing yet', width / 2, 400);

  ctx.fillStyle = CARD_COLORS.muted;
  ctx.font = '500 34px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText(data.seconds > 0 ? 'of music listened' : 'no music tracked yet', width / 2, 456);
  ctx.textAlign = 'left';

  // The leaders are running totals rather than period figures, so they are
  // labelled all-time and kept to one line each.
  const leaders = [
    data.track && ['Most played', `${data.track.title}${data.track.artist ? ` — ${data.track.artist}` : ''}`],
    data.artist && ['Top artist', data.artist.name],
  ].filter(Boolean);

  // Laid out from the bottom up, so three services and two leaders never end up
  // sharing the same pixels: whatever is left over goes to the chart, which is
  // the one block that can take any height.
  const chartTop = 510;
  const hasChart = data.columns.length > 0 && data.columns.some((c) => c.total > 0);
  const boxHeight = leaders.length > 0 ? 42 + leaders.length * 52 : 0;
  const servicesHeight = data.services.length > 0 ? 34 + data.services.length * SERVICE_ROW : 0;

  let servicesTop;
  let boxTop;
  if (hasChart) {
    boxTop = height - pad - 56 - boxHeight;
    servicesTop = boxTop - (boxHeight > 0 ? 24 : 0) - servicesHeight;
  } else {
    // Nothing to plot — a day, or a fresh install. Sit the blocks under the
    // headline rather than stranding them at the foot of an empty card.
    servicesTop = chartTop + 40;
    boxTop = servicesTop + servicesHeight + 24;
  }

  // The columns get whatever is left, less the room their tick row and the
  // heading below it need — 40 for the ticks, the rest so the two never touch.
  const chartHeight = Math.min(240, servicesTop - 86 - chartTop);
  if (hasChart && chartHeight > 40) {
    drawCardChart(ctx, data.columns, pad, chartTop, inner, chartHeight);
  }

  if (data.services.length > 0) {
    ctx.fillStyle = CARD_COLORS.muted;
    ctx.font = '700 22px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    tracked(ctx, 'BY SERVICE', pad, servicesTop, 6);
    drawServices(ctx, data, pad, servicesTop + 34, inner);
  }

  if (leaders.length > 0) {
    const top = boxTop;
    ctx.fillStyle = CARD_COLORS.panel;
    ctx.beginPath();
    ctx.roundRect(pad, top, inner, boxHeight, 18);
    ctx.fill();

    ctx.fillStyle = CARD_COLORS.muted;
    ctx.font = '700 20px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    tracked(ctx, 'ALL TIME', pad + 28, top + 38, 6);

    leaders.forEach(([label, value], i) => {
      const line = top + 38 + 44 + i * 52;
      ctx.fillStyle = CARD_COLORS.muted;
      ctx.font = '500 26px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      const labelWidth = ctx.measureText(`${label}  `).width;
      ctx.fillText(`${label}  `, pad + 28, line);

      ctx.fillStyle = CARD_COLORS.text;
      ctx.font = '600 28px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.fillText(fit(ctx, value, inner - 56 - labelWidth), pad + 28 + labelWidth, line);
    });
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = CARD_COLORS.muted;
  ctx.font = '500 24px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('Counted on YouTube, YouTube Music and Spotify', width / 2, height - pad);
  ctx.textAlign = 'left';
  ctx.restore();
}

// --- The dialog --------------------------------------------------------------

const shareOverlay = document.getElementById('share-overlay');
const shareCanvas = document.getElementById('share-canvas');
const shareStatus = document.getElementById('share-status');
const shareHint = shareStatus.textContent;

function say(message, done = false) {
  shareStatus.textContent = message;
  shareStatus.classList.toggle('done', done);
}

// Redraws the card from whatever the popup last showed. Called by render(), so
// the picture never lags the numbers it claims to be of.
function refreshShare() {
  if (!shareOverlay || shareOverlay.hidden || !latest) return;
  const data = shareData(latest, sharePeriod);
  drawShareCard(shareCanvas, data);
  document.getElementById('share-caption').textContent = shareCaption(data);
}

function showShare(show) {
  shareOverlay.hidden = !show;
  if (!show) return;
  say(shareHint);
  refreshShare();
  document.getElementById('share-close').focus();
}

function shareFilename() {
  return `music-counter-${sharePeriod}-${dayKey(new Date())}.png`;
}

function cardBlob() {
  return new Promise((resolve, reject) => {
    shareCanvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('no blob'))), 'image/png');
  });
}

async function saveCard() {
  const blob = await cardBlob();
  const url = URL.createObjectURL(blob);
  try {
    if (chrome.downloads && chrome.downloads.download) {
      await chrome.downloads.download({ url, filename: shareFilename(), saveAs: false });
    } else {
      const link = document.createElement('a');
      link.href = url;
      link.download = shareFilename();
      link.click();
    }
  } finally {
    // The download reads the blob before the popup can close; a minute is far
    // longer than it needs and the popup rarely lives that long anyway.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

async function copyCard() {
  const blob = await cardBlob();
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

// Instagram and Facebook both want the picture pasted or picked by hand, so
// hand the user everything they need first and then open the composer.
async function shareTo(site, url) {
  try {
    await saveCard();
  } catch (err) {
    say(`Could not save the image, so ${site} was not opened.`);
    return;
  }

  let copied = false;
  try {
    await navigator.clipboard.writeText(document.getElementById('share-caption').textContent);
    copied = true;
  } catch (err) {
    // Clipboard refused; the caption is still on screen to copy by hand.
  }

  await chrome.tabs.create({ url, active: true });
  say(`Card saved to your downloads${copied ? ' and the caption copied' : ''}. Add it to your ${site} post.`, true);
}

document.getElementById('share').addEventListener('click', () => showShare(true));
document.getElementById('share-close').addEventListener('click', () => showShare(false));

document.querySelectorAll('.share-period').forEach((button) => {
  button.addEventListener('click', () => {
    sharePeriod = button.dataset.period;
    document.querySelectorAll('.share-period').forEach((other) => {
      const on = other === button;
      other.classList.toggle('on', on);
      other.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    say(shareHint);
    refreshShare();
  });
});

document.getElementById('share-save').addEventListener('click', async () => {
  try {
    await saveCard();
    say('Saved to your downloads.', true);
  } catch (err) {
    say('Could not save the image.');
  }
});

document.getElementById('share-copy').addEventListener('click', async () => {
  try {
    await copyCard();
    say('Card copied — paste it wherever you like.', true);
  } catch (err) {
    say('Could not copy the image; save it instead.');
  }
});

document.getElementById('share-instagram').addEventListener('click', () => {
  shareTo('Instagram', 'https://www.instagram.com/');
});

document.getElementById('share-facebook').addEventListener('click', () => {
  shareTo('Facebook', 'https://www.facebook.com/');
});

shareOverlay.addEventListener('click', (event) => {
  if (event.target === shareOverlay) showShare(false);
});
