// Finding the music tabs and asking them what they hold. Loaded by both the
// popup and the service worker (which reports it to the phone; see live.js).

const YT_ID = /^[\w-]{11}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

// Where a track row should take you: straight to the track when we captured a
// usable id, otherwise a search on the service it was played on.
function trackUrl(track) {
  const id = track.id || '';
  const query = encodeURIComponent([track.artist, track.title].filter(Boolean).join(' '));

  // Songs counted on the iPhone come from its own music library, which no web
  // page can open; a YouTube search is the nearest place to play them.
  if (track.source === 'ios') return `https://www.youtube.com/results?search_query=${query}`;
  if (track.source === 'spotify') {
    return SPOTIFY_ID.test(id)
      ? `https://open.spotify.com/track/${id}`
      : `https://open.spotify.com/search/${query}`;
  }
  if (track.source === 'ytmusic') {
    return YT_ID.test(id)
      ? `https://music.youtube.com/watch?v=${id}`
      : `https://www.youtube.com/results?search_query=${query}`;
  }
  return YT_ID.test(id)
    ? `https://www.youtube.com/watch?v=${id}`
    : `https://www.youtube.com/results?search_query=${query}`;
}

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
