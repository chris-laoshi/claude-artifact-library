// storage.js
// The ONLY file that talks to IndexedDB and Supabase. Every other file goes
// through the `storage` object exported at the bottom.
//
// Local-first (same pattern as the notes app's storage_v2.js): every change
// is written to IndexedDB immediately (so the app is fast and works offline)
// and marked `dirty`. A background sync then pulls the user's links from
// Supabase, merges them (newest edit wins), and pushes dirty links up.
// Deletes are kept as `deleted` tombstones until they've reached the server,
// so they sync to other devices too.
//
// Talks to Supabase's REST endpoints with fetch rather than loading the
// supabase-js library from a CDN, so the app still starts with no network.

const SUPABASE_URL = 'https://upobdjogsnjarngfoqso.supabase.co';
// The publishable key is meant to ship in public code. Row-level security
// in the database is what keeps each user's links private.
const SUPABASE_KEY = 'sb_publishable_c0HP7EQSO8xNO5QJqUf4UA_NCj_e9nX';
const PREVIEW_FUNCTION = 'super-responder';
const PREVIEW_BUCKET = 'artifact-previews';

// The notes app lives on the same site (chris-laoshi.github.io), so this
// database has its own name to keep the two apps' data apart.
const DB_NAME = 'artifact-library';
const DB_VERSION = 1;
const STORE_NAME = 'links';
const SESSION_STORE_NAME = 'session';
const SESSION_ID = 'current';
const COLUMNS = 'id,url,title,preview_path,created_at,updated_at,deleted';

// ---------- IndexedDB ----------

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(SESSION_STORE_NAME)) {
        db.createObjectStore(SESSION_STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });
  return dbPromise;
}

// Runs `fn(store)` in one transaction; resolves when it commits, with the
// result of the request `fn` returns (if any).
async function withStore(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const request = fn(tx.objectStore(STORE_NAME));
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}

const readAll = () => withStore('readonly', (store) => store.getAll());
const readOne = (id) => withStore('readonly', (store) => store.get(id));
const putOne = (record) => withStore('readwrite', (store) => { store.put(record); });
const clearAll = () => withStore('readwrite', (store) => { store.clear(); });

async function readStoredSession() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESSION_STORE_NAME, 'readonly');
    const request = tx.objectStore(SESSION_STORE_NAME).get(SESSION_ID);
    request.onsuccess = () => resolve(request.result ? request.result.value : null);
    request.onerror = () => reject(request.error);
  });
}

async function writeStoredSession(value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESSION_STORE_NAME, 'readwrite');
    if (value) tx.objectStore(SESSION_STORE_NAME).put({ id: SESSION_ID, value });
    else tx.objectStore(SESSION_STORE_NAME).delete(SESSION_ID);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// Ask the browser not to auto-clear this site's storage under pressure.
async function requestPersistence() {
  if (navigator.storage && navigator.storage.persist) {
    try {
      return await navigator.storage.persist();
    } catch (err) {
      console.warn('Storage persistence request failed:', err);
      return false;
    }
  }
  return false;
}

// ---------- Links (what the app calls) ----------
//
// A link: { id, url, title, previewPath, createdAt, updatedAt }
// createdAt is the "Added" date. It is set once when the link is created and
// never changed (the database also refuses to change it).

async function getAllLinks() {
  const all = await readAll();
  return all.filter((link) => !link.deleted);
}

// Creates or overwrites a link (links carry their own id).
async function saveLink(link) {
  await putOne({ ...link, updatedAt: new Date().toISOString(), deleted: false, dirty: true });
  scheduleSync();
  return link;
}

async function deleteLink(id) {
  const existing = await readOne(id);
  if (!existing) return;
  await putOne({ ...existing, updatedAt: new Date().toISOString(), deleted: true, dirty: true });
  scheduleSync();
}

const previewUrl = (path) =>
  path ? `${SUPABASE_URL}/storage/v1/object/public/${PREVIEW_BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}` : null;

// Asks the Edge Function to screenshot the artifact and store the picture.
// Resolves to the new storage path; throws if no picture could be made.
async function fetchPreview(url) {
  const res = await authedFetch(`${SUPABASE_URL}/functions/v1/${PREVIEW_FUNCTION}`, {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `Preview request failed (${res.status})`);
  if (!data.preview_path) throw new Error(data.preview_error || 'No preview could be made');
  return data.preview_path;
}

// ---------- Events ----------

const listeners = { change: new Set(), status: new Set(), signedOut: new Set() };

// change: links changed from another device (re-read them)
// status: 'synced' | 'syncing' | 'offline' | 'error'
// signedOut: the session ended on its own (e.g. expired or revoked)
function on(event, callback) {
  listeners[event].add(callback);
}

function emit(event, arg) {
  listeners[event].forEach((callback) => callback(arg));
}

let status = 'synced';

function setStatus(next) {
  status = next;
  emit('status', status);
}

// ---------- Session ----------

class AuthError extends Error {}

let session = null;
const ready = restoreSession();

async function restoreSession() {
  try {
    session = await readStoredSession();
  } catch (err) {
    console.warn('Session restore failed:', err);
  }
}

async function saveSession(next) {
  session = next;
  try {
    await writeStoredSession(next);
  } catch (err) {
    console.warn('Session save failed:', err);
  }
}

function sessionFrom(data) {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    email: data.user && data.user.email,
  };
}

