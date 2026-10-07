const SOURCE_NAMES = {
  ytmusic: 'YouTube Music',
  youtube: 'YouTube',
  spotify: 'Spotify',
  ios: 'Pocket',
};

// Opened from the Pin button, the page lives in a window of its own: it stays
// open after you jump to a song, and only Unpin (or closing it) puts it away.
const PINNED = new URLSearchParams(location.search).has('pinned');
if (PINNED) document.documentElement.classList.add('pinned');

function closePopup() {
  if (!PINNED) window.close();
}

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
  return `https://www.youtube.com/results?search_query=${query}`;
}

// Which tabs count as "the tab for this service". YouTube proper covers both
// the desktop and mobile hosts; music.youtube.com is a service of its own.
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
    if (active) closePopup();
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
      closePopup();
      return;
    }
  } catch (err) {
    // No permission yet, or the tab vanished between the query and the update:
    // fall through and just open a new one.
  }

  await chrome.tabs.create({ url });
  closePopup();
}

function renderSources(stats) {
  // Plays are recorded per track, so the per-service figure is their sum. Only
  // tracks that were listened at least halfway ever counted a play.
  const plays = {};
  for (const track of Object.values(stats.tracks || {})) {
    plays[track.source] = (plays[track.source] || 0) + (track.plays || 0);
  }
  renderServiceBars(
    document.getElementById('sources'),
    document.getElementById('per-percent'),
    stats.sources || {},
    plays,
    'Nothing recorded yet.',
    'all',
  );
}

// Charts and bars grow in when what they show changes — a new range, period
// or day, or their tab being opened — but not on the 2-second poll, which
// would restart the motion over and over. `view` names what is on show; the
// markup is only rewritten on the poll when the numbers actually moved.
function paint(element, view, html) {
  const intro = element.dataset.view !== view;
  if (!intro && element.dataset.html === html) return;
  element.dataset.view = view;
  element.dataset.html = html;
  element.classList.toggle('intro', intro);
  element.innerHTML = html;
}

// The "By service" bars, shared by the all-time list on Overview and the
// per-period one under "Days you listened".
function renderServiceBars(list, perPercent, sources, plays, emptyText, view) {
  const entries = Object.entries(sources)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) {
    paint(list, view, `<li class="empty">${emptyText}</li>`);
    if (perPercent) perPercent.textContent = '';
    return;
  }

  const max = entries[0][1];
  // The share is of listening time across the services, so the figures add up
  // to 100% however many of them you use.
  const total = entries.reduce((sum, [, seconds]) => sum + seconds, 0);
  if (perPercent) perPercent.textContent = `1% = ${formatMinutes(total / 100)}`;
  paint(list, view, entries.map(([source, seconds], index) => `
    <li style="--i:${index}">
      <div class="row">
        <span>${SOURCE_NAMES[source] || source}<span class="share">${Math.round((seconds / total) * 100)}%</span></span>
        <span>${plays[source] ? `<span class="count">${plays[source]} ${plays[source] === 1 ? 'song' : 'songs'}</span>` : ''}${formatDuration(seconds)}</span>
      </div>
      <div class="track"><div class="fill ${source}" style="width:${(seconds / max) * 100}%"></div></div>
    </li>
  `).join(''));
}

// A percentage point of the shares above, in the minutes it stands for. Small
// spans read better in seconds than as a fraction of a minute, and a round
// figure keeps the trailing ".0" off the common case.
function formatMinutes(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  return `${minutes < 10 ? minutes.toFixed(1).replace(/\.0$/, '') : Math.round(minutes)}m`;
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
      ${key ? `<button class="add" data-index="${index}" title="Add to a playlist" aria-label="Add to a playlist">+</button>` : ''}
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

  list.querySelectorAll('button.add').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      openAddDialog(entries[Number(button.dataset.index)].track);
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

// Live search query for "All plays". Non-empty search looks across every
// recorded day instead of the currently selected one.
let historySearchQuery = '';

function renderHistory(history) {
  const list = document.getElementById('history');
  const note = document.getElementById('history-note');
  const all = (history || []).slice().sort((a, b) => b.at - a.at);

  const query = historySearchQuery.trim().toLowerCase();
  const searching = query.length > 0;

  const day = dayForOffset(historyDayOffset);
  document.getElementById('history-day-label').textContent = dayNavLabel(day);
  const oldest = all.length ? new Date(all[all.length - 1].at) : null;
  if (oldest) oldest.setHours(0, 0, 0, 0);
  document.getElementById('history-prev-day').disabled = searching || !oldest || day <= oldest;
  document.getElementById('history-next-day').disabled = searching || historyDayOffset <= 0;

  const matches = (entry) => {
    if (!searching) return true;
    const title = (entry.title || '').toLowerCase();
    const artist = (entry.artist || '').toLowerCase();
    return title.includes(query) || artist.includes(query);
  };

  const key = dayKey(day);
  const entries = searching
    ? all.filter(matches)
    : all.filter((entry) => dayKey(new Date(entry.at)) === key);

  if (entries.length === 0) {
    list.innerHTML = `<li class="empty">${searching ? 'No plays match your search.' : 'Nothing played that day.'}</li>`;
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
      <button class="add" data-index="${index}" title="Add to a playlist" aria-label="Add to a playlist">+</button>
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
    const open = (event) => {
      if (event.target.closest('button')) return;
      openUrl(trackUrl(entry), event);
    };
    li.addEventListener('click', open);
    li.addEventListener('auxclick', (event) => {
      if (event.button === 1) open(event);
    });
  });

  list.querySelectorAll('button.add').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const entry = shown[Number(button.dataset.index)];
      openAddDialog({ id: entry.id || '', title: entry.title, artist: entry.artist, source: entry.source });
    });
  });

  const scope = searching ? 'matching plays' : 'plays that day';
  note.textContent = entries.length > shown.length
    ? `Showing the most recent ${shown.length} of ${entries.length} ${scope}.`
    : `${entries.length} ${entries.length === 1 ? 'play' : 'plays'}${searching ? ' match your search.' : ' recorded that day.'}`;
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

