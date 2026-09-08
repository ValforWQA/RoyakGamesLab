# RoyakGamesLab Launcher v5

Version 1.3.0. The launcher stays modern; SWF games open in a separate isolated legacy Electron 11 host. Run `SETUP.cmd`, place your compatible `pepflashplayer.dll` in `runtime\legacy-flash\`, then run `RUN.cmd`. The SWF comes directly from each server's `play.url`.

---

# RoyakGamesLab Launcher v3

This version uses a **server API index** instead of hardcoding complete server definitions in the launcher.

## 1. The launcher only starts from one URL

`launcher-config.json`:

```json
"serversManifest": "https://file.royakgames.world/servers.json"
```

That file does not need to contain the server details. It can simply contain API links:

```json
{
  "servers": [
    { "api": "https://file.royakgames.world/servers/adventurevanilla.json", "order": 1 },
    { "api": "https://another-domain.example/server-api.json", "order": 2 }
  ]
}
```

Add/remove API links and the launcher discovers the servers dynamically. No launcher rebuild is required.

## 2. Every server owns its launcher data

Example per-server endpoint:

```json
{
  "id": "adventurevanilla",
  "name": "AdventureVanilla",
  "online": 1,
  "players": 247,
  "maxPlayers": 1000,
  "region": "US East",
  "description": "AdventureVanilla is a custom MMORPG experience.",
  "background": "https://file.royakgames.world/launcher/adventurevanilla/background.jpg",
  "logo": "https://file.royakgames.world/launcher/adventurevanilla/logo.png",
  "ogImage": "https://file.royakgames.world/launcher/adventurevanilla/icon.png",
  "website": "https://adventurevanilla.royakgames.world/",
  "host": "game.adventurevanilla.royakgames.world",
  "port": 5588,
  "play": {
    "type": "swf",
    "url": "https://file.royakgames.world/game/Game.swf"
  }
}
```

`online` states:

- `0` = offline, grey and disabled
- `1` = online, selectable/playable
- `2` = maintenance, maintenance state and disabled

## Play types

### Flash/SWF

```json
"play": { "type": "swf", "url": "https://file.royakgames.world/game/Game.swf" }
```

The launcher starts the configured local Flash projector and passes that SWF URL to it.

### Website/browser game

```json
"play": { "type": "web", "url": "https://game.example.com/play" }
```

### Modern client

```json
"play": { "type": "modern", "args": ["--server=artix"] }
```

For security, remote JSON can only select supported play modes. It cannot provide an arbitrary local executable path. Remote play URLs must match an origin in `allowedPlayOrigins` in `launcher-config.json`.

## Dynamic UI

Selecting a server changes the launcher hero using that API's:

- `background`
- `logo`
- `description`
- `ogImage`
- `players` / `maxPlayers`
- online/maintenance state
- play URL/type

The API list and server APIs are re-read on the configured refresh interval.


## v4 launcher shell

The v4 UI removes the old navigation/sidebar entirely.

The left rail now contains only:
- launcher logo
- server icons loaded from each server API
- Settings gear at the bottom
- launcher version under Settings

Settings opens a bottom-left popup:
- Reload Launcher
- Website
- Discord
- Admin Panel
- Clear Cache
- Hide Launcher

Website and Admin Panel still render inside Electron's modern Chromium WebContentsView.
Discord opens externally.

Each server API can now also provide:

```json
{
  "website": "https://example.com/",
  "discord": "https://discord.com/invite/example",
  "admin": "https://example.com/panel"
}
```

Server state behavior remains:
- `online: 0` = Offline, grey and disabled
- `online: 1` = Online and playable
- `online: 2` = Maintenance, amber and disabled


## RoyakGamesLab branding

The launcher platform is now branded as **RoyakGamesLab**.

- `assets/royakgameslab-logo.png` — supplied RG dragon platform logo
- `assets/royakgameslab.ico` — generated Windows multi-size icon
- The top-left rail uses the RoyakGamesLab logo.
- Individual server/game icons still come from each server API `ogImage`.
- Selected server branding, background, logo, description, status, players, and play configuration remain server-controlled.


## v2 rail + DevTools changes

- Left rail widened to 82px.
- Server/game icons enlarged to 52x52px.
- RoyakGamesLab platform logo enlarged to 56x56px.
- Online/offline/maintenance status dots enlarged to 9px.
- Settings button enlarged and kept directly above the launcher version.
- Standard DevTools shortcuts are blocked (`F12`, `Ctrl+Shift+I`, `Ctrl+Shift+J`, `Ctrl+Shift+C`, and macOS equivalents).
- Default context menus are suppressed so Inspect Element is unavailable.
- The only launcher DevTools toggle is the hidden chord:

  **Right Ctrl + Right Shift + A + S + W**

  For the most reliable detection, hold **Right Ctrl + Right Shift**, then press/hold **A + S + W**. Repeating the chord closes DevTools.
- The same DevTools guard is installed on remote Website/Admin WebContentsViews.


## v1.4.0 - Per-game legacy window identity

When a server launches a SWF, RoyakGamesLab now passes the selected server's `name` and `ogImage` to the separate legacy Flash host. The legacy game window uses the actual game name for its title and taskbar/window label, and downloads `ogImage` for the game-window icon. If `ogImage` is missing, `logo` is used as a fallback. The server JSON remains the single source of game identity.

## v7 bundled Flash plugin selection
The Flash plugins supplied by the project owner are bundled under `runtime/flash` and selected automatically before the legacy host starts Flash:
- Windows ia32 -> `runtime/flash/windows/x86/pepflashplayer.dll`
- Windows x64 -> `runtime/flash/windows/x64/pepflashplayer.dll`
- Linux x64 -> `runtime/flash/linux/x64/libpepflashplayer.so`
- macOS x64 -> `runtime/flash/mac/x64/PepperFlashPlayer`

The supplied archive does not contain Linux x86 or macOS arm64 plugins, so v7 intentionally reports those architectures as unsupported rather than silently loading the wrong binary.

## v1.6.0 / v8 UI + Splash + Discord Rich Presence

This build adds three launcher upgrades:

- A new larger cinematic PLAY button with hover sweep, glow, launch state, and disabled/offline state.
- A dedicated RoyakGamesLab startup splash. The splash is a separate frameless window, animates the RG logo with an original blue comet/arc reveal, fades out, closes, and only then shows the main launcher window.
- Discord Rich Presence support through `discord-rpc`. Presence changes when a server is selected and switches to `Playing <game name>` after PLAY succeeds.

### Discord RPC configuration

Create a Discord application for RoyakGamesLab in the Discord Developer Portal, copy its Application ID, and put it in `launcher-config.json`:

```json
"discordRpc": {
  "enabled": true,
  "clientId": "YOUR_DISCORD_APPLICATION_ID",
  "largeImageKey": "royakgameslab",
  "largeImageText": "RoyakGamesLab",
  "showPlayerCount": true
}
```

For the large Rich Presence image, upload the RG/game artwork as an asset in that Discord application's Rich Presence assets and use its asset key in `largeImageKey`. Discord's classic RPC does not take an arbitrary `ogImage` HTTP URL as the large-image asset. The launcher still uses the selected server's actual `name`, region/player count, Website and Discord links in the activity.

`SETUP.cmd` installs the new `discord-rpc` dependency automatically along with the rest of the launcher dependencies.


## v1.7.0 UI / server JSON additions

Per-server JSON may now include a two-letter `countryCode` and a `ui` object. The launcher renders the country flag beside the region, keeps the live player count green, and applies each server's button colors/text without rebuilding the launcher.

```json
{
  "countryCode": "US",
  "region": "US East",
  "ui": {
    "playButtonColor": "#2f80ed",
    "playButtonHoverColor": "#4593ff",
    "playButtonTextColor": "#ffffff",
    "playButtonText": "PLAY NOW",
    "playButtonSubText": "LAUNCH GAME",
    "discordButtonColor": "#5865F2",
    "discordButtonTextColor": "#ffffff",
    "discordButtonText": "JOIN DISCORD",
    "accentColor": "#2f80ed"
  }
}
```

The settings popup is now a centered modal. Discord Presence has a persistent red OFF / green ON switch. A successful game start changes the PLAY control to a green **SUCCESSFULLY LAUNCHED** state; launch failures glow red and display the returned runtime error.

The main launcher now also detects the bundled Flash plugin by the current system before launching the legacy host: Windows x86/x64, Linux x64, and Intel macOS x64 use the plugin files under `runtime/flash/`.

## v1.8.0 additions

- Custom RG rail hover cards replace native Chromium title tooltips.
- Hover cards show game name, server status, country flag, region, player count and measured TCP latency.
- Discord Rich Presence follows the most recently launched game that is still running and falls back to the previous running game when another closes.
- Settings modal no longer contains Website / Discord / Admin links.
- Added green/red switches for Discord Presence, Hide Launcher on Play, Restore After Game Closes and Multiple Game Instances.
- Game process tracking restores the launcher when the last tracked game closes (when enabled).
- Launch flow now progresses through PREPARING, STARTING RUNTIME, LOADING GAME and SUCCESSFULLY LAUNCHED.
- Launch failures expose an in-launcher diagnostics modal.
- Per-game JSON supports `maintenanceMessage`, `discordRpc.asset`, and additional player/status theme colors.


## v1.8.1 RPC refresh

Discord Rich Presence now refreshes the active game's live player count from its server API on the launcher refresh interval. Region text is no longer shown in RPC. The legacy SWF host also supports the hidden Right Ctrl + Right Shift + A + S + W DevTools shortcut.


## v1.8.2
- Legacy SWF window now opens with a true 960x550 Flash player content area, matching the classic AQW player dimensions.
- Game host remains resizable, maximizable, and fullscreen-capable; F11 toggles fullscreen.
- Flash embed uses classic player params: exactfit, allowFullScreen, allowScriptAccess, no menu, and web language FlashVars.
- Server rail hover now shows only the server name.
- Country flags use the server ISO countryCode as a real flag image instead of relying on OS emoji rendering.


## v13 SWF agent
The legacy Flash host identifies itself as `RoyakGamesLabAgent/1.0` for SWF and asset requests.

## Auto updates
RoyakGamesLab checks for launcher updates on the splash screen before opening the main window. The update feed is configured in `launcher-config.json` under `autoUpdate`.

For the generic update feed, build a new version with `BUILD.cmd`, then upload the generated installer, `.blockmap`, and `latest.yml` from `dist/` to the configured update URL. Bump the version in `package.json` for every release.

Startup status is shown as `Checking for updates...`, then either `Update Ready!` while the update downloads/installs, or `You're up to date!` before the launcher opens. If the update service is unavailable, RoyakGamesLab continues into the launcher instead of blocking startup.

