import { storage } from './storage.js';
import { icon } from './icons.js';

const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const loginForm = document.getElementById('login-form');
const loginEmail = document.getElementById('login-email');
const loginPassword = document.getElementById('login-password');
const loginError = document.getElementById('login-error');
const loginSubmit = document.getElementById('login-submit');

const list = document.getElementById('list');
const emptyState = document.getElementById('empty');
const countLabel = document.getElementById('count-label');
const composer = document.getElementById('composer');
const urlInput = document.getElementById('url-input');
const addButton = document.getElementById('add-btn');
const notice = document.getElementById('notice');
const toast = document.getElementById('toast');
const undoButton = document.getElementById('undo');
const themeButton = document.getElementById('theme-toggle');
const signOutButton = document.getElementById('sign-out');
const syncStatus = document.getElementById('sync-status');

let links = [];
let editingId = null;       // the link whose title box is open
let editingIsNew = false;   // true right after adding (Esc then means "skip")
let refreshPending = false; // links changed on another device while editing
let pendingUndo = null;     // { link, timeoutId }
const loadingIds = new Set(); // links whose screenshot is being taken

async function init() {
  await storage.ready;
  await storage.requestPersistence();

  storage.on('status', paintSyncStatus);
  storage.on('change', refreshFromStorage);
  storage.on('signedOut', () => showLogin('You’ve been signed out. Please sign in again.'));

  if (storage.isSignedIn()) showApp();
  else showLogin();
}

// ---------- Views ----------

async function showApp() {
  loginView.classList.add('hidden');
  appView.classList.remove('hidden');
  signOutButton.title = `Sign out (${storage.userEmail() || 'signed in'})`;
  paintSyncStatus(navigator.onLine ? storage.status() : 'offline');
  links = await storage.getAllLinks();
  render();
  storage.sync();
}

function showLogin(message = '') {
  appView.classList.add('hidden');
  loginView.classList.remove('hidden');
  toast.classList.remove('show');
  editingId = null;
  links = [];
  loginSubmit.disabled = false;
  loginSubmit.textContent = 'Sign in';
  loginPassword.value = '';
  showLoginError(message);
  loginEmail.focus();
}

function showLoginError(message) {
  loginError.innerHTML = message ? `${icon('alert')}<span></span>` : '';
  if (message) loginError.querySelector('span').textContent = message;
  loginError.classList.toggle('show', !!message);
}

// ---------- Login & sign out ----------

document.getElementById('login-logo').innerHTML = icon('library');
document.querySelectorAll('[data-icon]').forEach((el) => { el.outerHTML = icon(el.dataset.icon); });
document.getElementById('login-fine').innerHTML = `${icon('shield')}Your library is private to your account.`;
signOutButton.innerHTML = icon('logOut');

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = loginEmail.value.trim();
  const password = loginPassword.value;
  if (!email || !password) {
    showLoginError('Enter your email and password.');
    return;
  }

  showLoginError('');
  loginSubmit.disabled = true;
  loginSubmit.textContent = 'Signing in…';
  try {
    await storage.signIn(email, password);
    loginPassword.value = '';
    showApp();
  } catch (err) {
    showLoginError(err.message);
    loginSubmit.disabled = false;
    loginSubmit.textContent = 'Sign in';
  }
});

signOutButton.addEventListener('click', async () => {
  let result = await storage.signOut();
  if (result.unsynced) {
    const ok = confirm(
      'Some changes haven’t synced yet (you may be offline).\n\n' +
      'If you sign out now, those changes will be lost. Sign out anyway?'
    );
    if (!ok) return;
    result = await storage.signOut({ force: true });
  }
  showLogin();
});

// ---------- Sync status ----------

const SYNC_STATES = {
  synced: { icon: 'cloudCheck', label: 'Synced', title: 'All links saved to the cloud' },
  syncing: { icon: 'refresh', label: 'Syncing…', title: 'Saving changes to the cloud' },
  offline: { icon: 'cloudOff', label: 'Offline', title: 'You’re offline. Changes are saved on this device and will sync when you’re back online.' },
  error: { icon: 'cloudOff', label: 'Not synced', title: 'Can’t reach the sync server right now. Changes are saved on this device and will sync later.' },
};

function paintSyncStatus(state) {
  const s = SYNC_STATES[state] || SYNC_STATES.synced;
  syncStatus.className = `sync ${state}`;
  syncStatus.title = s.title;
  syncStatus.innerHTML = `${icon(s.icon)}<span class="label">${s.label}</span>`;
}

// Links changed on another device. Re-read them — but not while a title is
// being typed, or the text box would be thrown away; that waits until done.
async function refreshFromStorage() {
  if (appView.classList.contains('hidden')) return;
  if (editingId !== null) {
    refreshPending = true;
    return;
  }
  links = await storage.getAllLinks();
  render();
}

