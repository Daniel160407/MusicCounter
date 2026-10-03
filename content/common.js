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

  // Volume runs 0–2: up to 1 is the element's own volume, above that a Web
  // Audio gain boosts it (the phone's slider puts 100% in the middle).
  const MAX_VOLUME = 2;
  // media element -> { context, gain }. An element routed through Web Audio
  // stays routed for good, so this is only built once a boost is asked for.
  const boosts = new WeakMap();

  // The element's loudness, boost included; muted reads as 0.
  function mediaVolume(media) {
    if (!media || !Number.isFinite(media.volume)) return undefined;
    if (media.muted) return 0;
    const boost = boosts.get(media);
    return media.volume * (boost ? boost.gain.gain.value : 1);
  }

  // Chrome only starts an AudioContext in a tab you've interacted with. The
  // element is connected only once the context runs: connected to a stopped
  // one it would go silent. Until then the volume just stays at 100%.
  function boostFor(media) {
    const known = boosts.get(media);
    if (known) return Promise.resolve(known);
    const context = new AudioContext();
    return context.resume().then(() => {
      if (context.state !== 'running' || boosts.has(media)) {
        context.close();
        return boosts.get(media) || null;
      }
      const gain = context.createGain();
      context.createMediaElementSource(media).connect(gain).connect(context.destination);
      const boost = { context, gain };
      boosts.set(media, boost);
      return boost;
    }).catch(() => {
      context.close().catch(() => {});
      return null;
    });
  }

  // Set from the phone: anything above zero also unmutes, the way dragging
  // the player's own slider would.
  function setMediaVolume(media, value, { canBoost = true } = {}) {
    if (!media || !Number.isFinite(value)) return false;
    const level = Math.max(0, Math.min(canBoost ? MAX_VOLUME : 1, value));
    media.volume = Math.min(1, level);
    if (level > 0) media.muted = false;
    const extra = Math.max(1, level);
    const known = boosts.get(media);
    if (known) known.gain.gain.value = extra;
    else if (extra > 1) boostFor(media).then((boost) => { if (boost) boost.gain.gain.value = extra; });
    return true;
  }

  function text(node) {
    return node ? node.textContent.trim() : '';
  }

  // `hooks` are optional per-site extras:
  //   snapshot() — what the player holds right now, paused included, for the
  //                popup's now-playing row; probe() is used when absent.
  //   control(action, value) — 'prev' | 'playPause' | 'next' on the page's own
  //                player, 'seek' to `value` seconds, 'volume' to `value`
  //                (0–1, up to 2 where the site can be boosted).
  //   maxVolume — how far 'volume' goes: 2 with the Web Audio boost, else 1.
  //   autoplay() — after the worker opened a song for the phone: start it, or on
  //                a search page open the first result. 'done' once it plays,
  //                'wait' to be asked again a second later.
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

    // Music just stopped (paused, muted, or the tab is going away): the worker
    // uploads to Firestore at this point rather than on a timer.
    function reportStopped() {
      chrome.runtime.sendMessage({ type: 'stopped' }).catch(() => {});
    }

    function cycle() {
      let now;
      try {
        now = Date.now();
        const state = probe();

        if (!state) {
          if (lastActiveAt !== null) reportStopped();
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
                artwork: state.artwork || '',
                paused: Boolean(state.paused),
                position: Number.isFinite(state.position) ? state.position : null,
                duration: Number.isFinite(state.duration) && state.duration > 0 ? state.duration : null,
                volume: Number.isFinite(state.volume) ? state.volume : null,
                maxVolume: hooks.maxVolume || 1,
                canControl: Boolean(hooks.control),
              }
            : null,
        });
        return false;
      }

      if (msg.type === 'autoplay') {
        let result = 'wait';
        try {
          result = hooks.autoplay ? hooks.autoplay() : 'done';
        } catch (err) {
          result = 'wait';
        }
        sendResponse({ result });
        return false;
      }

      if (msg.type === 'control') {
        let ok = false;
        try {
          ok = hooks.control ? hooks.control(msg.action, msg.value) !== false : false;
        } catch (err) {
          ok = false;
        }
        sendResponse({ ok });
        return false;
      }

      return false;
    });

    // Closing the tab mid-song never shows up as a pause.
    window.addEventListener('pagehide', () => {
      if (lastActiveAt !== null) reportStopped();
    });

    setInterval(cycle, CHECK_MS);
    cycle();
  }

  window.__musicCounter = {
    mediaIsAudiblyPlaying,
    findPlayingMedia,
    findMedia,
    anyMediaPresent,
    MAX_VOLUME,
    mediaVolume,
    setMediaVolume,
    text,
    startTracker,
  };
})();
