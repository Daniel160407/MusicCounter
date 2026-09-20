// open.spotify.com — the web player. (The Spotify desktop app is invisible to
// a Chrome extension, so only what you play in this tab is counted.)

(() => {
  const MC = window.__musicCounter;

  let lastProgress = null;

  function nowPlayingLink() {
    return document.querySelector(
      '[data-testid="now-playing-widget"] [data-testid="context-item-link"], ' +
      '[data-testid="context-item-link"]'
    );
  }

  function trackRef() {
    const link = nowPlayingLink();
    const href = link ? link.getAttribute('href') || '' : '';
    const match = href.match(/\/(track|episode)\/([A-Za-z0-9]+)/);
    return {
      kind: match ? match[1] : '',
      id: match ? match[2] : '',
      title: MC.text(link),
    };
  }

  function artist() {
    // Scope to the now-playing widget when it exists; the bare selector also
    // matches the same nodes, which would list every artist twice.
    const scope = document.querySelector('[data-testid="now-playing-widget"]') || document;
    const nodes = scope.querySelectorAll('[data-testid="context-item-info-artist"]');
    const names = Array.from(nodes).map((n) => MC.text(n)).filter(Boolean);
    return Array.from(new Set(names)).join(', ');
  }

  // Language-independent playback detection: the progress readout only moves
  // while audio is actually running.
  function progressSignature() {
    const slider = document.querySelector(
      '[data-testid="playback-progressbar"] [role="slider"], [data-testid="progress-bar"] [role="slider"]'
    );
    if (slider && slider.getAttribute('aria-valuenow') !== null) {
      return 'v:' + slider.getAttribute('aria-valuenow');
    }
    const label = document.querySelector('[data-testid="playback-position"]');
    if (label) return 't:' + MC.text(label);

    const media = document.querySelector('video, audio');
    if (media) return 'm:' + Math.floor(media.currentTime);

    return null;
  }

  // Spotify's media element is DRM-fed and reports no usable duration, so the
  // track length comes from the player UI: the progress slider's range when it
  // exposes one, otherwise the "3:24" readout beside it.
  function trackDuration() {
    const slider = document.querySelector(
      '[data-testid="playback-progressbar"] [role="slider"], [data-testid="progress-bar"] [role="slider"]'
    );
    const max = slider ? Number(slider.getAttribute('aria-valuemax')) : NaN;
    if (Number.isFinite(max) && max > 0) return max;

    const label = MC.text(document.querySelector('[data-testid="playback-duration"]'));
    const parts = label.split(':').map(Number);
    if (parts.length >= 2 && parts.every((n) => Number.isFinite(n))) {
      return parts.reduce((total, part) => total * 60 + part, 0);
    }
    return undefined;
  }

  // The cover art shown by the now-playing widget. Spotify has no public,
  // id-derived image URL the way YouTube does, so the only way to get one
  // without OAuth is to read the <img> the player itself already rendered.
  function artworkUrl() {
    let img = document.querySelector('[data-testid="cover-art-image"]');
    if (img && img.tagName !== 'IMG') img = img.querySelector('img');
    if (!img) img = document.querySelector('[data-testid="now-playing-widget"] img');
    return img ? (img.currentSrc || img.src || '') : '';
  }

  function isMuted() {
    const media = document.querySelector('video, audio');
    if (media && (media.muted || media.volume === 0)) return true;
    return false;
  }

  function buttonSaysPause() {
    const btn = document.querySelector('[data-testid="control-button-playpause"]');
    const label = btn ? (btn.getAttribute('aria-label') || '') : '';
    // Works in English and most Latin languages; the progress signature covers
    // everything else, one tick later.
    return /paus/i.test(label);
  }

  // The now-playing widget without the movement test: the popup's row has to
  // stay put while the track is paused, which is exactly when the progress
  // signature stops changing.
  function snapshot() {
    const ref = trackRef();
    if (ref.kind === 'episode') return null;
    if (!ref.id && !ref.title) return null;

    return {
      source: 'spotify',
      duration: trackDuration(),
      id: ref.id || ref.title,
      title: ref.title,
      artist: artist(),
      artwork: artworkUrl(),
      // The play/pause label is the only synchronous read of the state. It is
      // matched loosely, so a player in another language may show the wrong
      // icon until the button is used; pressing it still does the right thing,
      // because Spotify's own button is what gets clicked.
      paused: !buttonSaysPause(),
    };
  }

  const BUTTONS = {
    prev: '[data-testid="control-button-skip-back"]',
    playPause: '[data-testid="control-button-playpause"]',
    next: '[data-testid="control-button-skip-forward"]',
  };

  function control(action) {
    const button = document.querySelector(BUTTONS[action] || '');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }

  MC.startTracker(() => {
    const ref = trackRef();
    // Podcasts and audiobooks are not music.
    if (ref.kind === 'episode') {
      lastProgress = null;
      return null;
    }
    if (!ref.id && !ref.title) {
      lastProgress = null;
      return null;
    }

    const sig = progressSignature();
    const key = ref.id + '|' + sig;
    const moved = lastProgress !== null && lastProgress !== key;
    lastProgress = key;

    if (isMuted()) return null;
    if (!moved && !buttonSaysPause()) return null;

    return {
      source: 'spotify',
      // aria-valuenow is the elapsed seconds; absent on older layouts.
      position: sig && sig.startsWith('v:') ? Number(sig.slice(2)) : undefined,
      duration: trackDuration(),
      id: ref.id || ref.title,
      title: ref.title,
      artist: artist(),
      artwork: artworkUrl(),
    };
  }, { snapshot, control });
})();
