// Signage add-on background: keeps exactly one fullscreen player window open,
// keeps the display awake, reopens the player if it is closed, and picks up new
// versions dropped in by the screen-PC updater.
// Runs as a service worker in Chrome/Edge and as a background script in Firefox.
if (typeof importScripts === 'function') importScripts('config.js');

const PLAYER_URL = chrome.runtime.getURL('player.html');

async function ensurePlayer() {
  const tabs = await chrome.tabs.query({ url: `${PLAYER_URL}*` });
  if (tabs.length) {
    const [keep, ...extra] = tabs;
    if (extra.length) await chrome.tabs.remove(extra.map((t) => t.id));
    const win = await chrome.windows.get(keep.windowId);
    if (win.state !== 'fullscreen') await chrome.windows.update(keep.windowId, { state: 'fullscreen', focused: true });
    if (keep.discarded) await chrome.tabs.reload(keep.id);
    return;
  }
  const win = await chrome.windows.create({ url: PLAYER_URL, focused: true });
  await chrome.windows.update(win.id, { state: 'fullscreen' });
}

// Unpacked installs are read from disk, so when the updater has dropped in a
// new version, reloading the player page runs the new player code. (This
// background script itself is refreshed the next time the browser starts.)
async function checkForUpdatedFiles() {
  try {
    const res = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    const onDisk = (await res.json()).version;
    const { appliedVersion } = await chrome.storage.local.get('appliedVersion');
    if (!onDisk || onDisk === (appliedVersion || chrome.runtime.getManifest().version)) return;
    await chrome.storage.local.set({ appliedVersion: onDisk });
    for (const tab of await chrome.tabs.query({ url: `${PLAYER_URL}*` })) await chrome.tabs.reload(tab.id);
  } catch {}
}

function start() {
  chrome.storage.local.set({ appliedVersion: chrome.runtime.getManifest().version });
  chrome.power?.requestKeepAwake('display');
  chrome.alarms.create('signage-watchdog', { periodInMinutes: 1 });
  ensurePlayer().catch((err) => console.error('[signage]', err));
}

chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'signage-watchdog') return;
  chrome.power?.requestKeepAwake('display');
  ensurePlayer().catch((err) => console.error('[signage]', err));
  checkForUpdatedFiles();
});
chrome.action.onClicked.addListener(() => ensurePlayer());
