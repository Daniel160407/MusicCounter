// Cross-device sync through Firebase, loaded into the service worker by
// background.js. Google sign-in runs through chrome.identity.launchWebAuthFlow
// with the project's web OAuth client (Google no longer accepts getAuthToken's
// flow for new Chrome-extension clients); Firestore is spoken
// to over its REST API, since an MV3 worker can't pull the Firebase SDK from a
// CDN and this extension has no build step to bundle it.
//
// Every device writes only its own document, so two devices never fight over
// the same counters; each one shows its own stats merged with everyone else's.
// Favorites, playlists and the history-retention setting are shared by all of them.
//
//   users/{uid}                              historyRetention, settingsUpdatedAt, favoritesUpdatedAt,
//                                            playlistsUpdatedAt
//   users/{uid}/favorites/{key}              key, id, title, artist, source, addedAt
//   users/{uid}/playlists/{id}               id, name, tracks [{ source, id, title, artist }],
//                                            createdAt, updatedAt
//   users/{uid}/devices/{deviceId}           platform, name, updatedAt, total, firstSeen, sources, parts
//   users/{uid}/devices/{deviceId}/parts/{n} json   (tracks, artists, days-YYYY, history-YYYY-MM-N)
//   users/{uid}/live/{deviceId}, users/{uid}/commands/{deviceId}   now playing and phone remote (live.js)
//
// A device's `parts` field maps each part's name to a hash of its contents, so a
// reader only fetches the parts that changed since it last looked, and a writer
// only uploads the parts whose hash moved. The iOS app uses the same layout.

const SYNC_ALARM = 'sync';
const PULL_INTERVAL_MS = 2 * 60 * 1000;
// An open popup asks more often, so the other device's numbers show up quickly.
const POPUP_PULL_INTERVAL_MS = 20 * 1000;
// Firestore caps a string field just under 1 MiB; leave room for the envelope.
const MAX_PART_BYTES = 900 * 1000;
const MAX_WRITES_PER_COMMIT = 400;

function syncConfigured() {
  const config = typeof FIREBASE_CONFIG === 'object' ? FIREBASE_CONFIG : {};
  return [config.apiKey, config.projectId, config.googleClientId]
    .every((value) => value && !value.startsWith('YOUR_'));
}

// --- Serialising -------------------------------------------------------------
//
// Sync steps run one at a time, so a pull never interleaves with a push and the
// stored sync state is never written by two of them at once.

let syncChain = Promise.resolve();
let syncBusy = false;

function syncTask(task) {
  const run = syncChain.then(async () => {
    syncBusy = true;
    try {
      return await task();
    } finally {
      syncBusy = false;
    }
  });
  syncChain = run.catch(() => {});
  return run;
}

// --- Local sync state --------------------------------------------------------

async function loadAuth() {
  return (await chrome.storage.local.get('syncAuth')).syncAuth || null;
}

async function loadSyncState() {
  return (await chrome.storage.local.get('syncState')).syncState || { hashes: {} };
}

async function saveSyncState(patch) {
  const state = await loadSyncState();
  await chrome.storage.local.set({ syncState: { ...state, ...patch } });
}

async function loadPending() {
  const pending = (await chrome.storage.local.get('syncPending')).syncPending || {};
  return {
    favorites: pending.favorites || {},
    playlists: pending.playlists || {},
    retention: pending.retention || null,
  };
}

async function getDeviceId() {
  const stored = await chrome.storage.local.get('deviceId');
  if (stored.deviceId) return stored.deviceId;
  const deviceId = crypto.randomUUID();
  await chrome.storage.local.set({ deviceId });
  return deviceId;
}

function deviceName() {
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || '';
  return platform ? `Chrome on ${platform}` : 'Chrome';
}

// Other devices' data, parsed, kept in memory so the popup's 2-second poll can
// merge it without touching storage every time.
let remoteCache = null;

async function loadRemote() {
  if (!remoteCache) remoteCache = (await chrome.storage.local.get('syncRemote')).syncRemote || { devices: {} };
  return remoteCache;
}

async function saveRemote(remote) {
  remoteCache = remote;
  await chrome.storage.local.set({ syncRemote: remote });
}

// --- Auth --------------------------------------------------------------------

