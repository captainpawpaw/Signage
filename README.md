# Signage

Self-hosted digital signage. One central server holds the content and the
schedules. Each display PC runs a browser add-on that finds the server on the
network by itself, pairs with it, and plays end-to-end encrypted content in
fullscreen.

```
           ┌──────────────────────────── Server (Node.js) ───────────────────────────┐
 Admin ──▶ │ Console (/admin)  REST API  Media + conversion  Scheduler  Signing keys │
 browser   │                  WebSocket hub ── signed messages ──┐  mDNS: signage.local
           └───────────────▲─────────────────────────────────────┼───────────────────┘
                           │ AES-GCM encrypted chunks            │ manifests, commands,
                           │ (key wrapped per screen)            │ status, screenshots
              ┌────────────┴───────────┐                ┌────────┴───────────────┐
              │ Screen PC: Chrome/Edge │       …        │ Screen PC: Chrome/Edge │
              │ add-on + device keys   │                │ add-on + device keys   │
              └────────────────────────┘                └────────────────────────┘
```

## Features

- **One add-on for every screen, no IP addresses.** The add-on comes in
  Chrome/Edge and Firefox versions. It tries every way it knows to reach the
  server: `signage.local` (the server announces this name with mDNS), the
  server PC's name, its LAN addresses, and the last address that worked. A new
  screen then shows a **pairing code**, which you approve in the console. If you
  prefer to skip the code, you can download a *pre-configured* add-on that pairs
  with one specific screen on its own.
