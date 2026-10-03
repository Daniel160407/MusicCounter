// Achievement definitions, shared by the worker (which records unlocks) and the
// popup (which draws them). The iOS app carries the same list in
// Achievements.swift — keep ids, goals and wording in step, so both apps award
// the same badges from the same synced numbers.

const HOUR = 3600;

// A day only counts towards streaks and active days with at least this much.
const ACTIVE_DAY_SECONDS = 60;
// A late-night or early-morning hour needs this much listening to count.
const SESSION_HOUR_SECONDS = 10 * 60;
// Each part of the day needs this much for Dawn to Dusk.
const DAY_PART_SECONDS = 10 * 60;
// A day only counts towards Daily Habit with at least this much.
const HABIT_DAY_SECONDS = 30 * 60;
// Days with no listening at all between two listening days, for Welcome Back.
const COMEBACK_GAP_DAYS = 30;

const ACHIEVEMENTS = [
  // Listening time
  { id: 'first-note', group: 'Time', icon: '🎵', title: 'First Note', text: 'Listen for your first minute', metric: 'totalSeconds', goal: 60, unit: 'time' },
  { id: 'warming-up', group: 'Time', icon: '🔥', title: 'Warming Up', text: 'Listen for 1 hour in total', metric: 'totalSeconds', goal: HOUR, unit: 'time' },
  { id: 'dedicated', group: 'Time', icon: '🎧', title: 'Dedicated Listener', text: 'Listen for 10 hours in total', metric: 'totalSeconds', goal: 10 * HOUR, unit: 'time' },
  { id: 'audiophile', group: 'Time', icon: '💿', title: 'Audiophile', text: 'Listen for 100 hours in total', metric: 'totalSeconds', goal: 100 * HOUR, unit: 'time' },
  { id: 'soundtrack', group: 'Time', icon: '🏆', title: 'Living Soundtrack', text: 'Listen for 500 hours in total', metric: 'totalSeconds', goal: 500 * HOUR, unit: 'time' },
  { id: 'lifetime', group: 'Time', icon: '👑', title: 'Lifetime Listener', text: 'Listen for 1,000 hours in total', metric: 'totalSeconds', goal: 1000 * HOUR, unit: 'time' },

  // One day
  { id: 'deep-session', group: 'Sessions', icon: '🌊', title: 'Deep Session', text: 'Listen for 2 hours in one day', metric: 'bestDaySeconds', goal: 2 * HOUR, unit: 'time' },
  { id: 'marathon', group: 'Sessions', icon: '🏃', title: 'Marathon', text: 'Listen for 6 hours in one day', metric: 'bestDaySeconds', goal: 6 * HOUR, unit: 'time' },
  { id: 'all-nighter', group: 'Sessions', icon: '🌙', title: 'All-Nighter', text: 'Listen for 10 hours in one day', metric: 'bestDaySeconds', goal: 10 * HOUR, unit: 'time' },
  { id: 'weekend-warrior', group: 'Sessions', icon: '🎉', title: 'Weekend Warrior', text: 'Listen for 5 hours over one Saturday and Sunday', metric: 'bestWeekendSeconds', goal: 5 * HOUR, unit: 'time' },
  { id: 'night-owl', group: 'Sessions', icon: '🦉', title: 'Night Owl', text: 'Listen for 10 minutes between midnight and 4 AM', metric: 'nightOwl', goal: 1, unit: 'flag' },
  { id: 'early-bird', group: 'Sessions', icon: '🐦', title: 'Early Bird', text: 'Listen for 10 minutes between 5 and 7 AM', metric: 'earlyBird', goal: 1, unit: 'flag' },
  { id: 'dawn-to-dusk', group: 'Sessions', icon: '🌅', title: 'Dawn to Dusk', text: 'Listen for 10 minutes in the night, morning, afternoon and evening of one day', metric: 'dawnToDusk', goal: 1, unit: 'flag' },
  { id: 'around-the-clock', group: 'Sessions', icon: '🕛', title: 'Around the Clock', text: 'Listen in every one of the 24 hours of the day', metric: 'hoursCovered', goal: 24, unit: 'count' },

  // Habits
  { id: 'streak-3', group: 'Streaks', icon: '✨', title: 'On a Roll', text: 'Listen 3 days in a row', metric: 'longestStreak', goal: 3, unit: 'days' },
  { id: 'streak-7', group: 'Streaks', icon: '📅', title: 'Week Strong', text: 'Listen 7 days in a row', metric: 'longestStreak', goal: 7, unit: 'days' },
  { id: 'streak-30', group: 'Streaks', icon: '🗓️', title: 'Monthly Ritual', text: 'Listen 30 days in a row', metric: 'longestStreak', goal: 30, unit: 'days' },
  { id: 'streak-100', group: 'Streaks', icon: '💯', title: 'Unbreakable', text: 'Listen 100 days in a row', metric: 'longestStreak', goal: 100, unit: 'days' },
  { id: 'streak-365', group: 'Streaks', icon: '🌞', title: 'Year of Music', text: 'Listen 365 days in a row', metric: 'longestStreak', goal: 365, unit: 'days' },
  { id: 'daily-habit', group: 'Streaks', icon: '⏰', title: 'Daily Habit', text: 'Listen for 30 minutes a day, 7 days in a row', metric: 'longestHabit', goal: 7, unit: 'days' },
  { id: 'regular', group: 'Streaks', icon: '📈', title: 'Regular', text: 'Listen on 30 different days', metric: 'activeDays', goal: 30, unit: 'days' },
  { id: 'devoted', group: 'Streaks', icon: '🙌', title: 'Devoted', text: 'Listen on 100 different days', metric: 'activeDays', goal: 100, unit: 'days' },

  // Plays
  { id: 'century', group: 'Plays', icon: '▶️', title: 'Century', text: 'Play 100 tracks', metric: 'totalPlays', goal: 100, unit: 'count' },
  { id: 'thousand', group: 'Plays', icon: '🎰', title: 'Thousand Plays', text: 'Play 1,000 tracks', metric: 'totalPlays', goal: 1000, unit: 'count' },
  { id: 'jukebox', group: 'Plays', icon: '📻', title: 'Jukebox', text: 'Play 5,000 tracks', metric: 'totalPlays', goal: 5000, unit: 'count' },
  { id: 'on-repeat', group: 'Plays', icon: '🔁', title: 'On Repeat', text: 'Play the same track 10 times', metric: 'topTrackPlays', goal: 10, unit: 'count' },
  { id: 'obsessed', group: 'Plays', icon: '😵‍💫', title: 'Obsessed', text: 'Play the same track 50 times', metric: 'topTrackPlays', goal: 50, unit: 'count' },
  { id: 'broken-record', group: 'Plays', icon: '📀', title: 'Broken Record', text: 'Play the same track 100 times', metric: 'topTrackPlays', goal: 100, unit: 'count' },

  // Variety
  { id: 'explorer', group: 'Variety', icon: '🧭', title: 'Explorer', text: 'Listen to 10 different artists', metric: 'artistCount', goal: 10, unit: 'count' },
  { id: 'globetrotter', group: 'Variety', icon: '🌍', title: 'Globetrotter', text: 'Listen to 50 different artists', metric: 'artistCount', goal: 50, unit: 'count' },
  { id: 'crate-digger', group: 'Variety', icon: '📦', title: 'Crate Digger', text: 'Listen to 200 different artists', metric: 'artistCount', goal: 200, unit: 'count' },
  { id: 'encyclopedia', group: 'Variety', icon: '📚', title: 'Encyclopedia', text: 'Listen to 500 different artists', metric: 'artistCount', goal: 500, unit: 'count' },
  { id: 'variety-pack', group: 'Variety', icon: '🎨', title: 'Variety Pack', text: 'Listen to 100 different tracks', metric: 'trackCount', goal: 100, unit: 'count' },
  { id: 'deep-catalog', group: 'Variety', icon: '🗂️', title: 'Deep Catalog', text: 'Listen to 500 different tracks', metric: 'trackCount', goal: 500, unit: 'count' },
  { id: 'superfan', group: 'Variety', icon: '🤩', title: 'Superfan', text: 'Spend 10 hours with one artist', metric: 'topArtistSeconds', goal: 10 * HOUR, unit: 'time' },
  { id: 'ultimate-fan', group: 'Variety', icon: '💜', title: 'Ultimate Fan', text: 'Spend 50 hours with one artist', metric: 'topArtistSeconds', goal: 50 * HOUR, unit: 'time' },
  { id: 'everywhere', group: 'Variety', icon: '📡', title: 'Everywhere', text: 'Listen on 3 different services', metric: 'serviceCount', goal: 3, unit: 'count' },
  { id: 'omnivore', group: 'Variety', icon: '🌐', title: 'Omnivore', text: 'Listen on YouTube, YouTube Music, Spotify and iPhone', metric: 'serviceCount', goal: 4, unit: 'count' },

  // Favorites
  { id: 'first-love', group: 'Favorites', icon: '⭐', title: 'First Love', text: 'Star your first favorite', metric: 'favoriteCount', goal: 1, unit: 'count' },
  { id: 'collector', group: 'Favorites', icon: '💎', title: 'Collector', text: 'Star 25 favorites', metric: 'favoriteCount', goal: 25, unit: 'count' },
  { id: 'curator', group: 'Favorites', icon: '🖼️', title: 'Curator', text: 'Star 100 favorites', metric: 'favoriteCount', goal: 100, unit: 'count' },

  // Milestones
  { id: 'one-month', group: 'Milestones', icon: '🌱', title: 'One Month In', text: 'Keep counting for 30 days since your first listen', metric: 'daysSinceFirst', goal: 30, unit: 'days' },
  { id: 'one-year', group: 'Milestones', icon: '🎂', title: 'One Year Together', text: 'Keep counting for a year since your first listen', metric: 'daysSinceFirst', goal: 365, unit: 'days' },
  { id: 'welcome-back', group: 'Milestones', icon: '👋', title: 'Welcome Back', text: 'Come back to music after 30 days away', metric: 'longestGap', goal: COMEBACK_GAP_DAYS, unit: 'flag' },
];