// Google's account picker in a Chrome window; it hands back an ID token and an
// access token in the redirect's fragment, which Firebase then trades for its own.
async function googleTokens() {
  const nonce = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: FIREBASE_CONFIG.googleClientId,
    response_type: 'id_token token',
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: 'openid email profile',
    nonce,
    prompt: 'select_account',
  });
  const redirect = await chrome.identity.launchWebAuthFlow({
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    interactive: true,
  });
  const result = new URLSearchParams(new URL(redirect).hash.slice(1));
  if (result.get('error')) throw new Error(result.get('error'));
  if (!result.get('id_token')) throw new Error('Google returned no ID token.');
  return { idToken: result.get('id_token'), accessToken: result.get('access_token') || '', nonce };
}

async function identityError(res) {
  const data = await res.json().catch(() => ({}));
  return new Error((data.error && data.error.message) || `HTTP ${res.status}`);
}

async function firebaseSignIn({ idToken, accessToken, nonce }) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${FIREBASE_CONFIG.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        postBody: new URLSearchParams({
          id_token: idToken, access_token: accessToken, nonce, providerId: 'google.com',
        }).toString(),
        requestUri: 'http://localhost',
        returnSecureToken: true,
        returnIdpCredential: true,
      }),
    },
  );
  if (!res.ok) throw await identityError(res);
  const data = await res.json();
  return {
    uid: data.localId,
    email: data.email || '',
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresAt: Date.now() + Number(data.expiresIn) * 1000,
  };
}

// The Firebase ID token lasts an hour; trade the refresh token for a new one
// shortly before it runs out.
async function freshAuth() {
  const auth = await loadAuth();
  if (!auth) throw new Error('Not signed in.');
  if (auth.expiresAt - 60 * 1000 > Date.now()) return auth;

  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_CONFIG.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(auth.refreshToken)}`,
  });
  if (!res.ok) {
    const err = await identityError(res);
    // A revoked or expired session can't be repaired here; ask to sign in again.
    if (res.status === 400) await chrome.storage.local.remove('syncAuth');
    throw err;
  }
  const data = await res.json();
  const next = {
    ...auth,
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + Number(data.expires_in) * 1000,
  };
  await chrome.storage.local.set({ syncAuth: next });
  return next;
}

async function signIn() {
  if (!syncConfigured()) throw new Error('Sync is not set up: fill in firebase-config.js.');

  const session = await firebaseSignIn(await googleTokens());

  await syncTask(async () => {
    await chrome.storage.local.set({ syncAuth: session, syncState: { hashes: {} } });
    await saveRemote({ devices: {} });
  });

  // Stars made before signing in join the shared list rather than being
  // replaced by it.
  await serialized(async () => {
    const favorites = await loadFavorites();
    const pending = await loadPending();
    for (const [key, fav] of Object.entries(favorites)) {
      if (!(key in pending.favorites)) pending.favorites[key] = fav;
    }
    // Playlists too: their ids are random, so nothing on the account can clash.
    for (const [id, playlist] of Object.entries(await loadPlaylists())) {
      if (!(id in pending.playlists)) pending.playlists[id] = playlist;
    }
    await chrome.storage.local.set({ syncPending: pending });
  });

  await runSync({ push: true, pull: true });
}

async function signOut() {
  await clearLive().catch(() => {});
  await syncTask(async () => {
    await chrome.storage.local.remove(['syncAuth', 'syncState', 'syncPending']);
    await saveRemote({ devices: {} });
  });
}

// --- Firestore REST ----------------------------------------------------------

function documentsRoot() {
  return `projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents`;
}

async function firestore(method, path, body) {
  const auth = await freshAuth();
  const res = await fetch(`https://firestore.googleapis.com/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${auth.idToken}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 404 && method === 'GET') return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Firestore ${res.status}: ${(data.error && data.error.message) || res.statusText}`);
  return data;
}

