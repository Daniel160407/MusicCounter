// youtube.com — count a video only when YouTube itself classifies it as music.

(() => {
  const MC = window.__musicCounter;

  // videoId -> true | false | 'pending'. Probing runs every 5 seconds, so the
  // verdict has to be memoised rather than recomputed.
  const verdicts = new Map();

  function videoIdFromUrl() {
    const url = new URL(location.href);
    if (url.pathname === '/watch') return url.searchParams.get('v') || '';
    const shorts = url.pathname.match(/^\/shorts\/([\w-]+)/);
    return shorts ? shorts[1] : '';
  }

  function channelName() {
    return MC.text(
      document.querySelector('#upload-info #channel-name a, ytd-channel-name#channel-name a')
    );
  }

  // The server-rendered microformat block carries both the genre and the id of
  // the video it describes. YouTube never refreshes it on an in-page
  // navigation, so it is only trustworthy when that id still matches the video
  // actually on screen — otherwise it reports the previously loaded video.
  function microformatVerdict(id) {
    const scope = document.querySelector('#watch7-content') || document;
    const identifier = scope.querySelector('meta[itemprop="identifier"]');
    const genre = scope.querySelector('meta[itemprop="genre"]');
    if (!identifier || !genre) return null;
    if (identifier.getAttribute('content') !== id) return null;
    return genre.getAttribute('content') === 'Music';
  }

  // Signals readable straight from the DOM. Returns true, false, or null when
  // the page does not reliably say.
  function domVerdict(id) {
    // Auto-generated artist channels are always music.
    if (/ - Topic$/.test(channelName())) return true;

    return microformatVerdict(id);
  }

  function isMusicVideo(id) {
    const known = verdicts.get(id);
    if (known === true) return true;
    if (known === false) return false;
    if (known === 'pending') return false;

    const fromDom = domVerdict(id);
    if (fromDom !== null) {
      verdicts.set(id, fromDom);
      return fromDom;
    }

    // Nothing in the DOM to go on: ask the worker to look the category up.
    verdicts.set(id, 'pending');
    chrome.runtime.sendMessage({ type: 'classifyVideo', videoId: id })
      .then((reply) => verdicts.set(id, !!(reply && reply.music)))
      .catch(() => verdicts.delete(id));
    return false;
  }

  function currentTitle() {
    return MC.text(
      document.querySelector('#title h1 yt-formatted-string, h1.ytd-watch-metadata yt-formatted-string')
    ) || document.title.replace(/ - YouTube$/, '');
  }

  function current(media) {
    const id = videoIdFromUrl();
    if (!id) return null;
    if (!media) return null;
    if (!isMusicVideo(id)) return null;

    return {
      source: 'youtube',
      position: media.currentTime,
      // NaN or 0 on a live stream; the tracker falls back for those.
      duration: media.duration,
      id,
      title: currentTitle(),
      artist: channelName().replace(/ - Topic$/, ''),
      paused: media.paused,
      volume: MC.mediaVolume(media),
    };
  }

  // Play and pause go straight to the media element — the one thing on a watch
  // page that is always there. Previous and next are the player's own chrome
  // buttons, which know about the playlist or mix you are inside; off a
  // playlist YouTube disables them and the click harmlessly does nothing.
  function control(action, value) {
    const media = MC.findMedia();
    if (action === 'seek') {
      if (!media || !Number.isFinite(media.duration)) return false;
      media.currentTime = Math.max(0, Math.min(media.duration, value));
      return true;
    }
    // The element itself, as with play and pause: YouTube's slider only opens on hover.
    if (action === 'volume') return MC.setMediaVolume(media, value);
    if (action === 'playPause') {
      if (!media) return false;
      if (media.paused) media.play().catch(() => {});
      else media.pause();
      return true;
    }

    const button = document.querySelector(
      action === 'prev' ? '.ytp-prev-button' : '.ytp-next-button'
    );
    if (!button || button.getAttribute('aria-disabled') === 'true') return false;
    button.click();
    return true;
  }

  // A song sent from the phone. A search (a song with no video id) opens the
  // first video; the watch page then plays it. The browser may still refuse to
  // start sound in a tab you haven't used, in which case the worker gives up.
  let openedResult = false;
  function autoplay() {
    if (location.pathname === '/results') {
      // The classic result row or the newer lockup layout, whichever comes first,
      // skipping sponsored results.
      const link = [...document.querySelectorAll(
        'ytd-video-renderer a#thumbnail[href*="/watch?v="], yt-lockup-view-model a[href*="/watch?v="]'
      )].find((a) => !a.closest('ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer'));
      if (!link || openedResult) return 'wait';
      openedResult = true;
      location.assign(link.href);
      return 'wait';
    }
    const video = document.querySelector('video');
    if (!videoIdFromUrl() || !video || video.readyState < 1) return 'wait';
    // play() on a playing video does nothing, so this can't toggle it back off.
    if (video.paused) {
      video.play().catch(() => {});
      return 'wait';
    }
    return 'done';
  }

  MC.startTracker(
    // Ignore muted previews and the inline miniplayer's silent autoplay.
    () => current(MC.findPlayingMedia()),
    { snapshot: () => current(MC.findMedia()), control, autoplay, maxVolume: MC.MAX_VOLUME },
  );
})();