function dayKeyOf(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseDayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Whole calendar days from `a` to `b`, rounded so a daylight-saving change
// doesn't throw it off.
function daysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}

// Longest run of consecutive calendar days, and the longest stretch with none,
// among `keys` ("YYYY-MM-DD", any order).
function runs(keys) {
  const sorted = keys.map(parseDayKey).sort((a, b) => a - b);
  let longest = 0;
  let longestGap = 0;
  let run = 0;
  let prev = null;
  for (const date of sorted) {
    const step = prev ? daysBetween(prev, date) : 0;
    run = prev && step === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    if (prev) longestGap = Math.max(longestGap, step - 1);
    prev = date;
  }
  return { longest, longestGap, first: sorted[0] || null };
}

function longestRun(keys) {
  return runs(keys).longest;
}

// Every number an achievement can be measured by, from the (merged) stats the
// worker hands the popup.
function achievementMetrics(stats, favorites) {
  const days = stats.days || {};
  const active = Object.keys(days).filter((k) => (days[k].total || 0) >= ACTIVE_DAY_SECONDS);

  let bestDaySeconds = 0;
  let nightOwl = 0;
  let earlyBird = 0;
  let dawnToDusk = 0;
  const hourTotals = new Array(24).fill(0);
  for (const day of Object.values(days)) {
    bestDaySeconds = Math.max(bestDaySeconds, day.total || 0);
    // Night 0–6, morning 6–12, afternoon 12–18, evening 18–24.
    const parts = [0, 0, 0, 0];
    for (const [hour, slice] of Object.entries(day.hours || {})) {
      const h = Number(hour);
      const seconds = slice.total || 0;
      if (!(h >= 0 && h < 24)) continue;
      hourTotals[h] += seconds;
      parts[Math.floor(h / 6)] += seconds;
      if (seconds < SESSION_HOUR_SECONDS) continue;
      if (h < 4) nightOwl = 1;
      if (h >= 5 && h < 7) earlyBird = 1;
    }
    if (parts.every((p) => p >= DAY_PART_SECONDS)) dawnToDusk = 1;
  }

  // A weekend is a Saturday plus the Sunday after it.
  let bestWeekendSeconds = 0;
  for (const key of Object.keys(days)) {
    const date = parseDayKey(key);
    if (date.getDay() !== 6) continue;
    const sunday = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
    const sundayEntry = days[dayKeyOf(sunday)];
    bestWeekendSeconds = Math.max(bestWeekendSeconds, (days[key].total || 0) + ((sundayEntry && sundayEntry.total) || 0));
  }
  // A Sunday whose Saturday had nothing still counts on its own.
  for (const [key, day] of Object.entries(days)) {
    if (parseDayKey(key).getDay() === 0) bestWeekendSeconds = Math.max(bestWeekendSeconds, day.total || 0);
  }

  const activeRuns = runs(active);
  const habit = Object.keys(days).filter((k) => (days[k].total || 0) >= HABIT_DAY_SECONDS);

  const artists = Object.entries(stats.artists || {})
    .map(([, v]) => (typeof v === 'number' ? v : v.seconds || 0))
    .filter((s) => s >= 1);
  const tracks = Object.values(stats.tracks || {});

  return {
    totalSeconds: stats.total || 0,
    bestDaySeconds,
    nightOwl,
    earlyBird,
    bestWeekendSeconds,
    dawnToDusk,
    hoursCovered: hourTotals.filter((s) => s >= ACTIVE_DAY_SECONDS).length,
    longestStreak: activeRuns.longest,
    longestHabit: longestRun(habit),
    activeDays: active.length,
    longestGap: activeRuns.longestGap,
    daysSinceFirst: activeRuns.first ? daysBetween(activeRuns.first, startOfToday()) : 0,
    totalPlays: tracks.reduce((sum, t) => sum + (t.plays || 0), 0),
    topTrackPlays: tracks.reduce((top, t) => Math.max(top, t.plays || 0), 0),
    artistCount: artists.length,
    trackCount: tracks.filter((t) => (t.seconds || 0) >= 1 || (t.plays || 0) > 0).length,
    topArtistSeconds: artists.reduce((top, s) => Math.max(top, s), 0),
    serviceCount: Object.entries(stats.sources || {})
      .filter(([source, s]) => source !== 'other' && s >= ACTIVE_DAY_SECONDS).length,
    favoriteCount: Object.keys(favorites || {}).length,
  };
}

// Each achievement with its current value; `unlocked` maps id -> first time it
// was earned, so a badge stays earned after Reset brings the numbers back down.
function evaluateAchievements(stats, favorites, unlocked = {}) {
  const metrics = achievementMetrics(stats, favorites);
  return ACHIEVEMENTS.map((a) => {
    const value = metrics[a.metric] || 0;
    const unlockedAt = unlocked[a.id] || (value >= a.goal ? Date.now() : 0);
    return { ...a, value: Math.min(value, a.goal), unlockedAt };
  });
}
