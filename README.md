# Signage

Self-hosted digital signage. One central server holds the content and the
schedules. Each display PC runs a browser add-on that the server generates
for that screen only. The add-on connects back to the server over LAN or WAN,
gets its content, and plays it fullscreen.

```
           ┌─────────────────────────── Server (Node.js) ──────────────────────────┐
 Admin ──▶ │  Admin console (/admin)   REST API   Media store   Scheduler   WS hub │
 browser   └───────────────▲──────────────────────────────────────────▲───────────┘
                           │ HTTPS/HTTP: media files (token-auth)     │ WebSocket: manifest push,
                           │                                          │ status, remote commands
              ┌────────────┴───────────┐                 ┌────────────┴───────────┐
              │ Screen PC: Chrome/Edge │       …         │ Screen PC: Chrome/Edge │
              │  add-on for "Lobby"    │                 │  add-on for "Canteen"  │
              └────────────────────────┘                 └────────────────────────┘
```

## Features

- **Per-screen add-on.** Each screen gets its own Manifest V3 extension for
  Chrome or Edge. It has that screen's server URL and secret token built in.
  You can revoke a screen's token at any time, which disconnects the old
  add-on straight away.
- **Live updates.** Players keep a WebSocket open to the server. When you edit
  a playlist or screen, or a schedule window starts or ends, the server pushes
  a new manifest. On a LAN the screen changes about 50 ms after you click
  Save. If a proxy blocks WebSockets, the player falls back to HTTP polling.
- **Keeps playing offline.** Players pre-cache every asset with the Cache API
  before they switch playlists, and they keep the last good manifest. If the
  server or network goes down, the screen keeps playing and reconnects
  automatically when it can.
- **Scheduling per screen.** Each screen has a default playlist plus a list
  of rules. A rule can set days of the week, a time window (overnight windows
  are allowed), a date range and a priority. Times are evaluated in the
  screen's own time zone.
- **Remote configuration per screen.** You can set orientation (portrait or
  flipped), fit or fill, transition and background colour. Screens can be told
  to *Identify* (show their name on the display), *Skip* to the next item or
  *Reload*. The console shows live status for each screen: online or offline,
  what it is playing, its resolution and its IP.
- **Content types**
  - Images (PNG, JPEG, WebP, GIF, SVG, AVIF).
  - Slide decks. PDFs are converted with `pdftoppm`. PowerPoint, Keynote and
    ODP files go through LibreOffice first. Each slide becomes an image, with
    a per-slide duration.
  - Video (MP4, WebM). A video plays to the end or for a set number of
    seconds, and is muted by default.
- **Kiosk behaviour.** The add-on opens the player fullscreen when the browser
  starts and keeps the display awake. A 1-minute watchdog reopens the player
  if it gets closed.

## Quick start

Requirements: Node.js 20+. Optional: `poppler-utils` for PDF decks, and
LibreOffice for PowerPoint decks.

```bash
npm install
ADMIN_PASSWORD='choose-a-password' npm start
# → http://<server-ip>:8080/admin/
```

If you don't set `ADMIN_PASSWORD`, a password is generated on the first run.
It is printed to the console and saved to `data/admin-password.txt`.

### Windows

Install Node.js (LTS) from https://nodejs.org, then double-click
**`start-signage.bat`**. It installs anything missing, shows the addresses to
use from other devices, and starts the server. Close the window to stop it.

The first time, set an admin password: open PowerShell in the folder and run
`$env:ADMIN_PASSWORD="your-password"; npm.cmd start` once. Without that, use
the generated one in `data\admin-password.txt`. You can change it later under
**Settings**.

To update, download the new ZIP from GitHub and copy its contents over the
folder. Your `data` folder (media, playlists, screens, password) is kept.

### Your first screen

1. **Media**: upload a few images or a PDF/PPTX deck.
2. **Playlists**: create a playlist, add the media, set durations, then click
   **Save & publish**.
3. **Screens**: click **Add screen**, give it a name, and pick the playlist as
   its default.
4. Click **Add-on** on the screen card. Enter the server URL *as the screen PC
   will reach it*, for example `http://192.168.1.20:8080`. Don't use
   `localhost`. Then download the zip.