async function listDocuments(collectionPath) {
  const documents = [];
  let pageToken = '';
  do {
    const query = `pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const page = await firestore('GET', `${collectionPath}?${query}`);
    if (!page) break;
    documents.push(...(page.documents || []));
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return documents;
}

async function commit(writes) {
  for (let i = 0; i < writes.length; i += MAX_WRITES_PER_COMMIT) {
    await firestore('POST', `${documentsRoot()}:commit`, { writes: writes.slice(i, i + MAX_WRITES_PER_COMMIT) });
  }
}

function toValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return { doubleValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toValue) } };
  return { mapValue: { fields: toFields(value) } };
}

function toFields(object) {
  const fields = {};
  for (const [key, value] of Object.entries(object)) fields[key] = toValue(value);
  return fields;
}

function fromValue(value) {
  if ('stringValue' in value) return value.stringValue;
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('integerValue' in value) return Number(value.integerValue);
  if ('booleanValue' in value) return value.booleanValue;
  if ('timestampValue' in value) return Date.parse(value.timestampValue);
  if ('mapValue' in value) return fromFields(value.mapValue.fields || {});
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(fromValue);
  return null;
}

function fromFields(fields) {
  const object = {};
  for (const [key, value] of Object.entries(fields || {})) object[key] = fromValue(value);
  return object;
}

// A track key can hold a title, and a title can hold a slash, which Firestore
// would read as a path separator. The real key is kept in the document itself.
function favoriteDocId(key) {
  return key.replace(/\//g, '_');
}

// A playlist as stored in Firestore, and as read back from it: only the known
// fields, every one present, so a version that knows fewer still reads it.
function sharedPlaylist(playlist) {
  return {
    id: String(playlist.id || ''),
    name: playlistName(playlist.name),
    tracks: (Array.isArray(playlist.tracks) ? playlist.tracks : []).map(playlistTrack),
    createdAt: Number(playlist.createdAt) || 0,
    updatedAt: Number(playlist.updatedAt) || 0,
  };
}

// --- Building this device's parts ---------------------------------------------

// Seconds to one decimal: enough for any figure the apps show, and it keeps
// a float's long tail out of every number uploaded.
function partJson(value) {
  return JSON.stringify(value, (_key, v) => (
    typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 10) / 10 : v
  ));
}

const utf8 = new TextEncoder();

function hashOf(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(36)}-${text.length}`;
}

function buildParts(stats, history) {
  const parts = {
    tracks: partJson(stats.tracks),
    artists: partJson(stats.artists),
  };

  const years = {};
  for (const [day, entry] of Object.entries(stats.days)) {
    const year = day.slice(0, 4);
    years[year] = years[year] || {};
    years[year][day] = entry;
  }
  for (const [year, days] of Object.entries(years)) parts[`days-${year}`] = partJson(days);

  const months = {};
  for (const entry of history) {
    const month = dayKey(entry.at).slice(0, 7);
    (months[month] = months[month] || []).push(entry);
  }
  // A month is normally one part; a very heavy one is split so no part
  // outgrows a Firestore document.
  for (const [month, entries] of Object.entries(months)) {
    let chunk = [];
    let bytes = 2;
    let index = 1;
    for (const entry of entries) {
      const size = utf8.encode(partJson(entry)).length + 1;
      if (chunk.length > 0 && bytes + size > MAX_PART_BYTES) {
        parts[`history-${month}-${index++}`] = partJson(chunk);
        chunk = [];
        bytes = 2;
      }
      chunk.push(entry);
      bytes += size;
    }
    parts[`history-${month}-${index}`] = partJson(chunk);
  }
  return parts;
}

async function pushLocal(auth) {
  const { parts, meta } = await serialized(async () => {
    const stats = await loadStats();
    return {
      parts: buildParts(stats, await loadHistory()),
      meta: { total: stats.total, firstSeen: stats.firstSeen, sources: stats.sources },
    };
  });

  const state = await loadSyncState();
  const previous = state.hashes || {};
  const hashes = {};
  for (const [name, json] of Object.entries(parts)) hashes[name] = hashOf(json);

  const changed = Object.keys(hashes).filter((name) => previous[name] !== hashes[name]);
  const removed = Object.keys(previous).filter((name) => !(name in hashes));
  if (changed.length === 0 && removed.length === 0 && state.pushedOnce) return;

  const devicePath = `${documentsRoot()}/users/${auth.uid}/devices/${await getDeviceId()}`;
  const writes = [
    ...changed.map((name) => ({ update: { name: `${devicePath}/parts/${name}`, fields: toFields({ json: parts[name] }) } })),
    ...removed.map((name) => ({ delete: `${devicePath}/parts/${name}` })),
  ];
  // The device document goes last: a reader that sees its new hashes can be
  // sure the parts they describe are already there.
  writes.push({
    update: {
      name: devicePath,
      fields: toFields({
        schema: 1,
        platform: 'chrome',
        name: deviceName(),
        updatedAt: Date.now(),
        ...meta,
        parts: hashes,
      }),
    },
  });
  await commit(writes);
  await saveSyncState({ hashes, pushedOnce: true, lastPush: Date.now() });
}

// --- Shared favorites and settings ------------------------------------------
//
// These are recorded as pending while the change is made (inside the
// background queue), and flushed at the start of the next sync. Until then a
// pull keeps them on top of whatever it reads.

async function noteFavoriteChanges(before, after) {
  if (!(await loadAuth())) return;
  const pending = await loadPending();
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (Boolean(before[key]) !== Boolean(after[key])) pending.favorites[key] = after[key] || null;
  }
  await chrome.storage.local.set({ syncPending: pending });
  runSync({ push: false, pull: true });
}

