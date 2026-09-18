// music.youtube.com — everything here is music, so only playback state matters.

(() => {
  const MC = window.__musicCounter;

  function isPodcastEpisode() {
    // YouTube Music also hosts podcasts; those are not listening time.
    return location.pathname.startsWith('/podcast') ||
      document.querySelector('ytmusic-player-bar [href^="/podcast/"]') !== null;
  }

  MC.startTracker(() => {
    const media = MC.findPlayingMedia();
    if (!media) return null;
    if (isPodcastEpisode()) return null;

    const bar = document.querySelector('ytmusic-player-bar');
    const title = MC.text(bar && bar.querySelector('.title.ytmusic-player-bar'));
    const byline = MC.text(bar && bar.querySelector('.byline.ytmusic-player-bar'));
    // Byline is "Artist • Album • Year"; the artist is the first segment.
    const artist = byline.split('•')[0].trim();

    return {
      source: 'ytmusic',
      position: media.currentTime,
      duration: media.duration,
      id: new URL(location.href).searchParams.get('v') || title,
      title,
      artist,
    };
  });
})();