async function authPost(path, body, accessToken) {
  const headers = { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function signIn(email, password) {
  let res;
  try {
    res = await authPost('token?grant_type=password', { email, password });
  } catch (err) {
    throw new Error('Can’t connect. Check your internet connection and try again.');
  }
  if (!res.ok) {
    if (res.status === 400) throw new Error('Wrong email or password.');
    if (res.status === 429) throw new Error('Too many attempts. Wait a minute and try again.');
    throw new Error('Sign-in failed. Please try again in a moment.');
  }
  await saveSession(sessionFrom(res.data));
  sync();
}

// Syncs first; if changes still haven't reached the server (e.g. offline),
// returns { unsynced: true } without signing out unless `force` is set.
// Signing out clears this device's copy of the links.
async function signOut({ force = false } = {}) {
  await sync();
  const unsynced = (await readAll()).some((link) => link.dirty);
  if (unsynced && !force) return { unsynced: true };

  if (session) {
    // scope=local signs out this device only, not your other devices.
    authPost('logout?scope=local', {}, session.accessToken).catch(() => {});
  }
  await saveSession(null);
  await clearAll();
  setStatus('synced');
  return { unsynced: false };
}

// Called when the server rejects our refresh token. Local links are kept so
// unsynced changes aren't lost; they sync after the next sign-in.
function endSession() {
  saveSession(null);
  emit('signedOut');
}

let refreshing = null;

function refreshSession() {
  if (!refreshing) {
    refreshing = (async () => {
      const res = await authPost('token?grant_type=refresh_token', { refresh_token: session.refreshToken });
      if (res.ok) {
        await saveSession({ ...sessionFrom(res.data), email: sessionFrom(res.data).email || session.email });
      } else if (res.status === 400 || res.status === 401) {
        endSession();
        throw new AuthError('Session expired');
      } else {
        throw new Error(`Token refresh failed (${res.status})`);
      }
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

// fetch() with a valid access token, refreshing it once if it has expired.
// Returns the response whatever its status; callers decide what's an error.
async function authedFetch(url, options = {}) {
  if (!session) throw new AuthError('Not signed in');
  if (Date.now() > session.expiresAt - 60000) await refreshSession();

  const send = () => fetch(url, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  let res = await send();
  if (res.status === 401) {
    await refreshSession();
    res = await send();
  }
  return res;
}

// fetch() against the REST API; throws on any error status.
async function rest(path, options = {}) {
  const res = await authedFetch(`${SUPABASE_URL}/rest/v1/${path}`, options);
  if (!res.ok) throw new Error(`Sync request failed (${res.status})`);
  return res;
}

// ---------- Sync ----------

const toRow = (link) => ({
  id: link.id,
  url: link.url,
  title: link.title || '',
  preview_path: link.previewPath || null,
  created_at: link.createdAt, // the database keeps the first value forever
  updated_at: link.updatedAt,
  deleted: !!link.deleted,
});

const fromRow = (row) => ({
  id: row.id,
  url: row.url,
  title: row.title || '',
  previewPath: row.preview_path || null,
  createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
  deleted: false,
  dirty: false,
});

// Should the server's copy replace what's on this device?
function remoteWins(local, row) {
  if (!local) return !row.deleted;
  const localTime = Date.parse(local.updatedAt);
  const remoteTime = Date.parse(row.updated_at);
  if (local.dirty) return remoteTime > localTime;
  return remoteTime !== localTime || row.deleted;
}

let syncing = false;
let syncAgain = false;
let syncTimer = null;

function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, 400);
}

async function sync() {
  if (!session) return;
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  setStatus('syncing');
  try {
    do {
      syncAgain = false;
      await syncOnce();
    } while (syncAgain);
    setStatus('synced');
  } catch (err) {
    if (!(err instanceof AuthError)) {
      console.warn('Sync failed:', err);
      setStatus(navigator.onLine ? 'error' : 'offline');
    }
  } finally {
    syncing = false;
  }
}

async function syncOnce() {
  // 1. Pull everything (one person's links are small).
  const res = await rest(`links?select=${COLUMNS}`);
  const rows = await res.json();
  const remote = new Map(rows.map((row) => [row.id, row]));

  // 2. Merge server changes in. Each link is re-read inside the transaction
  //    so an edit made while the pull was in flight isn't overwritten.
  let changed = false;
  await withStore('readwrite', (store) => {
    for (const row of rows) {
      const request = store.get(row.id);
      request.onsuccess = () => {
        const local = request.result;
        if (!remoteWins(local, row)) return;
        if (row.deleted) store.delete(row.id);
        else store.put(fromRow(row));
        changed = true;
      };
    }
  });
  if (changed) emit('change');

  // 3. Push local changes.
  const local = await readAll();
  const toPush = local.filter((link) => {
    const row = remote.get(link.id);
    if (!row) return link.dirty || !link.deleted;
    return link.dirty && Date.parse(link.updatedAt) >= Date.parse(row.updated_at);
  });
  if (toPush.length === 0) return;

  await rest('links?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(toPush.map(toRow)),
  });

  // 4. Mark pushed links clean, unless they were edited again meanwhile.
  //    Tombstones have done their job once the server has them.
  await withStore('readwrite', (store) => {
    for (const pushed of toPush) {
      const request = store.get(pushed.id);
      request.onsuccess = () => {
        const current = request.result;
        if (!current || current.updatedAt !== pushed.updatedAt) return;
        if (current.deleted) store.delete(current.id);
        else store.put({ ...current, dirty: false });
      };
    }
  });
}

// Sync when coming back online, when the tab is shown again (to pick up
// edits from other devices), and every minute while it's visible.
window.addEventListener('online', () => sync());
window.addEventListener('offline', () => { if (session) setStatus('offline'); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') sync();
});
setInterval(() => {
  if (document.visibilityState === 'visible') sync();
}, 60000);

export const storage = {
  ready,
  requestPersistence,
  getAllLinks,
  saveLink,
  deleteLink,
  fetchPreview,
  previewUrl,
  signIn,
  signOut,
  sync,
  on,
  isSignedIn: () => !!session,
  userEmail: () => (session ? session.email : null),
  status: () => status,
};
