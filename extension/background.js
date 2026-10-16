// Signage add-on service worker: keeps exactly one fullscreen player window
// open, keeps the display awake, and reopens the player if it is closed.
importScripts('config.js');

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

function start() {
  chrome.power.requestKeepAwake('display');
  chrome.alarms.create('signage-watchdog', { periodInMinutes: 1 });
  ensurePlayer().catch((err) => console.error('[signage]', err));
}

chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'signage-watchdog') ensurePlayer().catch((err) => console.error('[signage]', err));
});
chrome.action.onClicked.addListener(() => ensurePlayer());