- **PGP-style end-to-end encryption.** See [Security](#security) below.
- **Live updates.** An edit shows on screen within about 50 ms on a LAN.
  Schedule changes (a window starting or ending) apply within 15 seconds.
- **Keeps playing offline.** Content is cached on the screen PC, still
  encrypted. A screen that restarts while the server is down carries on
  playing.
- **Scheduling.** Each screen has a default playlist plus rules. A rule can
  set days of the week, a time window (overnight windows are allowed), a date
  range and a priority. Rules use each screen's own time zone.
- **Groups.** Put screens into groups such as "Ground floor" or "Canteen". A
  group can have its own default playlist and schedule. You can also send a
  command to every screen in a group at once: Identify, Screenshots or Reload.
- **Screenshots.** The console shows what each screen is actually displaying.
  Screens send a screenshot every 5 minutes, after content changes, and when
  you ask for one.
- **Remote control.** You can set each screen's orientation, fit, transition
  and background colour. You can tell a screen to Identify, Skip or Reload. The
  console shows live status: online or offline, encrypted or not, what is
  playing, resolution, IP and add-on version.
- **Content**
  - Images.
  - Slide decks: PDF, PowerPoint, Keynote and ODP. Each slide becomes an image.
  - Video. Any format ffmpeg can read, including iPhone HEVC/MOV, is converted
    to MP4 that plays everywhere. Video **streams** to screens, so long or 4K
    files start at once and are never held in memory whole.
- **Auto-updates.** On Windows screen PCs, an updater checks the server every
  15 minutes. It installs a new version only if the server's signature on it is
  valid. For managed fleets, the server also offers a signed CRX and an update
  manifest, which work with Chrome/Edge policies.
- **Windows auto-start.** The server runs in the background from boot and
  restarts itself if it stops.

## Quick start (Windows)

1. Install Node.js (LTS) from https://nodejs.org.
2. Download this repository as a ZIP and extract it.
3. Double-click **`start-signage.bat`**.
4. Open http://localhost:8080/admin/. The password is in
   `data\admin-password.txt`. You can change it under **Settings**.

**Optional tools:**

| Tool | Needed for | Install with |
|---|---|---|
| ffmpeg | Video conversion and streaming | `winget install Gyan.FFmpeg` |
| poppler | PDF decks | `winget install oschwartz10612.Poppler` |
| LibreOffice | PowerPoint decks | https://www.libreoffice.org |

Restart the server after installing a tool.

**Start with Windows.** Run **`windows\install-autostart.bat`** (it asks for
admin rights). The server then starts at boot, before anyone logs in, and
restarts if it stops. The script also opens the Windows firewall for the local
network. Its log is in `data\server.log`. To undo it, run
`windows\uninstall-autostart.bat`.

**Other platforms:** `npm install`, then `npm start`.

## Setting up a screen

**Windows screen PC (recommended)**

1. In the console, click **Screens → Install add-on → Windows screen PC
   installer**. Alternatively, open `http://<server>:8080/addon/` on the
   screen PC itself.
2. Unzip the download and run **`setup-screen.bat`**. It:
   - installs the add-on into `C:\ProgramData\Signage\addon`,
   - starts Chrome (or Edge) fullscreen on the player at every login,
   - installs the updater.
3. Load the add-on, which Chrome and Edge only allow by hand:
   1. Open `chrome://extensions`.
   2. Turn on **Developer mode**.
   3. Click **Load unpacked** and pick `C:\ProgramData\Signage\addon`.
4. The screen shows a 6-character code. In the console, go to **Screens →
   Pair a screen** (or use the banner that appears), enter the code and pick a
   name and playlist.

**Any computer:** download the Chrome/Edge add-on from **Install add-on**,
unzip it, then use **Load unpacked** as above.

**Firefox:** go to `about:debugging`, then **This Firefox → Load Temporary
Add-on** and pick `manifest.json`. This lasts until Firefox restarts. For
permanent use, the add-on must be signed by Mozilla (free, as an unlisted
add-on). The Firefox version is not tested yet.

**Pre-configured add-on.** On a screen card, click **Add-on**. That download
pairs itself with that screen on first start, so no code is needed. Each
download carries a one-time token, and a new download cancels the previous
one.

## Testing on phones and tablets

Mobile browsers can't install add-ons, so phones use a **Preview link**
instead. Click **Preview** on a screen, then **Copy**, and open the link on the
phone. Before you do, set the screen's **Preview address** under **Edit** to
`http://<server-ip>:8080`.

If you want an address that is easier to type on a TV or a phone, click
**Create short link** in the Preview dialog. That gives an address such as
`http://192.168.1.20:8080/p/K7Q2MX`. Short links are off until you create
them, and you can remove one at any time. Wrong guesses are rate-limited, and
**Unpair & reset access** replaces the code.

Preview links are **not encrypted**. Use them for testing only. When you no
longer need them, switch them off in **Settings**. From then on, only
encrypted add-on screens can play content.

## Security

The design follows PGP's model of "encrypt to the recipient's public key,
sign as the sender":

| | |
|---|---|
| **Device identity** | Each add-on creates two P-256 key pairs with WebCrypto: one for signing and one for key exchange. The private keys are created *non-extractable* and stored in the browser profile, so they cannot be copied off the screen. The device proves it holds them with a signed challenge on every connection. |
| **Content encryption** | Every file has its own random AES-256-GCM key. Files are sent as authenticated 1 MiB chunks, each bound to its file ID, its position and the total chunk count, so chunks can't be swapped or truncated. |
| **Key wrapping** | A file's key is wrapped separately for each paired screen, under a key derived with HKDF-SHA256 from ECDH(server, device). Only that screen can unwrap it. |
| **Signing** | Everything the server sends to a screen is signed with the server's ECDSA P-256 key. Screens only accept a signed message if it matches their own connection and has an increasing sequence number, so old messages can't be replayed and messages from another connection are rejected. The server's public key is built into the add-on (pinned). A spoofed server or a man-in-the-middle can't push content or commands. |
| **At rest** | Screens cache chunks encrypted. Screenshots travel back to the server encrypted under the same per-screen key. |
| **Updates** | The screen-PC updater installs a new add-on only if the server's signature on the download is valid. |
| **Pairing** | Approving a code binds a device's public keys to a screen. **Unpair & reset access** (under **Edit**) revokes it immediately. |

Limitations to be aware of:

- **The console itself uses plain HTTP by default**, so your admin password
  crosses the network unencrypted. To use HTTPS, set `TLS_CERT` and `TLS_KEY`,
  or put the server behind a reverse proxy.
- **Only approve pairing codes you can see on your own screen.** Anyone on
  the LAN can run the add-on and show a code.
- **Check the fingerprint once.** The add-on trusts the server key it was
  downloaded with. When you install the first screen, check that the
  fingerprint shown on it matches the one under **Settings → Security**.
- **Back up `data/keys/`** along with the rest of `data/`. If you lose the
  keys, every screen has to be paired again.
- **Physical access.** Someone with access to an unlocked screen PC can watch
  what it plays, though they can't extract its keys.

## Configuration

| Env var          | Default        | Purpose |
|------------------|----------------|---------|
| `PORT`           | `8080`         | HTTP(S) port |
| `HOST`           | `0.0.0.0`      | Bind address |
| `DATA_DIR`       | `./data`       | Database, media, screenshots and keys |
| `ADMIN_PASSWORD` | generated      | If set, overrides the stored admin password at every start |
| `PUBLIC_URL`     | –              | Preferred address for add-ons and auto-updates, e.g. `https://signage.example.com` |
| `TLS_CERT`, `TLS_KEY` | –         | PEM files: serve HTTPS directly |
| `MDNS`           | on             | Set to `off` to stop announcing `signage.local` |
| `MDNS_NAME`      | `signage`      | Announce under a different `<name>.local` |
| `VIDEO_CODEC`    | `h264`         | `vp9` gives smaller files, but only for Chrome/Edge/Firefox screens (not iPhones) |
| `VIDEO_MAX_SIZE` | `1920`         | Longest video side in pixels. Use `3840` for 4K screens |
| `DECK_WIDTH`     | `1920`         | Pixel width of rendered slides |
| `MAX_UPLOAD_MB`  | `2048`         | Per-file upload limit |

## Managed roll-out (Group Policy / Intune)

**Install add-on → Managed roll-out** in the console shows the extension ID
and update URL. Add `"<id>;<update URL>"` to Chrome's or Edge's
`ExtensionInstallForcelist` policy. The browsers then install the signed CRX
and keep it updated with no clicks.

On Windows, this policy only works on PCs that are domain-joined, Intune/MDM
managed, or enrolled in the browser's cloud management. Set `PUBLIC_URL`, so
the update URL doesn't depend on mDNS.

## Development

```bash
npm run dev     # restart on change
npm test        # unit + integration tests (crypto protocol driven through WebCrypto)
```

```
server/
  app.js         REST API, uploads, add-on downloads, static UIs
  realtime.js    WebSocket hub: device auth, pairing, signed messages, sessions, screenshots
  crypto.js      server keys, wrapping, chunk encryption, CRX3 packaging
  network.js     mDNS announcer and the list of addresses screens should try
  schedule.js    which playlist a screen shows right now (own + group rules)
  manifest.js    playlist → items; plain URLs (previews) or encrypted refs (devices)
  extension.js   builds the add-on (Chrome/Edge, Firefox, CRX, screen-PC installer)
  convert.js     PDF/PowerPoint → slides, video → streamable MP4
  store.js       JSON-file datastore
player/          the player: runs in the add-on and in preview links
extension/       add-on background (window management, watchdog, keep-awake, updates)
admin/           admin console (vanilla JS, no build step)
windows/         server auto-start and screen-PC setup/update scripts
```

After changing anything in `player/` or `extension/`, bump `ADDON_VERSION` in
`server/extension.js`. Screens with the updater then pick up the change within
15 minutes.

## Roadmap

- Firefox: signed builds and auto-update.
- Multiple admin users with roles.
- Move from the JSON store to SQLite or Postgres for large fleets.