// A playlist created, edited (the whole playlist is written again) or deleted (null).
async function notePlaylistChange(id, playlist) {
  if (!(await loadAuth())) return;
  const pending = await loadPending();
  pending.playlists[id] = playlist;
  await chrome.storage.local.set({ syncPending: pending });
  runSync({ push: false, pull: true });
}

async function noteRetentionChange(retention) {
  if (!(await loadAuth())) return;
  const pending = await loadPending();
  pending.retention = retention;
  await chrome.storage.local.set({ syncPending: pending });
  runSync({ push: true, pull: true });
}

async function flushPending(auth) {
  const pending = await serialized(loadPending);
  const favorites = Object.entries(pending.favorites);
  const playlists = Object.entries(pending.playlists);
  if (favorites.length === 0 && playlists.length === 0 && !pending.retention) return;

  const userPath = `${documentsRoot()}/users/${auth.uid}`;
  const now = Date.now();
  const writes = favorites.map(([key, fav]) => (fav
    ? { update: { name: `${userPath}/favorites/${favoriteDocId(key)}`, fields: toFields({ key, ...fav }) } }
    : { delete: `${userPath}/favorites/${favoriteDocId(key)}` }));
  for (const [id, playlist] of playlists) {
    writes.push(playlist
      ? { update: { name: `${userPath}/playlists/${id}`, fields: toFields(sharedPlaylist(playlist)) } }
      : { delete: `${userPath}/playlists/${id}` });
  }

  const userFields = {};
  if (favorites.length > 0) userFields.favoritesUpdatedAt = now;
  if (playlists.length > 0) userFields.playlistsUpdatedAt = now;
  if (pending.retention) {
    userFields.historyRetention = pending.retention;
    userFields.settingsUpdatedAt = now;
  }
  writes.push({
    update: { name: userPath, fields: toFields(userFields) },
    updateMask: { fieldPaths: Object.keys(userFields) },
  });
  await commit(writes);

  // Only drop what was sent: a star clicked while the commit was in flight
  // stays pending for the next round.
  await serialized(async () => {
    const current = await loadPending();
    for (const [key, fav] of favorites) {
      if (JSON.stringify(current.favorites[key]) === JSON.stringify(fav)) delete current.favorites[key];
    }
    for (const [id, playlist] of playlists) {
      if (JSON.stringify(current.playlists[id]) === JSON.stringify(playlist)) delete current.playlists[id];
    }
    if (current.retention === pending.retention) current.retention = null;
    await chrome.storage.local.set({ syncPending: current });
  });
  if (pending.retention) await saveSyncState({ settingsUpdatedAt: now });
}

// --- Pulling other devices ---------------------------------------------------