const historySearchInput = document.getElementById('history-search');
const historySearchClear = document.getElementById('history-search-clear');
historySearchInput.addEventListener('input', () => {
  historySearchQuery = historySearchInput.value;
  historySearchClear.hidden = historySearchQuery.length === 0;
  if (latest) renderHistory(latest.history);
});
historySearchClear.addEventListener('click', () => {
  historySearchInput.value = '';
  historySearchQuery = '';
  historySearchClear.hidden = true;
  historySearchInput.focus();
  if (latest) renderHistory(latest.history);
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
    progress = null;
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
  document.getElementById('now-seek').className = `seek ${playing.source}`;

  syncProgress(playing);

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

const CHART_SOURCES = ['ytmusic', 'youtube', 'spotify', 'ios'];

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

// The columns each chart last drew, so the tooltip can describe the one under
// the pointer without parsing it back out of the markup.
const chartColumns = new Map();

function renderChart(elementId, columns, view) {
  const chart = document.getElementById(elementId);
  chartColumns.set(elementId, columns);
  const max = columns.reduce((top, c) => Math.max(top, c.total), 0);

  if (max === 0) {
    paint(chart, view, '<p class="empty">Nothing recorded yet.</p>');
    if (tipColumn && !tipColumn.isConnected) hideChartTip();
    return;
  }

  const columnWidth = (PLOT_WIDTH - (columns.length - 1) * COLUMN_GAP) / columns.length;
  // Below about 24px a column's share sits shoulder to shoulder with its
  // neighbour's and the row reads as noise, so only the week view writes them
  // on the bars; the longer ranges and the hours carry them in the tooltip.
  const roomForShares = columnWidth >= 24;

  paint(chart, view, `
    <div class="plot">
      ${columns.map((c, index) => {
        const known = CHART_SOURCES.reduce((sum, s) => sum + c.parts[s], 0);
        const used = CHART_SOURCES.filter((s) => c.parts[s] > 0);
        // Rounded together, so the bars and the tooltip both add up to 100.
        const percents = Object.fromEntries(
          withPercentages(used.map((source) => ({ source, seconds: c.parts[source] })), known)
            .map((p) => [p.source, p.percent]),
        );
        const share = (s) => percents[s];
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

        // Every column names its split in full, however narrow it is on screen:
        // read out by screen readers here, and drawn by the chart tooltip.
        const title = known > 0
          ? `${c.title} · ${used.map((s) => `${SOURCE_NAMES[s]} ${share(s)}%`).join(', ')}`
          : c.title;
        // Not "now": that class belongs to the now-playing section, whose
        // margin would lift the column clean off the axis.
        return `<div class="col${c.highlight ? ' current' : ''}${c.upcoming ? ' upcoming' : ''}" style="--i:${index}" data-index="${index}" role="img" aria-label="${escapeHtml(title)}">${stack}</div>`;
      }).join('')}
    </div>
    <div class="ticks">${columns.map((c) => `<span>${escapeHtml(c.tick || '')}</span>`).join('')}</div>
  `);
  // A repaint swaps the columns out; a tooltip left on the old one would go stale.
  if (tipColumn && !tipColumn.isConnected) hideChartTip();
}

// One tooltip serves every chart: a card with the column's time, its total and
// each service's share, drawn as a split bar and a row per service. It sits
// above the column under the pointer, kept inside the popup, and flips below
// when the column is too near the top to fit it.
const chartTip = document.createElement('div');
chartTip.className = 'chart-tip';
chartTip.setAttribute('aria-hidden', 'true');
document.body.appendChild(chartTip);
let tipColumn = null;

function chartTipHtml(c) {
  const known = CHART_SOURCES.reduce((sum, s) => sum + c.parts[s], 0);
  const services = withPercentages(
    CHART_SOURCES
      .map((source) => ({ source, seconds: c.parts[source] }))
      .filter((s) => s.seconds > 0)
      .sort((a, b) => b.seconds - a.seconds),
    known,
  );
  const total = c.upcoming
    ? '<span class="tip-quiet">Still to come</span>'
    : c.total > 0 ? `<strong>${formatDuration(c.total)}</strong>` : '<span class="tip-quiet">Nothing played</span>';
  const split = services.length
    ? `<div class="tip-split">${services.map((s) => `<i class="${s.source}" style="flex:${s.seconds}"></i>`).join('')}</div>
       <ul class="tip-rows">${services.map((s) => `
         <li><i class="dot ${s.source}"></i><span>${escapeHtml(SOURCE_NAMES[s.source])}</span><em>${formatDuration(s.seconds)}</em><b>${s.percent}%</b></li>`).join('')}
       </ul>`
    : '';
  return `<div class="tip-head"><span>${escapeHtml(c.label || c.title)}</span>${total}</div>${split}`;
}

function placeChartTip(col) {
  const margin = 6;
  const rect = col.getBoundingClientRect();
  const width = chartTip.offsetWidth;
  const height = chartTip.offsetHeight;
  const centre = rect.left + rect.width / 2;
  const left = Math.max(margin, Math.min(centre - width / 2, document.documentElement.clientWidth - width - margin));
  const below = rect.top - height - 8 < margin;
  const stack = col.querySelector('.stack');
  const anchorTop = stack && stack.offsetHeight ? stack.getBoundingClientRect().top : rect.bottom;
  const top = below ? rect.bottom + 8 : anchorTop - height - 8;
  chartTip.classList.toggle('below', below);
  chartTip.style.left = `${left}px`;
  chartTip.style.top = `${Math.max(margin, top)}px`;
  chartTip.style.setProperty('--arrow-x', `${Math.max(10, Math.min(centre - left, width - 10))}px`);
}

function showChartTip(col) {
  const chart = col.closest('.chart');
  const columns = chart && chartColumns.get(chart.id);
  const column = columns && columns[Number(col.dataset.index)];
  if (!column) return hideChartTip();
  if (tipColumn !== col) {
    tipColumn = col;
    chartTip.innerHTML = chartTipHtml(column);
  }
  placeChartTip(col);
  chartTip.classList.add('on');
}

function hideChartTip() {
  tipColumn = null;
  chartTip.classList.remove('on');
}

document.addEventListener('mouseover', (event) => {
  const col = event.target.closest && event.target.closest('.chart .col');
  if (col) showChartTip(col);
  else if (tipColumn) hideChartTip();
});
document.addEventListener('scroll', hideChartTip, true);
window.addEventListener('blur', hideChartTip);

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

// First day of the period the "Days you listened" chart shows. The week view
// is a calendar week, Monday through Sunday; the longer views are rolling
// windows ending today, where a fixed weekday order would mean nothing.
// `periodsBack` steps back whole periods: weeks, or 14/30-day windows.
function dayPeriodStart(count, periodsBack) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (count === 7) {
    start.setTime(startOfWeek(start).getTime());
    start.setDate(start.getDate() - 7 * periodsBack);
  } else {
    start.setDate(start.getDate() - (count - 1) - count * periodsBack);
  }
  return start;
}

// In the current week the days still to come are left as empty slots.
function dayColumns(days, count, periodsBack = 0) {
  const step = tickStep(count);
  const today = dayKey(new Date());
  const cursor = dayPeriodStart(count, periodsBack);

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
      label: stamp,
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
      label: `${hourLabel(hour)}–${hourLabel((hour + 1) % 24)}`,
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

// How many periods back "Days you listened" is showing, 0 = the current one.
// Reset whenever the range changes, since a period means something else then.
let dayPeriodOffset = 0;

function periodLabel(count, periodsBack, columns) {
  if (periodsBack === 0) return count === 7 ? 'This week' : `Last ${count} days`;
  if (count === 7 && periodsBack === 1) return 'Last week';
  const fmt = (d) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return `${fmt(columns[0].date)} – ${fmt(columns[columns.length - 1].date)}`;
}

// Which day the "Hours of the day" chart is showing, 0 = today. Same
// must-survive-the-poll reasoning as dayRange above.
let hoursDayOffset = 0;

// Whether "Hours of the day" shows one day or every recorded day added
// together, the shape of a typical day. Survives the poll like the above.
let hoursAllTime = false;

// Every recorded day's hours summed into one set of 24, in the same shape as a
// single day's entry so hourColumns can take either.
function allTimeHours(days) {
  const hours = {};
  for (const entry of Object.values(days)) {
    for (const [hour, slice] of Object.entries(entry.hours || {})) {
      const into = hours[hour] || (hours[hour] = { total: 0, ...emptyParts() });
      into.total += slice.total || 0;
      addParts(into, slice);
    }
  }
  return hours;
}

// The services behind the period "Days you listened" is showing: time from the
// day columns, songs from the play history (which the retention setting may
// have trimmed for older periods).
function renderPeriodSources(columns, history) {
  const seconds = {};
  for (const column of columns) {
    for (const [source, value] of Object.entries(column.parts)) seconds[source] = (seconds[source] || 0) + value;
  }
  const from = columns[0].date.getTime();
  const until = new Date(columns[columns.length - 1].date);
  until.setDate(until.getDate() + 1);
  const plays = {};
  for (const entry of history) {
    if (entry.at >= from && entry.at < until.getTime()) plays[entry.source] = (plays[entry.source] || 0) + 1;
  }
  renderServiceBars(
    document.getElementById('period-sources'),
    null,
    seconds,
    plays,
    'Nothing played in this period.',
    `${dayRange}:${dayPeriodOffset}`,
  );
}

function renderAnalytics(stats) {
  const days = dayColumns(stats.days || {}, dayRange, dayPeriodOffset);
  renderChart('chart-days', days, `${dayRange}:${dayPeriodOffset}`);

  const firstSeenDay = stats.firstSeen ? new Date(stats.firstSeen) : null;
  if (firstSeenDay) firstSeenDay.setHours(0, 0, 0, 0);
  const current = dayPeriodOffset === 0;
  document.getElementById('days-period-label').textContent = periodLabel(dayRange, dayPeriodOffset, days);
  document.getElementById('days-prev-period').disabled = Boolean(firstSeenDay) && days[0].date <= firstSeenDay;
  document.getElementById('days-next-period').disabled = current;

  // Days that have not happened yet must not drag the average down.
  const elapsed = days.filter((d) => !d.upcoming);
  const listened = elapsed.filter((d) => d.total > 0);
  const best = days.reduce((top, d) => (d.total > top.total ? d : top), days[0]);
  const span = dayRange === 7 && current
    ? `${listened.length} of ${elapsed.length} days so far this week`
    : `${listened.length} of ${dayRange} days`;
  const daysNote = document.getElementById('days-note');
  daysNote.textContent = listened.length === 0
    ? (!current ? (dayRange === 7 ? 'Nothing that week.' : `Nothing in those ${dayRange} days.`)
      : dayRange === 7 ? 'Nothing yet this week.' : `Nothing in the last ${dayRange} days.`)
    : `${span} · ${formatDuration(
        elapsed.reduce((sum, d) => sum + d.total, 0) / elapsed.length)} a day on average · best was ${
        best.date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} at ${formatDuration(best.total)}.`;

  renderPeriodSources(days, stats.history || []);

  const hoursDate = dayForOffset(hoursDayOffset);
  const hoursDayEntry = hoursAllTime ? null : (stats.days || {})[dayKey(hoursDate)];
  const hours = hoursAllTime
    ? hourColumns(allTimeHours(stats.days || {}), false)
    : hourColumns((hoursDayEntry && hoursDayEntry.hours) || {}, hoursDayOffset === 0);
  renderChart('chart-hours', hours, hoursAllTime ? 'all' : String(hoursDayOffset));

  document.getElementById('hours-day-nav').hidden = hoursAllTime;
  document.getElementById('hours-day-label').textContent = dayNavLabel(hoursDate);
  document.getElementById('hours-prev-day').disabled = Boolean(firstSeenDay) && hoursDate <= firstSeenDay;
  document.getElementById('hours-next-day').disabled = hoursDayOffset <= 0;

  const peak = hours.reduce((top, h) => (h.total > top.total ? h : top), hours[0]);
  const hoursNote = document.getElementById('hours-note');
  hoursNote.textContent = hoursAllTime && peak.total === 0
    ? 'Nothing recorded by the hour yet.'
    : peak.total > 0
    ? `Your busiest hour ${hoursAllTime ? 'overall is' : 'was'} ${hourLabel(peak.hour)}–${hourLabel((peak.hour + 1) % 24)}, with ${formatDuration(peak.total)} all told.`
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

// Top tracks can be read by time listened or by how often a track came round.
let trackSort = 'seconds';

document.querySelectorAll('.sort-option').forEach((button) => {
  button.addEventListener('click', () => {
    trackSort = button.dataset.sort;
    document.querySelectorAll('.sort-option').forEach((other) => {
      const on = other === button;
      other.classList.toggle('on', on);
      other.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (latest) render(latest);
  });
});

document.querySelectorAll('.range-option').forEach((button) => {
  button.addEventListener('click', () => {
    dayRange = Number(button.dataset.days);
    dayPeriodOffset = 0;
    document.querySelectorAll('.range-option').forEach((other) => {
      const on = other === button;
      other.classList.toggle('on', on);
      other.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    load();
  });
});

document.querySelectorAll('.scope-option').forEach((button) => {
  button.addEventListener('click', () => {
    hoursAllTime = button.dataset.scope === 'all';
    document.querySelectorAll('.scope-option').forEach((other) => {
      const on = other === button;
      other.classList.toggle('on', on);
      other.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    load();
  });
});

document.getElementById('days-prev-period').addEventListener('click', () => {
  dayPeriodOffset += 1;
  load();
});
document.getElementById('days-next-period').addEventListener('click', () => {
  if (dayPeriodOffset <= 0) return;
  dayPeriodOffset -= 1;
  load();
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

// --- Achievements --------------------------------------------------------------

// Badges earned since the Awards tab was last opened. Captured when the tab is
// opened, so they keep their highlight for the rest of this popup's life even
// though the worker is told they've been seen.
let freshAwards = new Set();
let awardsSignature = '';
let latestAwards = null;
// The badge whose details are open, and which badges the grid shows.
let selectedAward = null;
let awardsFilter = 'all';
try {
  const saved = localStorage.getItem('awardsFilter');
  if (['all', 'progress', 'earned'].includes(saved)) awardsFilter = saved;
} catch (_) { /* storage unavailable: start on All */ }

function awardProgress(a) {
  if (a.unit === 'flag') return '';
  // A badge won within one day, week or weekend shows the one you're in.
  const period = a.period ? ` ${a.period}` : '';
  if (a.unit === 'time') return `${formatDuration(a.value)} / ${formatDuration(a.goal)}${period}`;
  const fmt = (n) => Math.floor(n).toLocaleString();
  const suffix = a.unit === 'days' ? ' days' : a.unit === 'weeks' ? ' weeks' : '';
  return `${fmt(a.value)} / ${fmt(a.goal)}${suffix}${period}`;
}

function awardPercent(a) {
  if (a.unlockedAt) return 100;
  return a.goal ? Math.min(99, Math.floor((a.value / a.goal) * 100)) : 0;
}

// What a tile says under its title: when it was earned, or how far along it is.
function awardCaption(a) {
  if (a.unlockedAt) return formatWhen(a.unlockedAt);
  if (a.unit === 'flag') return 'Locked';
  return `${awardPercent(a)}%`;
}

function awardDetail(a) {
  const fresh = freshAwards.has(a.id);
  const status = a.unlockedAt
    ? `<span class="award-detail-status earned">Earned ${escapeHtml(formatWhen(a.unlockedAt))}</span>`
    : a.unit === 'flag'
      ? '<span class="award-detail-status">Not earned yet</span>'
      : `<span class="award-bar"><i style="width:${awardPercent(a)}%"></i></span>
         <span class="award-detail-status">${escapeHtml(awardProgress(a))}<b>${awardPercent(a)}%</b></span>`;
  return `
    <div class="award-detail ${a.unlockedAt ? 'earned' : 'locked'}" id="award-detail" role="region" aria-label="${escapeHtml(a.title)}">
      <span class="award-detail-icon" aria-hidden="true">${a.icon}</span>
      <span class="award-detail-body">
        <span class="award-detail-title">${escapeHtml(a.title)}${fresh ? '<em>New</em>' : ''}</span>
        <small>${escapeHtml(a.text)}</small>
        ${status}
      </span>
    </div>`;
}

function renderAchievements(achievements) {
  latestAwards = achievements;
  const list = (achievements && achievements.list) || [];
  const unseen = (achievements && achievements.unseen) || [];
  document.getElementById('awards-dot').hidden = unseen.length === 0;

  const awardsTabOpen = !document.getElementById('panel-awards').hidden;
  if (awardsTabOpen && unseen.length) {
    unseen.forEach((id) => freshAwards.add(id));
    chrome.runtime.sendMessage({ type: 'seenAchievements' });
  }

  // The poll redraws every two seconds; only rebuild when something moved.
  const signature = JSON.stringify([
    list.map((a) => [a.value, a.unlockedAt]), [...freshAwards], awardsFilter, selectedAward,
  ]);
  if (signature === awardsSignature) return;
  awardsSignature = signature;

  const earned = list.filter((a) => a.unlockedAt);
  const share = list.length ? Math.round((earned.length / list.length) * 100) : 0;
  document.getElementById('awards-unlocked').textContent = earned.length;
  document.getElementById('awards-total').textContent = list.length;
  document.getElementById('awards-ring-fill').setAttribute('stroke-dasharray', `${share} 100`);
  document.getElementById('awards-ring').setAttribute('aria-label', `${earned.length} of ${list.length} achievements earned`);

  // The locked badge you're furthest along on is the one worth chasing.
  const next = list
    .filter((a) => !a.unlockedAt && a.unit !== 'flag')
    .sort((a, b) => b.value / b.goal - a.value / a.goal)[0];
  const nextCard = document.getElementById('awards-next');
  const allDone = list.length > 0 && earned.length === list.length;
  nextCard.hidden = !next && !allDone;
  nextCard.disabled = !next;
  nextCard.dataset.id = next ? next.id : '';
  nextCard.classList.toggle('done', allDone);
  document.getElementById('awards-next-label').textContent = allDone ? 'All done' : 'Closest to earning';
  document.getElementById('awards-next-icon').textContent = allDone ? '🏅' : next ? next.icon : '';
  document.getElementById('awards-next-title').textContent = allDone ? 'Every achievement earned' : next ? next.title : '';
  document.getElementById('awards-next-bar').style.width = `${allDone ? 100 : next ? awardPercent(next) : 0}%`;
  document.getElementById('awards-next-progress').textContent = allDone ? 'Impressive.' : next ? awardProgress(next) : '';
  nextCard.title = next ? `${next.text} — show details` : '';

  const latestEarned = earned.slice().sort((a, b) => b.unlockedAt - a.unlockedAt)[0];
  document.getElementById('awards-recent').textContent = latestEarned
    ? `Latest: ${latestEarned.icon} ${latestEarned.title}` : '';
  document.getElementById('awards-recent').title = latestEarned
    ? `Earned ${formatWhen(latestEarned.unlockedAt)}` : '';

  document.querySelectorAll('.award-filter').forEach((button) => {
    const on = button.dataset.filter === awardsFilter;
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  });

  const shown = (a) => awardsFilter === 'all'
    || (awardsFilter === 'earned' ? Boolean(a.unlockedAt) : !a.unlockedAt);
  const groups = new Map();
  for (const a of list) {
    if (!groups.has(a.group)) groups.set(a.group, []);
    groups.get(a.group).push(a);
  }

  const sections = [...groups].map(([group, items]) => {
    const visible = items.filter(shown);
    if (!visible.length) return '';
    const got = items.filter((a) => a.unlockedAt).length;
    const open = visible.find((a) => a.id === selectedAward);
    return `
    <section class="award-group">
      <h2 class="service-head">${escapeHtml(group)}<span class="per-percent${got === items.length ? ' complete' : ''}">${got}/${items.length}</span></h2>
      <ul class="award-grid">${visible.map((a) => {
        const state = a.unlockedAt ? 'earned' : 'locked';
        const fresh = freshAwards.has(a.id);
        return `
        <li>
          <button class="award-tile ${state}${fresh ? ' fresh' : ''}${a.id === selectedAward ? ' on' : ''}" data-id="${escapeHtml(a.id)}"
            aria-expanded="${a.id === selectedAward}" title="${escapeHtml(a.text)}">
            <span class="award-medal" style="--p:${awardPercent(a)}"><span class="award-icon" aria-hidden="true">${a.icon}</span>${fresh ? '<i class="award-new" aria-label="New"></i>' : ''}</span>
            <span class="award-title">${escapeHtml(a.title)}</span>
            <span class="award-caption">${escapeHtml(awardCaption(a))}</span>
          </button>
        </li>`;
      }).join('')}</ul>
      ${open ? awardDetail(open) : ''}
    </section>`;
  }).join('');

  document.getElementById('awards').innerHTML = sections || (!list.length ? '' : `
    <p class="awards-empty">${awardsFilter === 'earned'
      ? 'Nothing earned yet — your first minute of listening earns First Note.'
      : 'Nothing left to chase. Every achievement is yours.'}</p>`);
}

function selectAward(id, scroll) {
  selectedAward = selectedAward === id ? null : id;
  // A badge hidden by the filter can't open, so show everything to reveal it.
  const a = latestAwards && (latestAwards.list || []).find((x) => x.id === id);
  if (selectedAward && a && awardsFilter !== 'all'
      && (awardsFilter === 'earned') !== Boolean(a.unlockedAt)) {
    setAwardsFilter('all');
  }
  renderAchievements(latestAwards);
  if (scroll && selectedAward) {
    document.getElementById('award-detail')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function setAwardsFilter(filter) {
  awardsFilter = filter;
  try { localStorage.setItem('awardsFilter', filter); } catch (_) { /* not remembered */ }
}

document.getElementById('awards').addEventListener('click', (event) => {
  const tile = event.target.closest('.award-tile');
  if (tile) selectAward(tile.dataset.id, false);
});

document.getElementById('awards-next').addEventListener('click', (event) => {
  const id = event.currentTarget.dataset.id;
  if (!id) return;
  if (selectedAward !== id) selectAward(id, true);
  else document.getElementById('award-detail')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});

document.querySelectorAll('.award-filter').forEach((button) => {
  button.addEventListener('click', () => {
    setAwardsFilter(button.dataset.filter);
    renderAchievements(latestAwards);
  });
});

const TABS = [
  { tab: 'tab-overview', panel: 'panel-overview' },
  { tab: 'tab-analytics', panel: 'panel-analytics' },
  { tab: 'tab-history', panel: 'panel-history' },
  { tab: 'tab-awards', panel: 'panel-awards' },
  { tab: 'tab-playlists', panel: 'panel-playlists' },
];

function showTab(id) {
  for (const entry of TABS) {
    const on = entry.tab === id;
    const tab = document.getElementById(entry.tab);
    tab.classList.toggle('on', on);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.tabIndex = on ? 0 : -1;
    const panel = document.getElementById(entry.panel);
    panel.hidden = !on;
    // Forget what the charts were showing so they grow in again on arrival.
    if (on) panel.querySelectorAll('[data-view]').forEach((el) => { delete el.dataset.view; });
  }
  if (latest) render(latest);
  if (id === 'tab-awards' && latest) renderAchievements(latest.achievements);
}

TABS.forEach((entry, index) => {
  const tab = document.getElementById(entry.tab);
  tab.addEventListener('click', () => showTab(entry.tab));
  // The usual tablist keys: arrows step through the tabs (wrapping round),
  // Home and End jump to the ends.
  tab.addEventListener('keydown', (event) => {
    const moves = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: TABS.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const next = TABS[(moves[event.key] + TABS.length) % TABS.length].tab;
    showTab(next);
    document.getElementById(next).focus();
  });
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

// One hour more than yesterday, across every device — the background script
// announces reaching it, and the iOS app sets the same goal.
function renderGoal(days) {
  const today = sumLastDays(days, 1);
  const goal = sumLastDays(days, 2) - today + 60 * 60;
  const reached = today >= goal;
  document.getElementById('goal').classList.toggle('reached', reached);
  document.getElementById('goal-fill').style.width = `${Math.min(100, (today / goal) * 100)}%`;
  document.getElementById('goal-value').textContent = formatDuration(goal);
  document.getElementById('goal-left').textContent = reached ? '✓ Goal reached' : `${formatDuration(goal - today)} to go`;
}

function render(stats) {
  latest = stats;
  const days = stats.days || {};
  const favorites = stats.favorites || {};
  setValue('today-value', formatDuration(sumLastDays(days, 1)));
  renderGoal(days);
  setValue('week-value', formatDuration(sumLastDays(days, 7)));
  setValue('month-value', formatDuration(sumLastDays(days, 30)));
  setValue('all-value', formatDuration(stats.total || 0));

  renderNowPlaying(stats);
  renderSources(stats);
  renderAnalytics(stats);
  renderHistory(stats.history);
  renderAchievements(stats.achievements);
  renderPlaylists(stats);
  renderSync(stats.sync);
  // Skeletons stand in for the numbers until the other devices' stats arrive.
  document.body.classList.toggle('loading', Boolean(stats.sync && stats.sync.loading));

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
    // Whichever measure is selected leads; the other one breaks its ties.
    .sort((a, b) => (trackSort === 'plays'
      ? (b.plays || 0) - (a.plays || 0) || b.seconds - a.seconds
      : b.seconds - a.seconds || (b.plays || 0) - (a.plays || 0)))
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
    closePopup();
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

// While a playlist plays in this tab, previous and next step through its songs
// rather than the site's own queue.
function playlistInTab(tabId) {
  const playing = latest && latest.playlistPlaying;
  return Boolean(playing && tabId && playing.tabId === tabId);
}

async function sendControl(action, value) {
  if (!current || !current.tabId) return;
  if ((action === 'prev' || action === 'next') && playlistInTab(current.tabId)) {
    chrome.runtime.sendMessage({ type: 'stepPlaylist', delta: action === 'next' ? 1 : -1 });
    setTimeout(load, 400);
    return;
  }
  try {
    await chrome.tabs.sendMessage(current.tabId, { type: 'control', action, value });
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

document.getElementById('now-add').addEventListener('click', (event) => {
  event.stopPropagation();
  if (!current) return;
  openAddDialog({ id: current.id, title: current.title, artist: current.artist, source: current.source });
});

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
  // Signed in, a refresh also trades numbers with the other devices first.
  if (latest && latest.sync && latest.sync.signedIn) await chrome.runtime.sendMessage({ type: 'syncNow' });
  await load();
  // Brief flash so a click that changes nothing still feels like it did something.
  setTimeout(() => refreshButton.classList.remove('busy'), 200);
});

// --- Sync --------------------------------------------------------------------

function formatAgo(ts) {
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return formatWhen(ts);
}

// What the sign-in attempt has to say (waiting, or why it failed). The poll
// redraws the bar every 2 seconds and must not wipe this out.
let signInNote = null;

function renderSync(sync) {
  const section = document.getElementById('sync');
  // Until firebase-config.js is filled in there is nothing to offer.
  if (!sync || !sync.configured) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const status = document.getElementById('sync-status');
  const action = document.getElementById('sync-action');
  if (!sync.signedIn) {
    const note = signInNote || (sync.signInError && { text: `Sign-in failed: ${sync.signInError}`, error: true });
    status.textContent = note ? note.text : 'Sign in to combine these stats with the iPhone app.';
    status.classList.toggle('error', Boolean(note && note.error));
    action.textContent = 'Sign in';
    action.dataset.action = 'signIn';
    return;
  }

  const others = sync.devices.length;
  const parts = [sync.email];
  if (others > 0) parts.push(`+ ${others} other ${others === 1 ? 'device' : 'devices'}`);
  if (sync.busy) parts.push('syncing…');
  else if (sync.lastSync) parts.push(`synced ${formatAgo(sync.lastSync)}`);
  status.textContent = sync.error ? `Sync failed: ${sync.error}` : parts.join(' · ');
  status.title = sync.devices.map((d) => d.name).join(', ');
  status.classList.toggle('error', Boolean(sync.error));
  action.textContent = 'Sign out';
  action.dataset.action = 'signOut';
}

document.getElementById('sync-action').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const type = button.dataset.action;
  if (!type) return;
  button.disabled = true;
  if (type === 'signIn') {
    signInNote = { text: 'Waiting for the Google window… check behind this one.' };
    if (latest) renderSync(latest.sync);
  }
  // Signing in opens Google's account picker, which can close this popup; the
  // worker carries on regardless and the next open shows the result.
  const reply = await chrome.runtime.sendMessage({ type });
  button.disabled = false;
  signInNote = reply && reply.error ? { text: `Sign-in failed: ${reply.error}`, error: true } : null;
  load();
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
  else if (!addOverlay.hidden) closeAddDialog();
  else if (openPlaylistId && !document.getElementById('panel-playlists').hidden) closePlaylist();
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
  // Every month is named: each of the twelve columns is wide enough for a
  // short name, and single letters every other month left half the bars (and
  // the J/J, M/M, A/A pairs) unaccounted for.
  return months.map((m) => ({
    ...m,
    tick: m.start.toLocaleDateString(undefined, { month: 'short' }),
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
  ios: '#4aa8ff',
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
    ctx.fillText(fit(ctx, column.tick, columnWidth + gap), left + columnWidth / 2, y + height + 40);
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

const pinButton = document.getElementById('pin');
if (PINNED) {
  pinButton.setAttribute('aria-pressed', 'true');
  pinButton.title = 'Unpin: close this window';
  pinButton.setAttribute('aria-label', pinButton.title);
}
pinButton.addEventListener('click', async () => {
  if (PINNED) {
    window.close();
    return;
  }
  const reply = await chrome.runtime.sendMessage({ type: 'pinPopup' }).catch(() => null);
  if (reply && reply.ok) window.close();
});

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


// --- Progress bar ------------------------------------------------------------
//
// The page is asked for its position only on each poll; between polls the bar
// advances on its own clock, and the next poll corrects any drift.

const seekBar = document.getElementById('now-seek');
const seekFill = document.getElementById('now-seek-fill');
const seekTime = document.getElementById('now-seek-time');
let progress = null; // { position, duration, at, paused }
let dragFraction = null;

function clock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function syncProgress(playing) {
  const known = Number.isFinite(playing.position) && Number.isFinite(playing.duration) && playing.duration > 0;
  progress = known
    ? { position: playing.position, duration: playing.duration, at: performance.now(), paused: Boolean(playing.paused) }
    : null;
  // Seeking needs a tab to talk to and a known length.
  seekBar.hidden = !(progress && playing.canControl && playing.tabId);
  paintProgress();
}

function livePosition() {
  if (!progress) return 0;
  const elapsed = progress.paused ? 0 : (performance.now() - progress.at) / 1000;
  return Math.min(progress.duration, progress.position + elapsed);
}

function paintProgress() {
  if (!progress || seekBar.hidden || dragFraction !== null) return;
  const position = livePosition();
  seekFill.style.width = `${(position / progress.duration) * 100}%`;
  seekBar.setAttribute('aria-valuemax', String(Math.round(progress.duration)));
  seekBar.setAttribute('aria-valuenow', String(Math.round(position)));
  seekBar.setAttribute('aria-valuetext', `${clock(position)} of ${clock(progress.duration)}`);
}

setInterval(paintProgress, 250);

function fractionAt(event) {
  const rect = seekBar.getBoundingClientRect();
  return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
}

function showSeek(fraction) {
  if (!progress) return;
  seekFill.style.width = `${fraction * 100}%`;
  seekTime.textContent = clock(fraction * progress.duration);
  seekTime.style.left = `${Math.max(14, Math.min(seekBar.clientWidth - 14, fraction * seekBar.clientWidth))}px`;
}

seekBar.addEventListener('mousemove', (event) => {
  if (dragFraction === null) showSeek(fractionAt(event));
});
seekBar.addEventListener('mouseleave', () => paintProgress());
seekBar.addEventListener('click', (event) => event.stopPropagation());
seekBar.addEventListener('auxclick', (event) => event.stopPropagation());

seekBar.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || !progress) return;
  event.preventDefault();
  event.stopPropagation();
  seekBar.classList.add('dragging');
  dragFraction = fractionAt(event);
  showSeek(dragFraction);

  const move = (e) => { dragFraction = fractionAt(e); showSeek(dragFraction); };
  const up = (e) => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    const fraction = fractionAt(e);
    seekBar.classList.remove('dragging');
    dragFraction = null;
    if (!progress) return;
    const target = fraction * progress.duration;
    // Land the bar where the user let go without waiting for the page.
    progress.position = target;
    progress.at = performance.now();
    paintProgress();
    sendControl('seek', target);
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
});


// --- Playlists ---------------------------------------------------------------
//
// The worker keeps them and plays them (playlists.js); this tab lists them, edits
// them and starts them. Like the other lists, it is redrawn by the 2-second poll,
// so the lists are only rebuilt when what they show has changed — the inputs are
// fixed in the page and never rebuilt at all.

// The playlist open in the detail view, or null for the list of them.
let openPlaylistId = null;
let playlistsSignature = '';
let playlistTracksSignature = '';
// The song just removed from the open playlist, for a few seconds, so Undo can put it back.
let removedSong = null;
let removedTimer = null;

// Below this many playlists the whole list fits, and a search field is only clutter.
const PLAYLIST_SEARCH_FROM = 6;

const PLAY_ICON = '<svg class="icon-play" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3l8 5-8 5z"/></svg>';
const STOP_ICON = '<svg class="icon-stop" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4h8v8H4z"/></svg>';
const PULSE = '<span class="pulse" aria-hidden="true"><i></i><i></i><i></i></span>';
const NOTE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12 2v8.5a2 2 0 1 1-1.5-1.94V4.5L6 5.5v6.5a2 2 0 1 1-1.5-1.94V3.5z"/></svg>';

function playlistsByName(playlists) {
  return Object.values(playlists || {})
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.createdAt - b.createdAt);
}

function songCount(count) {
  return `${count} ${count === 1 ? 'song' : 'songs'}`;
}

function serviceDots(tracks) {
  const sources = CHART_SOURCES.filter((source) => tracks.some((t) => t.source === source));
  return sources.length
    ? `<span class="pl-dots" title="${escapeHtml(sources.map((s) => SOURCE_NAMES[s]).join(', '))}">${
      sources.map((s) => `<i class="${s}"></i>`).join('')}</span>`
    : '';
}

// Four different song covers in a grid, or the first one alone when there are
// fewer, or a note in the first song's service colour when there are none.
function playlistCover(tracks, size = '') {
  const covers = [...new Set(tracks.map(trackThumbnail).filter(Boolean))];
  const img = (src) => `<img src="${escapeHtml(src)}" alt="" loading="lazy">`;
  if (covers.length >= 4) return `<span class="pl-cover grid ${size}" aria-hidden="true">${covers.slice(0, 4).map(img).join('')}</span>`;
  if (covers.length) return `<span class="pl-cover ${size}" aria-hidden="true">${img(covers[0])}</span>`;
  return `<span class="pl-cover empty ${tracks.length ? tracks[0].source : ''} ${size}" aria-hidden="true">${NOTE_ICON}</span>`;
}

// A cover that won't load leaves its tile's background in its place.
function hideBrokenCovers(root) {
  root.querySelectorAll('.pl-cover img').forEach((img) => {
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; }, { once: true });
  });
}

function playingPosition(playing) {
  return `${Math.min(playing.index + 1, playing.count)} of ${playing.count}`;
}

function playlistMessage(type, fields) {
  return chrome.runtime.sendMessage({ type, ...fields });
}

function setNote(el, text, error = false) {
  el.textContent = text || '';
  el.classList.toggle('error', Boolean(error));
}

function renderPlaylists(stats) {
  const playlists = stats.playlists || {};
  const playing = stats.playlistPlaying || null;

  const bar = document.getElementById('pl-playing');
  bar.hidden = !playing;
  if (playing) {
    document.getElementById('pl-playing-name').textContent = playing.name;
    document.getElementById('pl-playing-pos').textContent = playingPosition(playing);
    document.getElementById('pl-progress-fill').style.width =
      `${playing.count ? (Math.min(playing.index + 1, playing.count) / playing.count) * 100 : 0}%`;
  }

  if (openPlaylistId && !playlists[openPlaylistId]) openPlaylistId = null;
  document.getElementById('pl-index').hidden = Boolean(openPlaylistId);
  document.getElementById('pl-detail').hidden = !openPlaylistId;

  const all = playlistsByName(playlists);
  document.getElementById('pl-total').textContent = all.length ? String(all.length) : '';
  const search = document.getElementById('pl-search');
  const searchWrap = document.getElementById('pl-search-wrap');
  // Kept while it holds a search, so deleting down to five doesn't hide what filtered them.
  searchWrap.hidden = all.length < PLAYLIST_SEARCH_FROM && !search.value;
  const query = search.value.trim().toLocaleLowerCase();
  const shown = query ? all.filter((p) => p.name.toLocaleLowerCase().includes(query)) : all;

  const signature = JSON.stringify([shown, playing && [playing.id, playing.index, playing.count], all.length]);
  if (signature !== playlistsSignature) {
    playlistsSignature = signature;
    const list = document.getElementById('pl-list');
    const scroll = list.scrollTop;
    const focused = document.activeElement && list.contains(document.activeElement)
      ? document.activeElement.closest('li[data-id]') : null;
    list.innerHTML = shown.length
      ? shown.map((p) => {
        const on = Boolean(playing && playing.id === p.id);
        const name = escapeHtml(p.name);
        return `
        <li class="clickable pl-row${on ? ' playing' : ''}" data-id="${escapeHtml(p.id)}" tabindex="0" role="button" aria-label="Open ${name}" title="Open ${name}">
          ${playlistCover(p.tracks)}
          <span class="name">${name}<small>${on
            ? `<span class="pl-now">Playing ${playingPosition(playing)}</span>`
            : songCount(p.tracks.length)}${serviceDots(p.tracks)}</small></span>
          ${on
            ? `<button class="pl-row-play" data-stop="1" title="Stop the playlist" aria-label="Stop ${name}">${PULSE}${STOP_ICON}</button>`
            : p.tracks.length
              ? `<button class="pl-row-play" data-id="${escapeHtml(p.id)}" title="Play" aria-label="Play ${name}">${PLAY_ICON}</button>`
              : ''}
        </li>`;
      }).join('')
      : all.length
        ? '<li class="empty">No matching playlists.</li>'
        : `<li class="pl-empty">${playlistCover([], 'large')}<b>No playlists yet</b><span>Name one above, or use the + on any song.</span></li>`;
    list.scrollTop = scroll;
    hideBrokenCovers(list);
    list.querySelectorAll('li[data-id]').forEach((li) => {
      li.addEventListener('click', (event) => {
        if (event.target.closest('button')) return;
        showPlaylist(li.dataset.id);
      });
      li.addEventListener('keydown', (event) => {
        if (event.target !== li || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        showPlaylist(li.dataset.id);
      });
    });
    list.querySelectorAll('button.pl-row-play').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        flash(button, 'press');
        if (button.dataset.stop) stopPlaylistNow();
        else playPlaylist(button.dataset.id, 0);
      });
    });
    // A redraw while a row had the keyboard's focus hands it to the same row.
    if (focused) {
      const again = list.querySelector(`li[data-id="${CSS.escape(focused.dataset.id)}"]`);
      if (again) again.focus();
    }
  }

  if (openPlaylistId) renderPlaylistDetail(playlists[openPlaylistId], playing);
}

function renderPlaylistDetail(playlist, playing) {
  const name = document.getElementById('pl-name');
  if (document.activeElement !== name && name.value !== playlist.name) name.value = playlist.name;

  const tracks = playlist.tracks;
  const on = Boolean(playing && playing.id === playlist.id);
  const play = document.getElementById('pl-play');
  play.disabled = tracks.length === 0;
  play.querySelector('span').textContent = on ? 'Start over' : 'Play';
  play.title = tracks.length ? 'Play from the first song' : 'Add a song to play this playlist';

  const services = new Set(tracks.map((t) => t.source)).size;
  document.getElementById('pl-meta').innerHTML = on
    ? `<span class="pl-now">Playing ${playingPosition(playing)}</span>${serviceDots(tracks)}`
    : tracks.length
      ? `${songCount(tracks.length)}${services > 1 ? ` · ${services} services` : ''}${serviceDots(tracks)}`
      : 'Empty playlist';

  const currentIndex = on ? playing.index : -1;
  const signature = JSON.stringify([tracks, currentIndex]);
  // Rebuilding the rows mid-drag would drop the one in your hand.
  if (signature === playlistTracksSignature || trackDrag) return;
  playlistTracksSignature = signature;

  const cover = document.getElementById('pl-cover');
  cover.innerHTML = playlistCover(tracks, 'large');
  hideBrokenCovers(cover);

  const list = document.getElementById('pl-tracks');
  const note = document.getElementById('pl-detail-note');
  if (tracks.length === 0) {
    list.innerHTML = '<li class="empty">No songs yet. Use the + on any song, or paste a link above.</li>';
    note.textContent = '';
    return;
  }
  const scroll = list.scrollTop;
  list.innerHTML = tracks.map((t, index) => {
    const thumb = trackThumbnail(t);
    return `
    <li class="clickable${index === currentIndex ? ' current' : ''}" data-index="${index}" title="Click to play the playlist from here, drag to move">
      <span class="pos" tabindex="0" role="button" aria-label="Move ${escapeHtml(t.title || t.id)}: Alt and the arrow keys"><span class="pos-num">${index === currentIndex ? PULSE : index + 1}</span><svg class="grip" viewBox="0 0 10 16" aria-hidden="true"><circle cx="3" cy="3" r="1.4"/><circle cx="7" cy="3" r="1.4"/><circle cx="3" cy="8" r="1.4"/><circle cx="7" cy="8" r="1.4"/><circle cx="3" cy="13" r="1.4"/><circle cx="7" cy="13" r="1.4"/></svg></span>
      ${thumb
        ? `<img class="thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy">`
        : '<span class="thumb thumb-empty">♪</span>'}
      <span class="name">${escapeHtml(t.title || t.id)}<small>${escapeHtml(
        [t.artist, SOURCE_NAMES[t.source]].filter(Boolean).join(' · '))}</small></span>
      <button class="row-btn remove" data-remove="${index}" title="Remove from the playlist" aria-label="Remove ${escapeHtml(t.title || t.id)} from the playlist">×</button>
    </li>`;
  }).join('');
  list.scrollTop = scroll;

  list.querySelectorAll('img.thumb').forEach((img) => {
    img.addEventListener('error', () => {
      const placeholder = document.createElement('span');
      placeholder.className = 'thumb thumb-empty';
      placeholder.textContent = '♪';
      img.replaceWith(placeholder);
    }, { once: true });
  });
  list.querySelectorAll('li.clickable').forEach((li) => {
    li.addEventListener('pointerdown', (event) => startTrackDrag(event, li, playlist.id));
    li.addEventListener('click', (event) => {
      if (event.target.closest('button') || li.dataset.dragged) return;
      playPlaylist(playlist.id, Number(li.dataset.index));
    });
  });
  list.querySelectorAll('.pos').forEach((grip) => {
    grip.addEventListener('keydown', (event) => {
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      event.preventDefault();
      const from = Number(grip.closest('li').dataset.index);
      const to = from + (event.key === 'ArrowUp' ? -1 : 1);
      if (to < 0 || to >= tracks.length) return;
      moveTrack(playlist.id, from, to);
      // Keep the focus on the song that moved, so it can keep going.
      list.querySelector(`li[data-index="${to}"] .pos`).focus();
    });
  });
  list.querySelectorAll('button[data-remove]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const index = Number(button.dataset.remove);
      const track = tracks[index];
      const reply = await playlistMessage('removeFromPlaylist', { id: playlist.id, index });
      if (reply && reply.playlist && track) offerUndo(playlist.id, track, index);
      load();
    });
  });

  note.textContent = 'Click a song to play from there, drag it to move it.';
}

// --- Reordering by drag ------------------------------------------------------
//
// Pointer events rather than HTML drag and drop, so the row itself follows the
// pointer and the others slide out of its way. A press only turns into a drag
// once it has moved a few pixels; until then it is still a click that plays.

const DRAG_THRESHOLD = 4;
const DRAG_EDGE = 28;
let trackDrag = null;

// Shown at once from the popup's own copy; the worker's answer follows.
function moveTrack(playlistId, from, to) {
  const playlist = latest && latest.playlists && latest.playlists[playlistId];
  if (playlist) {
    const [track] = playlist.tracks.splice(from, 1);
    playlist.tracks.splice(to, 0, track);
    const playing = latest.playlistPlaying;
    if (playing && playing.id === playlistId) {
      if (playing.index === from) playing.index = to;
      else if (from < playing.index && to >= playing.index) playing.index -= 1;
      else if (from > playing.index && to <= playing.index) playing.index += 1;
    }
    playlistTracksSignature = '';
    renderPlaylists(latest);
  }
  playlistMessage('moveInPlaylist', { id: playlistId, from, to }).then(load);
}

function startTrackDrag(event, li, playlistId) {
  if (event.button !== 0 || trackDrag || event.target.closest('button')) return;
  const list = li.parentElement;
  const rows = [...list.querySelectorAll('li[data-index]')];
  if (rows.length < 2) return;

  const from = rows.indexOf(li);
  const tops = rows.map((row) => row.offsetTop);
  const slot = tops[1] - tops[0];
  // In the list's own coordinates, so scrolling it mid-drag doesn't throw it off.
  const pointerY = (clientY) => clientY - list.getBoundingClientRect().top + list.scrollTop;
  const startY = pointerY(event.clientY);
  let clientY = event.clientY;
  let to = from;
  let dragging = false;
  let frame = 0;
  delete li.dataset.dragged;

  const place = () => {
    const dy = Math.max(tops[0] - tops[from], Math.min(tops[rows.length - 1] - tops[from], pointerY(clientY) - startY));
    li.style.transform = `translateY(${dy}px)`;
    to = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / slot)));
    rows.forEach((row, i) => {
      if (row === li) return;
      const shift = from < to && i > from && i <= to ? -slot : from > to && i < from && i >= to ? slot : 0;
      row.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  };

  // Near the list's top or bottom edge, scroll it, faster the closer you get.
  const autoScroll = () => {
    const box = list.getBoundingClientRect();
    const speed = clientY < box.top + DRAG_EDGE ? -(box.top + DRAG_EDGE - clientY)
      : clientY > box.bottom - DRAG_EDGE ? clientY - (box.bottom - DRAG_EDGE) : 0;
    if (speed) {
      list.scrollTop += speed / 3;
      place();
    }
    frame = requestAnimationFrame(autoScroll);
  };

  const move = (e) => {
    clientY = e.clientY;
    if (!dragging) {
      if (Math.abs(pointerY(clientY) - startY) < DRAG_THRESHOLD) return;
      dragging = true;
      trackDrag = { playlistId };
      li.dataset.dragged = '1';
      li.classList.add('dragging');
      list.classList.add('sorting');
      frame = requestAnimationFrame(autoScroll);
    }
    place();
  };

  const end = () => {
    li.removeEventListener('pointermove', move);
    li.removeEventListener('pointerup', end);
    li.removeEventListener('pointercancel', end);
    if (!dragging) return;
    cancelAnimationFrame(frame);
    li.classList.remove('dragging');
    list.classList.remove('sorting');
    rows.forEach((row) => { row.style.transform = ''; });
    trackDrag = null;
    if (to !== from) moveTrack(playlistId, from, to);
    // The click that follows the release is not a request to play.
    setTimeout(() => { delete li.dataset.dragged; }, 0);
  };

  try {
    li.setPointerCapture(event.pointerId);
  } catch (err) {
    // Not a live pointer; the moves still arrive while it stays over the row.
  }
  li.addEventListener('pointermove', move);
  li.addEventListener('pointerup', end);
  li.addEventListener('pointercancel', end);
}

// --- Undoing a removal ------------------------------------------------------
//
// The × is a single click away from a title, so a removal can be taken back for
// a few seconds: the song goes back in at the end, then moves to where it was.

const linkNote = document.getElementById('pl-link-note');

function offerUndo(playlistId, track, index) {
  removedSong = { playlistId, track, index };
  linkNote.classList.remove('error');
  linkNote.innerHTML = `Removed ${escapeHtml(track.title || track.id)}.<button type="button" class="pl-undo">Undo</button>`;
  linkNote.querySelector('.pl-undo').addEventListener('click', undoRemove);
  clearTimeout(removedTimer);
  removedTimer = setTimeout(clearUndo, 6000);
}

function clearUndo() {
  clearTimeout(removedTimer);
  removedSong = null;
  if (linkNote.querySelector('.pl-undo')) setNote(linkNote, '');
}

async function undoRemove() {
  const undo = removedSong;
  clearUndo();
  if (!undo) return;
  const reply = await playlistMessage('addToPlaylist', { id: undo.playlistId, track: undo.track });
  if (!reply || reply.error) {
    setNote(linkNote, (reply && reply.error) || 'Could not put the song back.', true);
    return;
  }
  const last = reply.playlist.tracks.length - 1;
  const to = Math.min(undo.index, last);
  if (to !== last) await playlistMessage('moveInPlaylist', { id: undo.playlistId, from: last, to });
  load();
}

// --- Moving between the list and a playlist ---------------------------------

function showPlaylist(id) {
  openPlaylistId = id;
  playlistTracksSignature = '';
  clearUndo();
  setNote(linkNote, '');
  resetDeleteButton();
  document.getElementById('pl-tracks').scrollTop = 0;
  if (latest) renderPlaylists(latest);
}

// Back to the list, with the keyboard's focus on the playlist it came from.
function closePlaylist() {
  const id = openPlaylistId;
  openPlaylistId = null;
  clearUndo();
  resetDeleteButton();
  if (latest) renderPlaylists(latest);
  const row = id && document.querySelector(`#pl-list li[data-id="${CSS.escape(id)}"]`);
  if (row) row.focus();
}

function playPlaylist(id, index) {
  playlistMessage('playPlaylist', { id, index });
  // The song takes a few seconds to open; the poll shows it once it has.
  setTimeout(load, 600);
}

function stopPlaylistNow() {
  playlistMessage('stopPlaylist');
  setTimeout(load, 400);
}

// The create and add buttons only light up once there is something to submit.
function enableWhenFilled(input) {
  const button = input.form.querySelector('button[type="submit"]');
  const update = () => { button.disabled = !input.value.trim(); };
  input.addEventListener('input', update);
  return update;
}

const createInput = document.getElementById('pl-create-name');
const updateCreateButton = enableWhenFilled(createInput);
document.getElementById('pl-create').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!createInput.value.trim()) return;
  const reply = await playlistMessage('createPlaylist', { name: createInput.value });
  if (reply && reply.playlist) {
    createInput.value = '';
    updateCreateButton();
    document.getElementById('pl-search').value = '';
    await load();
    showPlaylist(reply.playlist.id);
    // Straight on to the songs: the link field is what a new playlist needs next.
    document.getElementById('pl-link-url').focus();
  }
});

document.getElementById('pl-search').addEventListener('input', () => {
  if (latest) renderPlaylists(latest);
});

document.getElementById('pl-back').addEventListener('click', closePlaylist);
document.getElementById('pl-playing-open').addEventListener('click', () => {
  const playing = latest && latest.playlistPlaying;
  if (playing && playing.id !== openPlaylistId) showPlaylist(playing.id);
});

const playlistNameInput = document.getElementById('pl-name');
async function renameOpenPlaylist() {
  if (!openPlaylistId) return;
  await playlistMessage('renamePlaylist', { id: openPlaylistId, name: playlistNameInput.value });
  load();
}
playlistNameInput.addEventListener('change', renameOpenPlaylist);
playlistNameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') playlistNameInput.blur();
  // Escape gives up the rename, rather than leaving the playlist.
  if (event.key === 'Escape') {
    event.stopPropagation();
    const playlist = latest && latest.playlists && latest.playlists[openPlaylistId];
    if (playlist) playlistNameInput.value = playlist.name;
    playlistNameInput.blur();
  }
});
playlistNameInput.addEventListener('focus', () => playlistNameInput.select());

document.getElementById('pl-play').addEventListener('click', () => {
  if (openPlaylistId) playPlaylist(openPlaylistId, 0);
});

// Deleting asks once more on the button itself rather than with a dialog.
const deleteButton = document.getElementById('pl-delete');
let deleteTimer = null;
function resetDeleteButton() {
  clearTimeout(deleteTimer);
  deleteButton.classList.remove('confirming');
  deleteButton.querySelector('span').textContent = 'Delete';
}
deleteButton.addEventListener('click', async () => {
  if (!openPlaylistId) return;
  if (!deleteButton.classList.contains('confirming')) {
    deleteButton.classList.add('confirming');
    deleteButton.querySelector('span').textContent = 'Delete?';
    deleteTimer = setTimeout(resetDeleteButton, 3000);
    return;
  }
  resetDeleteButton();
  await playlistMessage('deletePlaylist', { id: openPlaylistId });
  openPlaylistId = null;
  load();
});

const linkForm = document.getElementById('pl-link');
const linkInput = document.getElementById('pl-link-url');
const updateLinkButton = enableWhenFilled(linkInput);
linkForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = linkForm.querySelector('button');
  if (!openPlaylistId || !linkInput.value.trim() || button.dataset.busy) return;
  button.dataset.busy = '1';
  button.disabled = true;
  clearUndo();
  setNote(linkNote, 'Looking it up…');
  try {
    const found = await playlistMessage('resolveSongLink', { url: linkInput.value });
    if (!found || found.error) {
      setNote(linkNote, (found && found.error) || 'Could not read that link.', true);
      return;
    }
    const reply = await playlistMessage('addToPlaylist', { id: openPlaylistId, track: found.track });
    if (reply && reply.error) {
      setNote(linkNote, reply.error, true);
      return;
    }
    linkInput.value = '';
    const added = `Added ${found.track.title}.`;
    setNote(linkNote, added);
    setTimeout(() => { if (linkNote.textContent === added) setNote(linkNote, ''); }, 3000);
    load();
  } finally {
    delete button.dataset.busy;
    updateLinkButton();
  }
});
// A pasted link is the whole request, so it is added without a further click.
linkInput.addEventListener('paste', () => {
  setTimeout(() => {
    updateLinkButton();
    if (/^https?:\/\//i.test(linkInput.value.trim())) linkForm.requestSubmit();
  }, 0);
});

document.getElementById('pl-prev').addEventListener('click', (event) => {
  flash(event.currentTarget, 'press');
  playlistMessage('stepPlaylist', { delta: -1 });
  setTimeout(load, 600);
});
document.getElementById('pl-next').addEventListener('click', (event) => {
  flash(event.currentTarget, 'press');
  playlistMessage('stepPlaylist', { delta: 1 });
  setTimeout(load, 600);
});
document.getElementById('pl-stop').addEventListener('click', (event) => {
  flash(event.currentTarget, 'press');
  stopPlaylistNow();
});

// --- Adding a song to a playlist ---------------------------------------------

const addOverlay = document.getElementById('add-overlay');
const addNote = document.getElementById('add-note');
const addCreateInput = document.getElementById('add-create-name');
const updateAddCreateButton = enableWhenFilled(addCreateInput);
let addingTrack = null;

function openAddDialog(track) {
  if (!track || !(track.title || track.id)) return;
  addingTrack = { id: track.id || '', title: track.title || '', artist: track.artist || '', source: track.source };
  const thumb = trackThumbnail(addingTrack);
  document.getElementById('add-song').innerHTML = `${thumb
    ? `<img class="thumb" src="${escapeHtml(thumb)}" alt="">`
    : '<span class="thumb thumb-empty">♪</span>'}<span class="name">${escapeHtml(addingTrack.title || addingTrack.id)}<small>${escapeHtml(
    [addingTrack.artist, SOURCE_NAMES[addingTrack.source]].filter(Boolean).join(' · '))}</small></span>`;
  const img = document.querySelector('#add-song img');
  if (img) img.addEventListener('error', () => { img.style.visibility = 'hidden'; }, { once: true });
  setNote(addNote, '');
  addCreateInput.value = '';
  updateAddCreateButton();
  renderAddList();
  addOverlay.hidden = false;
  // With no playlists yet, naming one is the only thing to do.
  if (!Object.keys((latest && latest.playlists) || {}).length) addCreateInput.focus();
}

function closeAddDialog() {
  addOverlay.hidden = true;
  addingTrack = null;
}

function renderAddList() {
  const list = document.getElementById('add-list');
  const sorted = playlistsByName(latest && latest.playlists);
  const key = `${addingTrack.source}:${addingTrack.id || addingTrack.title}`;
  list.innerHTML = sorted.length
    ? sorted.map((p) => {
      const has = p.tracks.some((t) => `${t.source}:${t.id || t.title}` === key);
      const name = escapeHtml(p.name);
      return `
      <li class="clickable${has ? ' has' : ''}" data-id="${escapeHtml(p.id)}" tabindex="0" role="button"
        title="${has ? 'Already in this playlist' : `Add to ${name}`}" aria-label="${has ? `Already in ${name}` : `Add to ${name}`}">
        ${playlistCover(p.tracks, 'small')}
        <span class="name">${name}<small>${songCount(p.tracks.length)}</small></span>
        <span class="add-state" aria-hidden="true">${has ? '✓' : '+'}</span>
      </li>`;
    }).join('')
    : '<li class="empty">No playlists yet — name one below.</li>';
  hideBrokenCovers(list);
  list.querySelectorAll('li[data-id]').forEach((li) => {
    const add = async () => {
      if (li.classList.contains('has')) {
        setNote(addNote, 'Already in that playlist.');
        return;
      }
      const reply = await playlistMessage('addToPlaylist', { id: li.dataset.id, track: addingTrack });
      if (reply && reply.error) {
        setNote(addNote, reply.error, true);
        return;
      }
      await load();
      closeAddDialog();
    };
    li.addEventListener('click', add);
    li.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      add();
    });
  });
}

document.getElementById('add-create').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!addCreateInput.value.trim()) return;
  const reply = await playlistMessage('createPlaylist', { name: addCreateInput.value, track: addingTrack });
  if (!reply || reply.error) {
    setNote(addNote, (reply && reply.error) || 'Could not create the playlist.', true);
    return;
  }
  await load();
  closeAddDialog();
});

document.getElementById('add-close').addEventListener('click', closeAddDialog);
addOverlay.addEventListener('click', (event) => {
  if (event.target === addOverlay) closeAddDialog();
});
