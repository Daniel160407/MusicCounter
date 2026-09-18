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

  MC.startTracker(() => {
    const id = videoIdFromUrl();
    if (!id) return null;

    // Ignore muted previews and the inline miniplayer's silent autoplay.
    const media = MC.findPlayingMedia();
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
    };
  });
})();