async function pullRemote(auth) {
  await flushPending(auth);

  const state = await loadSyncState();
  const userPath = `${documentsRoot()}/users/${auth.uid}`;
  const userDoc = await firestore('GET', userPath);
  const user = userDoc ? fromFields(userDoc.fields) : {};

  // The favorites list is only read again once some device has changed it.
  if (!state.favoritesPulled || user.favoritesUpdatedAt !== state.favoritesUpdatedAt) {
    const remoteFavorites = {};
    for (const doc of await listDocuments(`${userPath}/favorites`)) {
      const fav = fromFields(doc.fields);
      if (!fav.key) continue;
      remoteFavorites[fav.key] = {
        id: fav.id || '',
        title: fav.title || '',
        artist: fav.artist || '',
        source: fav.source || 'youtube',
        addedAt: fav.addedAt || 0,
      };
    }
    await serialized(async () => {
      const pending = await loadPending();
      for (const [key, fav] of Object.entries(pending.favorites)) {
        if (fav) remoteFavorites[key] = fav;
        else delete remoteFavorites[key];
      }
      await chrome.storage.local.set({ favorites: remoteFavorites });
    });
    await saveSyncState({ favoritesPulled: true, favoritesUpdatedAt: user.favoritesUpdatedAt });
  }

  if (!state.playlistsPulled || user.playlistsUpdatedAt !== state.playlistsUpdatedAt) {
    const remotePlaylists = {};
    for (const doc of await listDocuments(`${userPath}/playlists`)) {
      const playlist = sharedPlaylist(fromFields(doc.fields));
      if (playlist.id) remotePlaylists[playlist.id] = playlist;
    }
    await serialized(async () => {
      const pending = await loadPending();
      for (const [id, playlist] of Object.entries(pending.playlists)) {
        if (playlist) remotePlaylists[id] = playlist;
        else delete remotePlaylists[id];
      }
      await chrome.storage.local.set({ playlists: remotePlaylists });
    });
    await saveSyncState({ playlistsPulled: true, playlistsUpdatedAt: user.playlistsUpdatedAt });
  }

  if (user.historyRetention && user.settingsUpdatedAt !== state.settingsUpdatedAt) {
    await serialized(async () => {
      // A change made here and not yet sent wins over the one read back.
      if (!(await loadPending()).retention) await applyHistoryRetention(user.historyRetention);
    });
    await saveSyncState({ settingsUpdatedAt: user.settingsUpdatedAt });
  }

  const ownId = await getDeviceId();
  const remote = await loadRemote();
  const devices = {};
  const wanted = [];
  for (const doc of await listDocuments(`${userPath}/devices`)) {
    const id = doc.name.split('/').pop();
    if (id === ownId) continue;
    const meta = fromFields(doc.fields);
    const known = (remote.devices[id] && remote.devices[id].parts) || {};
    const parts = {};
    for (const [name, hash] of Object.entries(meta.parts || {})) {
      if (known[name] && known[name].hash === hash) parts[name] = known[name];
      else wanted.push({ id, name, hash });
    }
    devices[id] = {
      platform: meta.platform || '',
      name: meta.name || '',
      updatedAt: meta.updatedAt || 0,
      total: meta.total || 0,
      firstSeen: meta.firstSeen || null,
      sources: meta.sources || {},
      parts,
    };
  }

  for (let i = 0; i < wanted.length; i += 100) {
    const batch = wanted.slice(i, i + 100);
    const byName = new Map(batch.map((w) => [`${userPath}/devices/${w.id}/parts/${w.name}`, w]));
    const results = await firestore('POST', `${documentsRoot()}:batchGet`, { documents: [...byName.keys()] });
    for (const result of results || []) {
      if (!result.found) continue;
      const want = byName.get(result.found.name);
      if (!want) continue;
      try {
        const data = JSON.parse(fromFields(result.found.fields).json || 'null');
        devices[want.id].parts[want.name] = { hash: want.hash, data };
      } catch (err) {
        // A part this version can't read is skipped, not fatal.
      }
    }
  }

  await saveRemote({ devices });
  await saveSyncState({ lastPull: Date.now() });
}

// --- Driving it --------------------------------------------------------------
//
// This device's stats are uploaded when the music stops (and on sign-in,
// Refresh, Reset and retention changes), not on a timer. A push that was asked
// for stays owed until it lands, so one that failed offline is retried by the
// alarm instead of waiting for the next pause.

function runSync({ push = false, pull = false } = {}) {
  return syncTask(async () => {
    if (!syncConfigured()) return;
    const auth = await loadAuth();
    if (!auth) return;
    if (push) await saveSyncState({ pushDue: true });
    const state = await loadSyncState();
    try {
      if (state.pushDue) {
        await pushLocal(auth);
        await saveSyncState({ pushDue: false });
      }
      if (pull || Date.now() - (state.lastPull || 0) >= PULL_INTERVAL_MS) await pullRemote(auth);
      await saveSyncState({ error: '' });
    } catch (err) {
      await saveSyncState({ error: String((err && err.message) || err) });
    }
  });
}

