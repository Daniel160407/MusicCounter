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

  function clockSeconds(selector) {
    const label = MC.text(document.querySelector(selector));
    const parts = label.split(':').map(Number);
    if (parts.length < 2 || !parts.every((n) => Number.isFinite(n))) return undefined;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }

  // Both numbers come from the readouts beside the bar so they share one unit.
  function progressSeconds() {
    return {
      position: clockSeconds('[data-testid="playback-position"]'),
      duration: clockSeconds('[data-testid="playback-duration"]') || trackDuration(),
    };
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
      ...progressSeconds(),
      id: ref.id || ref.title,
      title: ref.title,
      artist: artist(),
      artwork: artworkUrl(),
      // The play/pause label is the only synchronous read of the state. It is
      // matched loosely, so a player in another language may show the wrong
      // icon until the button is used; pressing it still does the right thing,
      // because Spotify's own button is what gets clicked.
      paused: !buttonSaysPause(),
      volume: volume(),
    };
  }

  const BUTTONS = {
    prev: '[data-testid="control-button-skip-back"]',
    playPause: '[data-testid="control-button-playpause"]',
    next: '[data-testid="control-button-skip-forward"]',
  };

  // Spotify exposes no seek or volume API, so click a bar where the fraction
  // falls, the way a pointer would. Best effort: it relies on the page's markup.
  function clickBarAt(bar, fraction) {
    const rect = bar.getBoundingClientRect();
    if (!rect.width) return false;
    const x = rect.left + rect.width * Math.max(0, Math.min(1, fraction));
    const y = rect.top + rect.height / 2;
    const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      bar.dispatchEvent(new Ctor(type, init));
    }
    return true;
  }

  function seek(seconds) {
    const { duration } = progressSeconds();
    const bar = document.querySelector('[data-testid="playback-progressbar"]');
    if (!bar || !duration) return false;
    return clickBarAt(bar, seconds / duration);
  }

  const VOLUME_BAR = '[data-testid="volume-bar"]';

  // The volume bar's hidden range input, else the media element, which
  // Spotify keeps at the slider's level.
  function volume() {
    const input = document.querySelector(`${VOLUME_BAR} input[type="range"]`);
    const max = input ? Number(input.max) : NaN;
    if (input && Number.isFinite(max) && max > 0) {
      const value = Number(input.value);
      if (Number.isFinite(value)) return Math.max(0, Math.min(1, value / max));
    }
    return MC.mediaVolume(document.querySelector('video, audio'));
  }

  // No boost past 100% here: Spotify's audio is DRM-protected, and routing it
  // through Web Audio can leave the tab silent.
  function setVolume(value) {
    const bar = document.querySelector(`${VOLUME_BAR} [data-testid="progress-bar"]`) ||
      document.querySelector(VOLUME_BAR);
    if (!bar || !Number.isFinite(value)) return false;
    return clickBarAt(bar, value);
  }

  function control(action, value) {
    if (action === 'seek') return seek(value);
    if (action === 'volume') return setVolume(value);
    const button = document.querySelector(BUTTONS[action] || '');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }

  // A song sent from the phone. A search opens the first track; a track page
  // gets its big Play button pressed once, which Spotify then labels Pause.
  let openedResult = false;
  let pressedPlay = false;
  function autoplay() {
    if (location.pathname.startsWith('/search/')) {
      const link = document.querySelector('[data-testid="tracklist-row"] a[href^="/track/"]');
      if (!link || openedResult) return 'wait';
      openedResult = true;
      location.assign(link.href);
      return 'wait';
    }
    if (!location.pathname.startsWith('/track/')) return 'done';
    const button = document.querySelector('[data-testid="action-bar-row"] [data-testid="play-button"]');
    if (!button) return 'wait';
    if (/paus/i.test(button.getAttribute('aria-label') || '')) return 'done';
    if (!pressedPlay) {
      pressedPlay = true;
      button.click();
    }
    return 'wait';
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
  }, { snapshot, control, autoplay });
})();