## Flash runtime files kept
The duplicate Flash plugin copies were removed. The runtime now keeps only the platform plugins used by the launcher:

- `runtime/flash/windows/x86/pepflashplayer.dll`
- `runtime/flash/windows/x64/pepflashplayer.dll`
- `runtime/flash/mac/x64/PepperFlashPlayer`
- `runtime/flash/linux/x64/libpepflashplayer.so`

The isolated `runtime/legacy-flash/app` host remains because it is required to run SWF games.


## GitHub auto-updates

This source is configured for the public GitHub repository `ValforWQA/RoyakGamesLab`. Installed builds check GitHub Releases during the splash screen. The status sequence is `Checking for updates...`, then `You're up to date!` when no newer release exists, or `Update Ready!` while a newer release is downloaded and installed.

For a new release, bump `version` in `package.json`, run `BUILD.cmd`, create a GitHub Release with a matching tag such as `v1.9.1`, and upload the generated installer, `.blockmap`, and `latest.yml` from `dist`. You can also set `GH_TOKEN` and run `PUBLISH_GITHUB.cmd` to let electron-builder publish the release assets.

The installed application is packaged into `app.asar`. On Windows the native `resources\runtime`, `resources\client`, and `app.asar.unpacked` folders are marked Hidden/System by the installer. Native Flash/Electron binaries cannot be completely sealed because Windows must load them from disk; this is packaging/obscuring, not copy-proof DRM.
#   R o y a k G a m e s L a b  
 