5. On the screen PC:
   1. Unzip the add-on to a permanent folder.
   2. Open `chrome://extensions` (or `edge://extensions`) and turn on
      **Developer mode**.
   3. Click **Load unpacked** and pick the folder.

   The player opens fullscreen.

**Preview** on a screen card gives you a link to the same player, which runs
in any browser without the add-on, including Chrome or Safari on phones and
tablets. Mobile browsers can't install extensions, so use this link to test on
phones. Set the screen's **Server URL** to the PC's network address first, so
the link doesn't point at `localhost`. Over plain http, phones play the content
but don't keep an offline copy.

## Configuration

| Env var          | Default        | Purpose |
|------------------|----------------|---------|
| `PORT`           | `8080`         | HTTP port |
| `HOST`           | `0.0.0.0`      | Bind address |
| `DATA_DIR`       | `./data`       | Database (`db.json`) and uploaded media |
| `ADMIN_PASSWORD` | generated      | Admin console password. If set, it overrides the stored password |
| `PUBLIC_URL`     | request host   | Default server URL built into add-ons, e.g. `https://signage.example.com` |
| `MAX_UPLOAD_MB`  | `2048`         | Per-file upload limit |
| `DECK_WIDTH`     | `1920`         | Pixel width for rendered slides. Use `3840` for 4K screens |

Each screen also has a **Server URL** setting. Use it when screens reach the
server at different addresses, for example the LAN IP inside the building and
a public hostname from a branch office.

## Deploying screen PCs

**Starting at boot.** Set the browser to launch at login. The add-on opens the
player itself. For a cleaner kiosk, add these flags to the browser shortcut:

```
chrome.exe --kiosk --noerrdialogs --disable-session-crashed-bubble --autoplay-policy=no-user-gesture-required
```

`--autoplay-policy=no-user-gesture-required` lets videos play with sound.

**Fleet roll-out.** "Load unpacked" is fine for testing. For many PCs, use
Chrome or Edge enterprise policy (GPO or Intune) to load the add-on folder
(`ExtensionInstallForcelist` with a self-hosted CRX, or
`--load-extension=<dir>` in the kiosk shortcut). Users then can't remove it.

**WAN / remote sites.** Put the server behind a TLS reverse proxy such as
Caddy or nginx. Forward `/ws` with the WebSocket `Upgrade` headers, and set
`PUBLIC_URL=https://…`. Media is cached on each screen, so playback doesn't
depend on the WAN link once the content has downloaded.

## Security model

- The admin console uses a password and an HMAC-signed, HttpOnly, SameSite
  session cookie.
- Each screen has its own random token, which is built into its add-on. A
  player sends the token in its WebSocket `hello` message, and as a Bearer
  header when fetching media. Media files can only be read by the admin or a
  registered screen.
- Use **Regenerate token** (in the screen's Edit dialog) if an add-on zip
  leaks. The old player is disconnected immediately.

## Development

```bash
npm run dev     # restart on change
npm test        # scheduler unit tests + API/WebSocket/add-on/deck integration tests
```

```
server/
  app.js         REST API, uploads, static UIs
  realtime.js    WebSocket hub: auth, manifest push, status, commands, schedule ticker
  schedule.js    which playlist a screen should show right now
  manifest.js    playlist → flat list of renderable items + content hash
  extension.js   builds the per-screen add-on zip
  convert.js     PDF / PowerPoint → slide images
  store.js       JSON-file datastore
player/          the player: runs in the add-on and in browser preview
extension/       add-on service worker (window management, watchdog, keep-awake)
admin/           admin console (vanilla JS, no build step)
```

The player code lives in `player/` and is copied into every add-on when it is
generated. After changing the player, re-download the add-on for each screen.
In the console, the screen's status shows which player version is running.

## Roadmap

- **Video at scale.** Large files currently go into the Cache API as whole
  blobs. For long or 4K videos, switch to range-request streaming with a
  service-worker cache, and add server-side transcoding (`ffmpeg`) to H.264 or
  VP9 at each screen's resolution.
- Screen groups / tags so one schedule applies to many screens.
- Screenshots from players for remote verification.
- Signed CRX packaging and an auto-update URL, so add-on updates roll out
  without reinstalling.
- Move from the JSON store to SQLite or Postgres, and add multiple admin users
  with roles.
