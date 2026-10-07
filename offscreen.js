// The service worker can't play audio, so it opens this page to do it.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'offscreen-play-sound') return;
  const audio = new Audio(chrome.runtime.getURL(msg.src));
  audio.volume = 0.8;
  audio.play().catch(() => {});
});