// ---------- Helpers ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// "Added 2025-11-03", in this device's time zone. Comes from createdAt,
// which is set once when the link is added and never changes.
const pad = (n) => String(n).padStart(2, '0');
function addedDate(iso) {
  const d = new Date(iso);
  return `Added ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Accepts claude.ai/artifact/<id> links (with or without https://, ?query,
// #hash or a trailing slash). Returns the artifact id, or null.
function artifactId(raw) {
  let s = String(raw).trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (u.hostname !== 'claude.ai') return null;
    const m = u.pathname.match(/^\/artifact\/([A-Za-z0-9_-]+)\/?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const findLink = (id) => links.find((l) => l.id === id);
const rowOf = (id) => list.querySelector(`.row[data-id="${CSS.escape(id)}"]`);

let noticeTimer;
function say(kind, iconName, text) {
  notice.className = `notice show ${kind}`;
  notice.innerHTML = `${icon(iconName)}<span></span>`;
  notice.querySelector('span').textContent = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => notice.classList.remove('show'), 4000);
}

// ---------- Rendering ----------

const newestFirst = (a, b) => b.createdAt.localeCompare(a.createdAt);

function render({ enterId = null } = {}) {
  links.sort(newestFirst);
  list.innerHTML = '';
  links.forEach((link) => list.appendChild(renderRow(link, link.id === enterId)));
  emptyState.classList.toggle('hidden', links.length > 0);
  countLabel.textContent = links.length === 1 ? '1 saved' : `${links.length} saved`;
}

function renderRow(link, entering = false) {
  const row = document.createElement('article');
  row.className = 'row' + (entering ? ' enter' : '');
  row.dataset.id = link.id;
  fillRow(row, link);
  return row;
}

// (Re)draws one row in place, e.g. to open or close its title box.
function fillRow(row, link) {
  const editing = link.id === editingId;
  const label = link.title || 'Untitled artifact';
  row.classList.toggle('editing', editing);
  row.innerHTML = `
    <a class="row-link" href="${esc(link.url)}" target="_blank" rel="noopener" aria-label="Open ${esc(label)} in a new tab"></a>
    <div class="row-text">${editing ? editorHTML(link) : textHTML(link)}</div>
    <div class="thumb"></div>`;
  paintThumb(row, link);

  if (editing) {
    const input = row.querySelector('.title-input');
    input.value = link.title;
    requestAnimationFrame(() => { input.focus(); input.select(); });
  }
}

function textHTML(link) {
  const title = link.title
    ? `<h3 class="title">${esc(link.title)}</h3>`
    : `<h3 class="title untitled">Untitled artifact</h3>`;
  const busy = loadingIds.has(link.id) ? ' disabled' : '';
  return `${title}
    <div class="meta">${addedDate(link.createdAt)}</div>
    <div class="actions">
      <button class="icon-btn" type="button" data-act="edit" aria-label="Rename" title="Rename">${icon('pencil')}</button>
      <button class="icon-btn" type="button" data-act="refresh" aria-label="Refresh preview" title="Refresh preview"${busy}>${icon('refresh')}</button>
      <button class="icon-btn danger" type="button" data-act="delete" aria-label="Delete" title="Delete">${icon('trash')}</button>
    </div>`;
}

function editorHTML() {
  return `<input class="title-input" type="text" maxlength="200" placeholder="Give it a name…" aria-label="Artifact title" />
    <div class="edit-hint"><kbd>Enter</kbd> to save · <kbd>Esc</kbd> to ${editingIsNew ? 'skip' : 'cancel'}</div>`;
}

// Draws just the picture area, so a title being typed isn't disturbed.
function paintThumb(row, link) {
  const thumb = row.querySelector('.thumb');
  if (loadingIds.has(link.id)) {
    thumb.innerHTML = `<div class="loading">${icon('loader')}<span class="ph-text">Taking a snapshot…</span></div>`;
  } else if (link.previewPath) {
    thumb.innerHTML = `<img src="${esc(storage.previewUrl(link.previewPath))}" alt="" loading="lazy" decoding="async" />`;
    // If the picture can't be loaded, show the placeholder instead.
    thumb.querySelector('img').addEventListener('error', () => { thumb.innerHTML = placeholderHTML(); }, { once: true });
  } else {
    thumb.innerHTML = placeholderHTML();
  }
  const refreshButton = row.querySelector('[data-act="refresh"]');
  if (refreshButton) refreshButton.disabled = loadingIds.has(link.id);
}

function placeholderHTML() {
  return `<div class="placeholder">
    ${icon('imageOff')}
    <button type="button" class="retry" data-act="refresh" aria-label="Try the preview again">${icon('refresh')}<span class="ph-text">Try again</span></button>
  </div>`;
}

// ---------- Adding a link ----------

urlInput.addEventListener('input', () => { addButton.disabled = !urlInput.value.trim(); });
addButton.innerHTML = `${icon('plus')}<span class="label">Save</span>`;

composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const raw = urlInput.value;
  if (!raw.trim()) return;

  const id = artifactId(raw);
  if (!id) {
    say('error', 'alert', 'That isn’t a Claude artifact link. It should look like claude.ai/artifact/…');
    return;
  }

  urlInput.value = '';
  addButton.disabled = true;

  // Already saved? Show that one instead of saving it twice.
  const existing = links.find((l) => artifactId(l.url) === id);
  if (existing) {
    say('info', 'sparkle', 'Already in your library. Here it is.');
    const row = rowOf(existing.id);
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.remove('highlight');
      void row.offsetWidth; // restart the animation
      row.classList.add('highlight');
    }
    return;
  }

  if (editingId) await finishEditing(true);

  const link = {
    id: crypto.randomUUID(),
    url: `https://claude.ai/artifact/${id}`,
    title: '',
    previewPath: null,
    createdAt: new Date().toISOString(), // the "Added" date — never changed after this
  };
  links.push(link);
  await storage.saveLink(link);

  editingId = link.id;
  editingIsNew = true;
  loadingIds.add(link.id);
  render({ enterId: link.id });
  rowOf(link.id)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  loadPreview(link.id);
});

