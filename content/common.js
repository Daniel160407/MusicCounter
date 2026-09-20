// Shared heartbeat plumbing for every supported site.
//
// A site adapter implements probe() and returns either null (nothing musical
// is playing right now) or { source, title, artist, id }. This file turns a
// sequence of probes into elapsed-time ticks and ships them to the worker.

(() => {
  const CHECK_MS = 5000;
  // Background tabs get their timers throttled, so a tick can cover far more
  // than CHECK_MS of wall clock. Allow that, but cap it so a suspended laptop
  // can never dump an hour into the totals at once.
  const MAX_TICK_MS = 125000;
  // A play is only credited once half the track has actually been listened to,
  // so skipping through songs no longer inflates the play counts.
  const PLAY_FRACTION = 0.5;
  // History gets an entry earlier, once a smaller fraction has been heard, so
  // a song you didn't finish still shows up in "recently played".
  const HISTORY_FRACTION = 0.2;
  // Tracks whose length we cannot read — live streams, an older Spotify layout —
  // fall back to a flat minute of listening.
  const UNKNOWN_DURATION_MS = 60000;

  function mediaIsAudiblyPlaying(el) {
    if (!el) return false;
    if (el.paused || el.ended) return false;
    if (el.readyState < 2) return false;
    if (el.muted || el.volume === 0) return false;
    return true;
  }

  function findPlayingMedia(root = document) {
    for (const el of root.querySelectorAll('video, audio')) {
      if (mediaIsAudiblyPlaying(el)) return el;
    }
    return null;
  }

  function anyMediaPresent(root = document) {
    return root.querySelector('video, audio') !== null;
  }

  // The element the player is using, playing or paused. findPlayingMedia is the
  // one the counters ask about — this one is for the transport buttons and the
  // now-playing row, which have to keep working while the music is stopped.
  function findMedia(root = document) {
    let best = null;
    for (const el of root.querySelectorAll('video, audio')) {
      if (mediaIsAudiblyPlaying(el)) return el;
      if (!best && el.readyState >= 2 && !el.muted) best = el;
    }
    return best;
  }

  function text(node) {
    return node ? node.textContent.trim() : '';
  }

  // `hooks` are optional per-site extras:
  //   snapshot() — what the player holds right now, paused included, for the
  //                popup's now-playing row; probe() is used when absent.
  //   control(action) — 'prev' | 'playPause' | 'next' on the page's own player.
  function startTracker(probe, hooks = {}) {
    let lastActiveAt = null;
    let lastKey = null;
    let lastPosition = null;
    // Time actually spent playing the current track, and whether it has already
    // earned its play. Pausing does not reset either: coming back to a song
    // picks up where you left off.
    let listenedMs = 0;
    let playCounted = false;
    let historyLogged = false;

    function cycle() {
      let now;
      try {
        now = Date.now();
        const state = probe();

        if (!state) {
          lastActiveAt = null;
          return;
        }

        const key = state.source + ':' + (state.id || state.title);
        const position = typeof state.position === 'number' ? state.position : null;

        // A different track, or the same one rewound to its start, starts the
        // listening over. Requiring the position to land near zero keeps
        // scrubbing backwards inside a long mix from registering as a replay.
        const restarted = key !== lastKey ||
          (position !== null && lastPosition !== null && position < 10 && lastPosition > 30);
        if (restarted) {
          listenedMs = 0;
          playCounted = false;
          historyLogged = false;
        }
        lastKey = key;
        lastPosition = position;

        if (lastActiveAt === null) {
          // First observation of this listening stretch: start the clock here
          // rather than crediting time we never saw playing.
          lastActiveAt = now;
          return;
        }

        const elapsed = Math.min(now - lastActiveAt, MAX_TICK_MS);
        lastActiveAt = now;
        if (elapsed <= 0) return;

        listenedMs += elapsed;

        const duration = Number(state.duration);
        const hasDuration = Number.isFinite(duration) && duration > 0;
        const needed = hasDuration ? duration * 1000 * PLAY_FRACTION : UNKNOWN_DURATION_MS;
        const historyNeeded = hasDuration ? duration * 1000 * HISTORY_FRACTION : UNKNOWN_DURATION_MS;

        const startedNewPlay = !playCounted && listenedMs >= needed;
        if (startedNewPlay) playCounted = true;

        const startedNewHistoryEntry = !historyLogged && listenedMs >= historyNeeded;
        if (startedNewHistoryEntry) historyLogged = true;

        chrome.runtime.sendMessage({
          type: 'tick',
          source: state.source,
          title: state.title || '',
          artist: state.artist || '',
          id: state.id || '',
          artwork: state.artwork || '',
          from: now - elapsed,
          to: now,
          newPlay: startedNewPlay,
          newHistoryEntry: startedNewHistoryEntry,
        }).catch(() => {
          // Worker asleep or extension reloading; the next tick will land.
        });
      } catch (err) {
        lastActiveAt = null;
      }
    }

    // The popup asks the page directly instead of trusting the last tick: a
    // background tab's timers are throttled to roughly once a minute, so the
    // ticks alone cannot tell "still playing" from "stopped a minute ago".
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg) return false;

      if (msg.type === 'nowPlaying') {
        let state = null;
        try {
          // A paused track still has to be reported, or the popup's play button
          // would vanish along with the row the moment you used it.
          state = hooks.snapshot ? hooks.snapshot() : probe();
        } catch (err) {
          state = null;
        }
        sendResponse({
          playing: state
            ? {
                source: state.source,
                title: state.title || '',
                artist: state.artist || '',
                id: state.id || '',
                paused: Boolean(state.paused),
                canControl: Boolean(hooks.control),
              }
            : null,
        });
        return false;
      }

      if (msg.type === 'control') {
        let ok = false;
        try {
          ok = hooks.control ? hooks.control(msg.action) !== false : false;
        } catch (err) {
          ok = false;
        }
        sendResponse({ ok });
        return false;
      }

      return false;
    });

    setInterval(cycle, CHECK_MS);
    cycle();
  }

  window.__musicCounter = {
    mediaIsAudiblyPlaying,
    findPlayingMedia,
    findMedia,
    anyMediaPresent,
    text,
    startTracker,
  };
})();
