// music.youtube.com — everything here is music, so only playback state matters.

(() => {
  const MC = window.__musicCounter;

  function isPodcastEpisode() {
    // YouTube Music also hosts podcasts; those are not listening time.
    return location.pathname.startsWith('/podcast') ||
      document.querySelector('ytmusic-player-bar [href^="/podcast/"]') !== null;
  }

  // Whatever the player bar is holding, playing or not.
  function current(media) {
    if (!media) return null;
    if (isPodcastEpisode()) return null;

    const bar = document.querySelector('ytmusic-player-bar');
    const title = MC.text(bar && bar.querySelector('.title.ytmusic-player-bar'));
    const byline = MC.text(bar && bar.querySelector('.byline.ytmusic-player-bar'));
    // Byline is "Artist • Album • Year"; the artist is the first segment.
    const artist = byline.split('•')[0].trim();
    if (!title) return null;

    return {
      source: 'ytmusic',
      position: media.currentTime,
      duration: media.duration,
      id: new URL(location.href).searchParams.get('v') || title,
      title,
      artist,
      paused: media.paused,
    };
  }

  // The player bar's own buttons, so YouTube Music handles the queue, the
  // scrobbling and the autoplay exactly as it would on a real click.
  const BUTTONS = {
    prev: 'ytmusic-player-bar .previous-button',
    playPause: 'ytmusic-player-bar #play-pause-button',
    next: 'ytmusic-player-bar .next-button',
  };

  function control(action) {
    const button = document.querySelector(BUTTONS[action] || '');
    if (!button) return false;
    button.click();
    return true;
  }

  MC.startTracker(
    () => current(MC.findPlayingMedia()),
    { snapshot: () => current(MC.findMedia()), control },
  );
})();