// ---------- Preview screenshots ----------

async function loadPreview(id) {
  const link = findLink(id);
  if (!link) return;
  loadingIds.add(id);
  const row = rowOf(id);
  if (row) paintThumb(row, link);

  try {
    const path = await storage.fetchPreview(link.url);
    const current = findLink(id); // the list may have been re-read meanwhile
    if (current) {
      current.previewPath = path;
      await storage.saveLink(current);
    }
  } catch (err) {
    console.warn('Preview failed:', err);
    say('error', 'alert', navigator.onLine
      ? 'Couldn’t get a preview right now. You can try again later.'
      : 'You’re offline, so there’s no preview yet. Try again when you’re back online.');
  } finally {
    loadingIds.delete(id);
    const current = findLink(id);
    const currentRow = rowOf(id);
    if (current && currentRow) paintThumb(currentRow, current);
  }
}

// ---------- Row buttons & title editing ----------

list.addEventListener('click', (event) => {
  const button = event.target.closest('[data-act]');
  if (!button) return;
  event.preventDefault();
  const id = button.closest('.row').dataset.id;
  const act = button.dataset.act;
  if (act === 'edit') startEditing(id);
  if (act === 'refresh' && !loadingIds.has(id)) loadPreview(id);
  if (act === 'delete') deleteWithUndo(id);
});

list.addEventListener('keydown', (event) => {
  if (!event.target.classList.contains('title-input') || event.isComposing) return;
  if (event.key === 'Enter') { event.preventDefault(); finishEditing(true); }
  if (event.key === 'Escape') { event.preventDefault(); finishEditing(false); }
});

// Clicking or tapping away from the title box saves it.
list.addEventListener('focusout', (event) => {
  if (event.target.classList.contains('title-input')) finishEditing(true);
});

async function startEditing(id) {
  if (editingId && editingId !== id) await finishEditing(true);
  editingId = id;
  editingIsNew = false;
  const row = rowOf(id);
  const link = findLink(id);
  if (row && link) fillRow(row, link);
}

async function finishEditing(save) {
  const id = editingId;
  if (!id) return;
  const row = rowOf(id);
  const input = row && row.querySelector('.title-input');
  const value = input ? input.value.trim() : '';
  editingId = null;
  editingIsNew = false;

  const link = findLink(id);
  if (link && save && value !== link.title) {
    link.title = value;
    await storage.saveLink(link);
  }

  if (refreshPending) {
    refreshPending = false;
    links = await storage.getAllLinks();
    render();
  } else if (row && link) {
    fillRow(row, link);
  }
}

// ---------- Delete with 5-second undo ----------

function deleteWithUndo(id) {
  const link = findLink(id);
  const row = rowOf(id);
  if (!link || !row) return;
  row.classList.add('leaving');
  setTimeout(async () => {
    links = links.filter((l) => l.id !== id);
    await storage.deleteLink(id); // marks it deleted (a tombstone), not a hard delete
    render();
    showUndo(link);
  }, 250);
}

function showUndo(link) {
  if (pendingUndo) clearTimeout(pendingUndo.timeoutId);
  toast.classList.add('show');
  const timeoutId = setTimeout(() => {
    toast.classList.remove('show');
    pendingUndo = null;
  }, 5000);
  pendingUndo = { link, timeoutId };
}

undoButton.addEventListener('click', async () => {
  if (!pendingUndo) return;
  clearTimeout(pendingUndo.timeoutId);
  const { link } = pendingUndo;
  pendingUndo = null;
  toast.classList.remove('show');

  links.push(link); // same link, same "Added" date
  await storage.saveLink(link);
  render({ enterId: link.id });
});

// ---------- Theme ----------

const THEME_KEY = 'artifacts-theme';

function isDark() {
  const theme = document.documentElement.dataset.theme;
  return theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}

function paintThemeButton() {
  themeButton.innerHTML = icon(isDark() ? 'sun' : 'moon');
}

try {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved) document.documentElement.dataset.theme = saved;
} catch (err) {
  // Storage blocked (e.g. private mode) — fall back to the system theme.
}

themeButton.addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch (err) {}
  paintThemeButton();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paintThemeButton);
paintThemeButton();

init();