// Called from getStats: an open popup keeps the other devices' numbers fresh.
async function pullIfStale() {
  if (syncBusy || !syncConfigured() || !(await loadAuth())) return;
  const state = await loadSyncState();
  if (Date.now() - (state.lastPull || 0) >= POPUP_PULL_INTERVAL_MS) runSync({ pull: true });
}

async function syncStatus() {
  const configured = syncConfigured();
  const auth = configured ? await loadAuth() : null;
  const state = auth ? await loadSyncState() : {};
  const remote = auth ? await loadRemote() : { devices: {} };
  return {
    configured,
    signedIn: Boolean(auth),
    email: auth ? auth.email : '',
    busy: syncBusy,
    // The first pull after signing in: nothing from the other devices is cached yet.
    loading: Boolean(auth) && syncBusy && !state.lastPull,
    lastSync: Math.max(state.lastPush || 0, state.lastPull || 0),
    error: state.error || '',
    signInError: auth ? '' : (await chrome.storage.local.get('syncSignInError')).syncSignInError || '',
    devices: Object.values(remote.devices).map((d) => ({ name: d.name, platform: d.platform })),
  };
}

// --- Merging for the popup ---------------------------------------------------

function addNumbers(into, from) {
  for (const [field, value] of Object.entries(from || {})) {
    if (typeof value === 'number') into[field] = (into[field] || 0) + value;
  }
}

function remoteView(device) {
  const view = { tracks: {}, artists: {}, days: {}, history: [] };
  for (const [name, part] of Object.entries(device.parts)) {
    if (!part.data) continue;
    if (name === 'tracks') view.tracks = part.data;
    else if (name === 'artists') view.artists = part.data;
    else if (name.startsWith('days-')) Object.assign(view.days, part.data);
    else if (name.startsWith('history-') && Array.isArray(part.data)) view.history.push(...part.data);
  }
  return view;
}

// This browser's stats with every other device's folded in. Nothing here is
// written back: the merged figures exist only for display.
async function mergeRemote(stats, history) {
  if (!syncConfigured() || !(await loadAuth())) return { stats, history };
  const devices = Object.values((await loadRemote()).devices);
  if (devices.length === 0) return { stats, history };

  const merged = {
    ...stats,
    days: { ...stats.days },
    sources: { ...stats.sources },
    artists: { ...stats.artists },
    tracks: { ...stats.tracks },
  };
  let mergedHistory = history.slice();

  for (const device of devices) {
    const view = remoteView(device);
    merged.total += device.total || 0;
    addNumbers(merged.sources, device.sources);
    if (device.firstSeen && (!merged.firstSeen || device.firstSeen < merged.firstSeen)) {
      merged.firstSeen = device.firstSeen;
    }

    for (const [key, entry] of Object.entries(view.days)) {
      const day = { ...(merged.days[key] || { total: 0 }) };
      day.hours = { ...(day.hours || {}) };
      addNumbers(day, entry);
      for (const [hour, slice] of Object.entries(entry.hours || {})) {
        const into = { ...(day.hours[hour] || {}) };
        addNumbers(into, slice);
        day.hours[hour] = into;
      }
      merged.days[key] = day;
    }

    for (const [name, entry] of Object.entries(view.artists)) {
      const seconds = typeof entry === 'number' ? entry : entry.seconds || 0;
      const mine = merged.artists[name];
      merged.artists[name] = mine
        ? { ...mine, seconds: mine.seconds + seconds }
        : { seconds, source: (entry && entry.source) || device.platform };
    }

    for (const [key, track] of Object.entries(view.tracks)) {
      const mine = merged.tracks[key];
      merged.tracks[key] = mine
        ? { ...mine, seconds: (mine.seconds || 0) + (track.seconds || 0), plays: (mine.plays || 0) + (track.plays || 0) }
        : { ...track };
    }

    mergedHistory = mergedHistory.concat(view.history);
  }

  return { stats: merged, history: mergedHistory };
}

// --- Schedule ----------------------------------------------------------------

// Created only when missing: the worker wakes every few seconds while music
// plays, and re-creating the alarm each time would keep pushing it back.
chrome.alarms.get(SYNC_ALARM).then((alarm) => {
  if (!alarm) chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) runSync();
});
