const { app, BrowserWindow, WebContentsView, ipcMain, net, shell, Menu, nativeImage } = require('electron');
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (error) {
  console.warn('[Updater] electron-updater is unavailable:', error.message);
}
// Keep Chromium GPU acceleration enabled; actual adapter selection is controlled by the OS.
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const nodeNet = require('net');
const {startSocketBridge} = require('./royak-socket-bridge');

const devBase = path.resolve(__dirname, '..');
const baseDir = app.isPackaged ? process.resourcesPath : devBase;

function firstExistingPath(...candidates) {
  for (const candidate of candidates) {
    try { if (candidate && fs.existsSync(candidate)) return candidate; } catch {}
  }
  return candidates.find(Boolean) || '';
}

function getConfigPath() {
  // In packaged builds launcher-config.json lives inside app.asar so it is not
  // exposed as a loose file under the installation's resources directory.
  return firstExistingPath(
    path.join(app.getAppPath(), 'launcher-config.json'),
    app.isPackaged ? path.join(process.resourcesPath, 'launcher-config.json') : null,
    path.join(devBase, 'launcher-config.json')
  );
}

let win = null;
let webView = null;
let currentRemoteUrl = null;
let splashWin = null;
let discordRpcClient = null;
let discordRpcReady = false;
let discordRpcServer = null;
let discordRpcMode = 'browsing';
let discordRpcUserEnabled = null;
let discordRpcConnecting = false;
const discordRpcStart = new Date();
const runningGames = new Map();
let lastBrowsedServer = null;
let runningGameRefreshTimer = null;


// DevTools are blocked from normal shortcuts and may only be toggled with
// Right Ctrl + Right Shift + A + S + W.
const devToolState = new WeakMap();
const DEVTOOLS_COMBO = new Set(['ControlRight', 'ShiftRight', 'KeyA', 'KeyS', 'KeyW']);

function installDevToolsGuard(contents) {
  if (!contents || devToolState.has(contents)) return;

  const state = {
    pressed: new Set(),
    secretAuthorized: false,
    comboLatched: false,
    comboArmed: true
  };
  devToolState.set(contents, state);

  contents.on('before-input-event', (event, input) => {
    const code = input.code || '';
    const type = input.type || '';

    // Block normal Chromium/Electron DevTools accelerators.
    const key = String(input.key || '').toLowerCase();
    const standardDevTools =
      key === 'f12' ||
      ((input.control || input.meta) && input.shift && ['i', 'j', 'c'].includes(key)) ||
      (input.meta && input.alt && key === 'i');

    if (standardDevTools) {
      event.preventDefault();
      return;
    }

    if (type === 'keyDown' || type === 'rawKeyDown') state.pressed.add(code);
    if (type === 'keyUp') {
      state.pressed.delete(code);

      // Do not re-arm the secret chord until every key in the chord has been
      // released. This prevents DevTools from immediately reopening after the
      // user closes it while one or more chord keys are still physically held.
      if ([...DEVTOOLS_COMBO].every(c => !state.pressed.has(c))) {
        state.comboLatched = false;
        state.comboArmed = true;
      }
      return;
    }

    const hasCombo = [...DEVTOOLS_COMBO].every(c => state.pressed.has(c));
    const hasRightModifiers = state.pressed.has('ControlRight') && state.pressed.has('ShiftRight');

    // Once the two right-side modifiers are held, swallow A/S/W so the secret
    // chord is not typed into forms or remote admin pages.
    if (hasRightModifiers && ['KeyA', 'KeyS', 'KeyW'].includes(code)) {
      event.preventDefault();
    }

    if (hasCombo && !state.comboLatched && state.comboArmed) {
      event.preventDefault();
      state.comboLatched = true;
      state.comboArmed = false;

      if (contents.isDevToolsOpened()) {
        contents.closeDevTools();
        state.secretAuthorized = false;
      } else {
        state.secretAuthorized = true;
        contents.openDevTools({ mode: 'detach', activate: true });
      }
    }
  });

  contents.on('devtools-opened', () => {
    if (!state.secretAuthorized) contents.closeDevTools();
  });

  contents.on('devtools-closed', () => {
    state.secretAuthorized = false;
  });

  // No inspect-element context menu or other default context menu surfaces.
  contents.on('context-menu', (event) => event.preventDefault());
}

function readConfig() {
  const configPath = getConfigPath();
  if (!configPath || !fs.existsSync(configPath)) {
    throw new Error(`launcher-config.json was not found. Checked resources and app package paths.`);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function preferencePath() {
  return path.join(app.getPath('userData'), 'launcher-preferences.json');
}
function loadPreferences() {
  try { return JSON.parse(fs.readFileSync(preferencePath(), 'utf8')) || {}; } catch { return {}; }
}
function savePreferences(next) {
  fs.mkdirSync(path.dirname(preferencePath()), {recursive:true});
  fs.writeFileSync(preferencePath(), JSON.stringify(next, null, 2));
}
function getPreference(key, fallback = false) {
  const prefs = loadPreferences();
  return typeof prefs[key] === 'boolean' ? prefs[key] : fallback;
}
function setPreference(key, value) {
  const allowed = new Set(['discordRpcEnabled','hideLauncherOnPlay','restoreLauncherOnGameClose','allowMultipleInstances']);
  if (!allowed.has(key)) throw new Error('Unsupported preference.');
  const prefs = loadPreferences();
  prefs[key] = !!value;
  savePreferences(prefs);
  if (key === 'discordRpcEnabled') discordRpcUserEnabled = !!value;
  return prefs;
}
// Per-game runtime preferences. Targets are advisory: Ruffle may follow SWF timing.
const PERF_PROFILES = {maximum:{fps:120,quality:'medium'},balanced:{fps:60,quality:'high'},battery:{fps:30,quality:'low'}};
function cleanPerformance(value) {
  const p = value && typeof value === 'object' ? value : {};
  const profile = ['maximum','balanced','battery','custom'].includes(p.profile) ? p.profile : 'balanced';
  const preset = PERF_PROFILES[profile] || PERF_PROFILES.balanced;
  return {profile, fps:Math.max(10,Math.min(120,Math.round(Number(p.fps)||preset.fps))),
    quality:['low','medium','high','best'].includes(p.quality)?p.quality:preset.quality,
    showFps:!!p.showFps};
}
function getPerformance(gameId) {
  const prefs=loadPreferences();
  const saved=prefs.gamePerformance && prefs.gamePerformance[String(gameId)];
  return cleanPerformance(saved || prefs.defaultPerformance);
}
function savePerformance(gameId, value) {
  const prefs=loadPreferences();
  const key=String(gameId||'default').slice(0,128);
  const perf=cleanPerformance(value);
  if(key==='default') prefs.defaultPerformance=perf;
  else {prefs.gamePerformance=prefs.gamePerformance||{};prefs.gamePerformance[key]=perf;}
  savePreferences(prefs);
  for(const game of (globalThis.__ruffleWindows||new Map()).values()) {
    if(game.isDestroyed() || (key!=='default' && game.royakGameId!==key)) continue;
    const current=getPerformance(game.royakGameId);
    game.webContents.executeJavaScript(`window.applyRoyakPerformance && window.applyRoyakPerformance(${JSON.stringify(current)})`).catch(()=>{});
  }
  return perf;
}
function loadRpcPreference() {
  if (discordRpcUserEnabled !== null) return discordRpcUserEnabled;
  const prefs = loadPreferences();
  if (typeof prefs.discordRpcEnabled === 'boolean') discordRpcUserEnabled = prefs.discordRpcEnabled;
  return discordRpcUserEnabled;
}
function saveRpcPreference(enabled) {
  setPreference('discordRpcEnabled', !!enabled);
}
function getDiscordRpcConfig() {
  const cfg = readConfig().discordRpc || {};
  const user = loadRpcPreference();
  return {
    enabled: cfg.enabled !== false && user !== false,
    configuredEnabled: cfg.enabled !== false,
    clientId: String(cfg.clientId || '').trim(),
    largeImageKey: String(cfg.largeImageKey || '').trim(),
    largeImageText: String(cfg.largeImageText || 'RoyakGamesLab').trim(),
    showPlayerCount: cfg.showPlayerCount !== false
  };
}

function buildDiscordActivity(server, mode = 'browsing') {
  const cfg = getDiscordRpcConfig();
  const gameName = String(server?.name || 'RoyakGamesLab');
  const onlineState = normalizeOnlineState(server?.onlineState ?? server?.online, 1);
  const players = Number(server?.players || 0);
  const playerText = cfg.showPlayerCount && onlineState === 1 && Number.isFinite(players)
    ? `${players.toLocaleString()} online`
    : (onlineState === 2 ? 'Maintenance' : onlineState === 0 ? 'Offline' : '');
  const activity = {
    details: mode === 'playing' ? `Playing ${gameName}` : `Browsing ${gameName}`,
    state: playerText || 'RoyakGamesLab',
    startTimestamp: discordRpcStart,
    instance: false
  };
  const rpc = server?.discordRpc || server?.rpc || server?.raw?.discordRpc || server?.raw?.rpc || {};
  const assetKey = String(rpc.asset || rpc.largeImageKey || cfg.largeImageKey || '').trim();
  if (assetKey) {
    activity.largeImageKey = assetKey;
    activity.largeImageText = String(rpc.assetText || rpc.largeImageText || gameName || cfg.largeImageText);
  }
  return activity;
}

async function applyDiscordPresence(server = discordRpcServer, mode = discordRpcMode) {
  const rpcCfg = getDiscordRpcConfig();
  if (!rpcCfg.enabled) return false;
  discordRpcServer = server || discordRpcServer;
  discordRpcMode = mode || discordRpcMode;
  if (mode === 'browsing' && server) lastBrowsedServer = server;
  if (!discordRpcReady || !discordRpcClient || !discordRpcServer) return false;
  try {
    await discordRpcClient.setActivity(buildDiscordActivity(discordRpcServer, discordRpcMode));
    return true;
  } catch (error) {
    console.warn('[DiscordRPC] setActivity failed:', error.message);
    return false;
  }
}

function mostRecentRunningGame() {
  return [...runningGames.values()].sort((a,b) => b.startedAt - a.startedAt)[0] || null;
}
async function refreshDiscordForRunningGames() {
  const active = mostRecentRunningGame();
  if (active) return applyDiscordPresence(active.server, 'playing');
  if (lastBrowsedServer) return applyDiscordPresence(lastBrowsedServer, 'browsing');
  return false;
}
function syncRunningGameServers(servers = []) {
  if (!Array.isArray(servers) || !runningGames.size) return;
  const byId = new Map(servers.map(server => [String(server.id), server]));
  for (const game of runningGames.values()) {
    const fresh = byId.get(String(game.server?.id));
    if (fresh) game.server = fresh;
  }
}

async function refreshRunningGameData() {
  if (!runningGames.size) return;
  try {
    const data = await getServersWithCounts();
    if (!data?.ok) return;
    syncRunningGameServers(data.servers);
    await refreshDiscordForRunningGames();
  } catch (error) {
    console.warn('[DiscordRPC] Live player refresh failed:', error.message);
  }
}

function startRunningGameRefresh() {
  if (runningGameRefreshTimer || !runningGames.size) return;
  const interval = Math.max(5000, Number(readConfig().refreshServersMs || 15000));
  runningGameRefreshTimer = setInterval(() => refreshRunningGameData().catch(() => {}), interval);
}

function stopRunningGameRefresh() {
  if (!runningGameRefreshTimer) return;
  clearInterval(runningGameRefreshTimer);
  runningGameRefreshTimer = null;
}
function sendGameStatusChanged() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('game:status-changed', {
    running: [...runningGames.values()].map(g => ({pid:g.pid, serverId:g.server.id, name:g.server.name, startedAt:g.startedAt})),
    active: mostRecentRunningGame()?.server?.id || null
  });
}
function teardownDiscordRpc() {
  discordRpcReady = false;
  discordRpcConnecting = false;
  if (discordRpcClient) {
    try { discordRpcClient.clearActivity?.(); } catch {}
    try { discordRpcClient.destroy(); } catch {}
  }
  discordRpcClient = null;
}
function setupDiscordRpc() {
  const cfg = getDiscordRpcConfig();
  if (!cfg.enabled || !cfg.clientId || discordRpcClient || discordRpcConnecting) {
    if (!cfg.enabled || !cfg.clientId) console.log('[DiscordRPC] Disabled or clientId not configured.');
    return;
  }
  try {
    discordRpcConnecting = true;
    const RPC = require('discord-rpc');
    discordRpcClient = new RPC.Client({transport:'ipc'});
    discordRpcClient.on('ready', async () => {
      discordRpcConnecting = false;
      discordRpcReady = true;
      console.log('[DiscordRPC] Connected.');
      await applyDiscordPresence();
    });
    discordRpcClient.on('disconnected', () => { discordRpcReady = false; discordRpcConnecting = false; });
    discordRpcClient.login({clientId:cfg.clientId}).catch(error => {
      console.warn('[DiscordRPC] Login failed:', error.message);
      discordRpcReady = false;
      discordRpcConnecting = false;
      try { discordRpcClient?.destroy(); } catch {}
      discordRpcClient = null;
    });
  } catch (error) {
    discordRpcConnecting = false;
    console.warn('[DiscordRPC] Could not initialize:', error.message);
  }
}
async function setDiscordRpcEnabled(enabled) {
  const baseCfg = readConfig().discordRpc || {};
  if (baseCfg.enabled === false && enabled) return {ok:false, enabled:false, error:'Discord Presence is disabled by launcher configuration.'};
  saveRpcPreference(!!enabled);
  if (!enabled) {
    teardownDiscordRpc();
    return {ok:true, enabled:false};
  }
  setupDiscordRpc();
  return {ok:true, enabled:true, configured:!!String(baseCfg.clientId || '').trim()};
}
function resolveResource(rel) {
  const packagedResource = app.isPackaged ? path.resolve(process.resourcesPath, rel) : null;
  const appResource = path.resolve(app.getAppPath(), rel);
  const devResource = path.resolve(devBase, rel);
  return firstExistingPath(packagedResource, appResource, devResource);
}
function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}
function normalizeOrigin(url) {
  try { return new URL(url).origin; } catch { return null; }
}
function isAllowedRemote(url) {
  const cfg = readConfig();
  const origin = normalizeOrigin(url);
  return !!origin && (cfg.allowedRemoteOrigins || []).includes(origin);
}
async function fetchJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await net.fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'Accept': 'application/json', 'Cache-Control': 'no-cache' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const data = safeJson(text);
    if (data === null) throw new Error('Invalid JSON response');
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeOnlineState(value, fallback = 1) {
  if (value === true) return 1;
  if (value === false) return 0;
  const n = Number(value);
  if (Number.isFinite(n) && [0, 1, 2].includes(n)) return n;
  const text = String(value ?? '').trim().toLowerCase();
  if (['offline','off','down','disabled'].includes(text)) return 0;
  if (['maintenance','maint','updating'].includes(text)) return 2;
  if (['online','on','up','running','ok','available'].includes(text)) return 1;
  return fallback;
}

function normalizeServerIndex(payload) {
  const list = Array.isArray(payload) ? payload :
    Array.isArray(payload?.servers) ? payload.servers :
    Array.isArray(payload?.data) ? payload.data : [];

  return list.map((s, i) => ({
    apiUrl: s.api ?? s.api_url ?? s.apiUrl ?? s.server_api ?? s.serverApi ?? null,
    inline: s,
    order: Number(s.order ?? i) || i
  })).filter(x => x.apiUrl || x.inline);
}

function normalizeServerDefinition(p, fallback = {}, i = 0) {
  const s = {...fallback, ...(p || {})};
  const onlineState = normalizeOnlineState(s.online ?? s.status, 1);
  const players = Number(
    s.players ?? s.playerCount ?? s.player_count ?? s.onlinePlayers ??
    s.online_players ?? s.count ?? s.users ?? s.online_count
  );
  const play = s.play && typeof s.play === 'object' ? s.play : {};
  return {
    id: String(s.id ?? s.serverId ?? s.slug ?? s.name ?? `server-${i+1}`),
    name: String(s.name ?? s.sName ?? s.title ?? `Server ${i+1}`),
    description: String(s.description ?? s.desc ?? ''),
    background: s.background ?? s.backgroundImage ?? s.background_image ?? s.hero ?? null,
    logo: s.logo ?? s.logoImage ?? s.logo_image ?? null,
    ogImage: s.ogImage ?? s.og_image ?? s.thumbnail ?? s.icon ?? null,
    website: s.website ?? s.websiteUrl ?? s.website_url ?? null,
    host: s.host ?? s.ip ?? s.address ?? null,
    port: Number(s.port ?? 0) || null,
    region: s.region ?? null,
    countryCode: String(s.countryCode ?? s.country_code ?? s.country ?? '').trim().toUpperCase().slice(0,2) || null,
    ui: (() => {
      const ui = (s.ui && typeof s.ui === 'object') ? s.ui : ((s.theme && typeof s.theme === 'object') ? s.theme : {});
      return {
        playButtonColor: ui.playButtonColor ?? ui.play_button_color ?? s.playButtonColor ?? s.play_button_color ?? null,
        playButtonHoverColor: ui.playButtonHoverColor ?? ui.play_button_hover_color ?? s.playButtonHoverColor ?? s.play_button_hover_color ?? null,
        playButtonTextColor: ui.playButtonTextColor ?? ui.play_button_text_color ?? s.playButtonTextColor ?? s.play_button_text_color ?? null,
        playButtonText: ui.playButtonText ?? ui.play_button_text ?? s.playButtonText ?? s.play_button_text ?? null,
        playButtonSubText: ui.playButtonSubText ?? ui.play_button_sub_text ?? s.playButtonSubText ?? s.play_button_sub_text ?? null,
        discordButtonColor: ui.discordButtonColor ?? ui.discord_button_color ?? s.discordButtonColor ?? s.discord_button_color ?? null,
        discordButtonTextColor: ui.discordButtonTextColor ?? ui.discord_button_text_color ?? s.discordButtonTextColor ?? s.discord_button_text_color ?? null,
        discordButtonText: ui.discordButtonText ?? ui.discord_button_text ?? s.discordButtonText ?? s.discord_button_text ?? null,
        accentColor: ui.accentColor ?? ui.accent_color ?? s.accentColor ?? s.accent_color ?? null,
        playerCountColor: ui.playerCountColor ?? ui.player_count_color ?? null,
        statusOnlineColor: ui.statusOnlineColor ?? ui.status_online_color ?? null,
        statusMaintenanceColor: ui.statusMaintenanceColor ?? ui.status_maintenance_color ?? null,
        statusOfflineColor: ui.statusOfflineColor ?? ui.status_offline_color ?? null
      };
    })(),
    maintenanceMessage: String(s.maintenanceMessage ?? s.maintenance_message ?? ''),
    discordRpc: (s.discordRpc && typeof s.discordRpc === 'object') ? s.discordRpc : ((s.rpc && typeof s.rpc === 'object') ? s.rpc : {}),
    onlineState,
    online: onlineState === 1,
    maintenance: onlineState === 2,
    players: Number.isFinite(players) ? Math.max(0, players) : 0,
    maxPlayers: Number(s.maxPlayers ?? s.max_players ?? s.max ?? 0) || null,
    play: {
      type: String(play.type ?? s.playType ?? s.play_type ?? 'swf').toLowerCase(),
      url: play.url ?? play.swf ?? play.swfUrl ?? play.swf_url ?? s.playUrl ?? s.play_url ?? s.swf ?? s.swfUrl ?? null,
      args: Array.isArray(play.args) ? play.args : [],
      loaderUrl: play.loaderUrl ?? play.loader_url ?? s.loaderUrl ?? s.loader_url ?? null,
      baseUrl: play.baseUrl ?? play.base_url ?? null,
      pageUrl: play.pageUrl ?? play.page_url ?? null,
      embedMode: String(play.embedMode ?? play.embed_mode ?? '').trim().toLowerCase(),
      playerSelector: String(play.playerSelector ?? play.player_selector ?? '#flashContent'),
      flashVars: (play.flashVars && typeof play.flashVars === 'object') ? play.flashVars : {},
      width: Number(play.width ?? 960) || 960,
      height: Number(play.height ?? 550) || 550,
      scale: String(play.scale ?? 'exactfit'),
      allowFullScreen: play.allowFullScreen !== false
    },
    raw: s
  };
}

async function getServersWithCounts() {
  const cfg = readConfig();
  let feed;
  try {
    feed = await fetchJson(cfg.serversManifest);
  } catch (e) {
    return { ok:false, error:e.message, url:cfg.serversManifest, servers:[] };
  }

  const index = normalizeServerIndex(feed);
  const servers = await Promise.all(index.map(async (entry, i) => {
    if (!entry.apiUrl) return normalizeServerDefinition(entry.inline, {}, i);
    try {
      const remote = await fetchJson(entry.apiUrl, 7000);
      return {...normalizeServerDefinition(remote, entry.inline, i), apiUrl:entry.apiUrl, apiAvailable:true};
    } catch (e) {
      const fallback = normalizeServerDefinition(entry.inline, {}, i);
      return {...fallback, apiUrl:entry.apiUrl, apiAvailable:false, apiError:e.message, onlineState:0, online:false, maintenance:false};
    }
  }));

  servers.sort((a,b)=>(Number(a.raw?.order??0)-Number(b.raw?.order??0)) || a.name.localeCompare(b.name));
  return {
    ok:true,
    url:cfg.serversManifest,
    totalPlayers: servers.reduce((sum,s)=>sum+(s.onlineState===1 ? (s.players||0) : 0),0),
    servers
  };
}

async function getLauncherManifest() {
  const cfg=readConfig();
  try {
    const remote=await fetchJson(cfg.launcherManifest);
    return {ok:true,manifest:remote};
  } catch (e) {
    return {ok:false,error:e.message,manifest:{navigation:cfg.fallbackNavigation}};
  }
}

function getLegacyFlashHostCandidates() {
  // Flash games are intentionally isolated from the modern launcher runtime.
  // RoyakGamesLab only permits the pinned Electron 11.5.0 host here so a SWF
  // can never silently fall back to the main Electron/Chromium process or to
  // some other legacy executable left on disk.
  const legacy = readConfig().game.legacy || {};
  const pinned = String(
    legacy.hostExecutable ||
    'runtime/legacy-flash/app/node_modules/electron/dist/electron.exe'
  ).trim();

  return pinned
    ? [{ relative: pinned, absolute: resolveResource(pinned) }]
    : [];
}

const REQUIRED_FLASH_ELECTRON_VERSION = '11.5.0';

function getLegacyElectronVersion(executable) {
  if (!executable) return '';
  try {
    const result = spawnSync(executable, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    });
    const raw = String(result.stdout || result.stderr || '').trim();
    const match = raw.match(/v?(\d+\.\d+\.\d+)/i);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function getWindowsArchitecture() {
  if (process.platform !== 'win32') return process.arch;

  const wow64 = String(process.env.PROCESSOR_ARCHITEW6432 || '').toLowerCase();
  const nativeArch = String(process.env.PROCESSOR_ARCHITECTURE || '').toLowerCase();

  if (wow64.includes('amd64') || wow64.includes('arm64') ||
      nativeArch.includes('amd64') || nativeArch.includes('arm64')) {
    return 'x64';
  }

  return 'x86';
}

function getBundledSystemFlashPluginRelative() {
  if (process.platform === 'win32') {
    return `runtime/flash/windows/${getWindowsArchitecture()}/pepflashplayer.dll`;
  }
  if (process.platform === 'linux') {
    if (process.arch !== 'x64') return null;
    return 'runtime/flash/linux/x64/libpepflashplayer.so';
  }
  if (process.platform === 'darwin') {
    if (process.arch !== 'x64') return null;
    return 'runtime/flash/mac/x64/PepperFlashPlayer';
  }
  return null;
}

function getLegacyFlashPluginCandidates() {
  // Deliberately strict: RoyakGamesLab only loads the bundled Flash runtime
  // selected for the current operating-system architecture. There are no
  // legacy plugin-directory or third-party fallback paths.
  const bundled = getBundledSystemFlashPluginRelative();
  if (!bundled) return [];
  return [{
    relative: bundled,
    absolute: resolveResource(bundled)
  }];
}

function detectLegacy() {
  const legacy = readConfig().game.legacy || {};
  const candidates = getLegacyFlashHostCandidates();
  const found = candidates.find(entry => {
    try { return fs.existsSync(entry.absolute) && fs.statSync(entry.absolute).isFile(); }
    catch { return false; }
  }) || null;

  const electronVersion = found ? getLegacyElectronVersion(found.absolute) : '';
  const electronVersionOk = electronVersion === REQUIRED_FLASH_ELECTRON_VERSION;

  const appRelative = legacy.hostAppPath || 'runtime/legacy-flash/app';
  const appAbsolute = resolveResource(appRelative);
  const pluginCandidates = getLegacyFlashPluginCandidates();
  const plugin = pluginCandidates.find(entry => {
    try { return fs.existsSync(entry.absolute) && fs.statSync(entry.absolute).isFile(); }
    catch { return false; }
  }) || null;
  return {
    detected: !!found && !!plugin && electronVersionOk,
    hostDetected: !!found,
    pluginDetected: !!plugin,
    electronVersion,
    electronVersionOk,
    requiredElectronVersion: REQUIRED_FLASH_ELECTRON_VERSION,
    candidate: found?.absolute || null,
    executable: found?.absolute || null,
    executableRelative: found?.relative || null,
    plugin: plugin?.absolute || null,
    pluginRelative: plugin?.relative || null,
    appPath: appAbsolute,
    appRelative,
    tried: candidates.map(entry => entry.absolute),
    pluginTried: pluginCandidates.map(entry => entry.absolute)
  };

}

function chooseEngine() {
  const cfg = readConfig();
  const legacy = detectLegacy();
  if (cfg.game.legacy?.enabled && cfg.game.legacy?.preferWhenDetected && legacy.detected)
    return {engine:'legacy-flash-plugin',legacy};
  if (cfg.game.modern?.enabled) return {engine:'modern',legacy};
  if (cfg.game.legacy?.enabled && legacy.detected) return {engine:'legacy-flash-plugin',legacy};
  return {engine:'none',legacy};
}

function spawnTracked(exe,args=[],cwd=null,server=null) {
  const child=spawn(exe,args,{cwd:cwd||path.dirname(exe),detached:true,stdio:'ignore',windowsHide:false});
  const pid = child.pid;
  if (server && pid) {
    runningGames.set(pid, {pid, child, server, startedAt:Date.now()});
    sendGameStatusChanged();
    refreshDiscordForRunningGames().catch(()=>{});
    startRunningGameRefresh();
    child.once('exit', () => {
      runningGames.delete(pid);
      if (runningGames.size === 0) stopRunningGameRefresh();
      sendGameStatusChanged();
      refreshDiscordForRunningGames().catch(()=>{});
      if (runningGames.size === 0 && getPreference('restoreLauncherOnGameClose', true) && win && !win.isDestroyed()) {
        win.show(); win.restore(); win.focus();
      }
    });
  }
  child.unref();
  return pid;
}

function makeLegacyFlashHostArgs(host, play, server = {}) {
  const legacy = readConfig().game.legacy || {};
  const args = [];
  const exeName = path.basename(host.executable || '').toLowerCase();
  if (exeName === 'electron.exe') {
    if (!fs.existsSync(host.appPath)) throw new Error(`Legacy Flash host app is missing: ${host.appPath}`);
    args.push(host.appPath);
  }
  if (host.plugin) args.push(`--flash-plugin=${host.plugin}`);
  args.push(`--swf=${play.url}`);
  args.push(`--game-id=${String(server.id || server.name || 'game')}`);
  args.push(`--game-name=${String(server.name || server.id || 'Game')}`);
  const gameIcon = server.ogImage || server.logo || '';
  if (gameIcon) args.push(`--game-icon=${String(gameIcon)}`);
  if (play.loaderUrl) args.push(`--loader=${play.loaderUrl}`);
  if (play.baseUrl) args.push(`--base-url=${String(play.baseUrl)}`);

  // Match the old RoyakGames browser for plain SWF games: it navigated the
  // plugin directly to the SWF instead of embedding it inside a local HTML
  // <object>. AdventureVanilla's API is a plain type+url definition, while
  // AQW supplies FlashVars/playerSelector and keeps using wrapper mode.
  let embedMode = String(play.embedMode || '').toLowerCase();
  if (!['direct', 'wrapper', 'page'].includes(embedMode)) {
    const hasFlashVars = play.flashVars && typeof play.flashVars === 'object' && Object.keys(play.flashVars).length > 0;
    const hasExplicitPlayer = !!(play.pageUrl || (play.playerSelector && play.playerSelector !== '#flashContent'));
    embedMode = (!hasFlashVars && !hasExplicitPlayer) ? 'direct' : 'wrapper';
  }
  if (play.pageUrl) embedMode = 'page';
  args.push(`--embed-mode=${embedMode}`);

  if (play.pageUrl) args.push(`--page-url=${String(play.pageUrl)}`);
  if (play.playerSelector) args.push(`--player-selector=${encodeURIComponent(String(play.playerSelector))}`);
  if (play.flashVars && typeof play.flashVars === 'object') {
    args.push(`--flash-vars=${encodeURIComponent(JSON.stringify(play.flashVars))}`);
  }
  args.push(`--game-width=${Number(play.width || 960)}`);
  args.push(`--game-height=${Number(play.height || 550)}`);
  args.push(`--scale=${String(play.scale || 'exactfit')}`);
  args.push(`--allow-fullscreen=${play.allowFullScreen === false ? '0' : '1'}`);
  for (const arg of (play.args || [])) args.push(String(arg));
  for (const arg of (legacy.hostArguments || [])) args.push(String(arg));
  return args;
}

// Use each game's own artwork for its Windows game window and taskbar.
// Only accept HTTPS images from configured game origins; never fetch arbitrary URLs.
async function resolveGameWindowIcon(server, cfg) {
  const fallback = resolveResource('assets/royakgameslab.ico');
  const candidate = server.icon || server.ogImage || server.logo;
  if (!candidate || typeof candidate !== 'string') return fallback;
  try {
    if (!/^https:\/\//i.test(candidate)) {
      const relative = candidate.replace(/^\/+/, '');
      if (!relative.includes('..') && !path.isAbsolute(relative)) {
        const local = resolveResource(relative);
        if (fs.existsSync(local)) return local;
      }
      return fallback;
    }
    const url = new URL(candidate);
    const allowed = [...(cfg.allowedPlayOrigins || []), ...(cfg.allowedRemoteOrigins || [])];
    if (!allowed.includes(url.origin)) return fallback;
    const response = await net.fetch(url.href, {redirect:'error'});
    if (!response.ok) return fallback;
    const mime = (response.headers.get('content-type') || '').toLowerCase();
    if (!/image\/(png|jpeg|jpg|webp|x-icon|vnd\.microsoft\.icon)/.test(mime)) return fallback;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 4 * 1024 * 1024) return fallback;
    const image = nativeImage.createFromBuffer(bytes);
    return image.isEmpty() ? fallback : image;
  } catch (error) {
    console.warn('[GameIcon] Unable to load artwork:', error.message);
    return fallback;
  }
}

async function launchServer(server) {
  if (!server || normalizeOnlineState(server.onlineState ?? server.online, 0)!==1)
    throw new Error('This server is not online.');

  const cfg=readConfig();
  const play=server.play || {};
  const type=String(play.type || 'swf').toLowerCase();
  // Game windows are independent: each launch creates a new player and socket bridge.
  // The launcher itself stays single-instance to avoid duplicate background services.

  if (type==='web' || type==='url' || type==='browser') {
    if (!/^https?:\/\//i.test(String(play.url || ''))) throw new Error('Server play URL must be http/https.');
    await shell.openExternal(play.url);
    return {ok:true,engine:'web',server:server.id};
  }

  if (type==='swf' || type==='flash' || type==='ruffle') {
    const swfUrl = new URL(String(play.url || ''));
    if (!['http:', 'https:'].includes(swfUrl.protocol)) throw new Error('SWF URL must be HTTP(S).');
    const allowed = (cfg.allowedPlayOrigins || []).includes(swfUrl.origin);
    if (!allowed) throw new Error('SWF origin is not allowed by launcher-config.json.');
    const gameName = String(server.name || server.id || 'Game');
    const gameId = String(server.id || 'game');
    const activeGame = [...(globalThis.__ruffleWindows||new Map()).values()].find(w=>!w.isDestroyed() && w.royakGameId===gameId);
    if (activeGame && !getPreference('allowMultipleInstances', false)) {
      if(activeGame.isMinimized()) activeGame.restore();
      activeGame.show(); activeGame.focus();
      return {ok:true,alreadyRunning:true,server:server.id};
    }
    const gameIcon = await resolveGameWindowIcon(server, cfg);
    const instanceId = `${String(server.id || 'game')}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    const gameWindow = new BrowserWindow({
      width: 1280, height: 800, minWidth: 640, minHeight: 480,
      title: gameName, icon: gameIcon, backgroundColor: '#080b12',
      autoHideMenuBar: true, show:false,
      webPreferences: {contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,
        backgroundThrottling:false}
    });
    gameWindow.royakGameId = gameId;
    // Keep the selected game's name even if the embedded player changes document.title.
    gameWindow.webContents.on('page-title-updated', event => { event.preventDefault(); gameWindow.setTitle(gameName); });
    // Diagnostics for SWF/AS3 initialization failures; no security checks are disabled.
    gameWindow.webContents.on('console-message', (event, ...legacyArgs) => {
      const detail = (event && typeof event === 'object' && 'message' in event) ? event : {message:legacyArgs[1], sourceId:legacyArgs[2], lineNumber:legacyArgs[3]};
      if (/Electron Security Warning/.test(detail.message || '')) return;
      console.log('[RoyakFlashEngine console]', detail.message || '', detail.sourceId || '', detail.lineNumber || '');
    });
    gameWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      console.error('[RoyakRuffle load failure]', {code, description, url, isMainFrame});
    });
    gameWindow.webContents.session.webRequest.onCompleted({urls:['https://adventurevanilla.royakgames.world/*']}, details => {
      if (details.statusCode >= 400) console.error('[RoyakRuffle HTTP error]', details.statusCode, details.url);
    });
    // Custom launcher identity. The bundled WASM implementation remains Ruffle.
    const baseUA = gameWindow.webContents.getUserAgent()
      .replace(/\s+RoyakRuffle\/[\d.]+/gi, '')
      .replace(/\s+RoyakFlashEngine\/[\d.]+/gi, '')
      .replace(/\s+RoyakGamesLabAgent/gi, '');
    gameWindow.webContents.setUserAgent(`${baseUA} RoyakGamesLabAgent RoyakFlashEngine/1.0.0`);
    gameWindow.webContents.setWindowOpenHandler(({url}) => {
      try {const u=new URL(url);if(['http:','https:'].includes(u.protocol)) shell.openExternal(url).catch(()=>{});}catch{}
      return {action:'deny'};
    });
    gameWindow.webContents.on('will-navigate',(event,url)=>{
      if(url !== gameWindow.webContents.getURL()) {event.preventDefault();try{const u=new URL(url);if(['http:','https:'].includes(u.protocol))shell.openExternal(url).catch(()=>{});}catch{}}
    });
    // Destination-pinned loopback relay for Ruffle's browser socket API.
    const socketTargets = Array.isArray(cfg.game?.ruffle?.socketTargets) ? cfg.game.ruffle.socketTargets : [];
    const bridges = [];
    try {
      for (const target of socketTargets) {
        const bridge = await startSocketBridge({host:target.host, port:target.port});
        bridges.push({host:target.host, port:target.port, proxyUrl:bridge.url, close:bridge.close});
      }
    } catch (error) {
      for (const bridge of bridges) bridge.close();
      gameWindow.destroy();
      throw error;
    }
    gameWindow.once('closed', () => { for (const bridge of bridges) bridge.close(); });
    const vars = (play.flashVars && typeof play.flashVars === 'object') ? play.flashVars : {};
    const payload = Buffer.from(JSON.stringify({gameName,swf:swfUrl.href,flashvars:vars,quality:play.quality||'high',performance:getPerformance(gameId),diagnostics:!!play.diagnostics,socketProxy:bridges.map(({host,port,proxyUrl})=>({host,port,proxyUrl}))})).toString('base64url');
    const gamePage = path.join(__dirname,'ruffle-player.html');
    await gameWindow.loadFile(gamePage,{query:{payload}});
    gameWindow.show(); gameWindow.focus();
    // Game is a standalone top-level window; do not keep it behind the launcher.
    if(win && !win.isDestroyed()) win.blur();
    const windows = globalThis.__ruffleWindows || (globalThis.__ruffleWindows = new Map());
    windows.set(instanceId,gameWindow);
    gameWindow.on('closed',()=>{windows.delete(instanceId);
      if(windows.size===0 && getPreference('restoreLauncherOnGameClose',true)) bringLauncherToFront();
    });
    return {ok:true,engine:'RoyakFlashEngine/1.0.0',server:server.id,swf:swfUrl.href};
  }

  if (type==='modern') {
    const exe=resolveResource(cfg.game.modern.executable);
    if (!fs.existsSync(exe)) throw new Error('Modern game client is missing.');
    const args=[...(cfg.game.modern.arguments||[]), ...(play.args||[])];
    if (play.url) args.push(play.url);
    return {ok:true,engine:'modern',pid:spawnTracked(exe,args,path.dirname(exe),server),server:server.id};
  }

  throw new Error(`Unsupported play type: ${type}`);
}

function remoteBounds() {
  if (!win) return {x:82,y:0,width:900,height:700};
  const [w,h]=win.getContentSize();
  return {x:82,y:0,width:Math.max(0,w-82),height:Math.max(0,h)};
}
function hideRemote() {
  if (webView) webView.setVisible(false);
  currentRemoteUrl=null;
}
function ensureRemoteView() {
  if (webView) return webView;
  webView = new WebContentsView({
    webPreferences:{
      nodeIntegration:false,
      contextIsolation:true,
      sandbox:true,
      webSecurity:true,
      allowRunningInsecureContent:false
    }
  });
  win.contentView.addChildView(webView);
  installDevToolsGuard(webView.webContents);
  webView.setBounds(remoteBounds());
  webView.setVisible(false);

  webView.webContents.setWindowOpenHandler(({url}) => {
    if (isAllowedRemote(url)) {
      webView.webContents.loadURL(url);
      return {action:'deny'};
    }
    shell.openExternal(url);
    return {action:'deny'};
  });
  webView.webContents.on('will-navigate',(event,url)=>{
    if (!isAllowedRemote(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  return webView;
}
async function showRemote(url) {
  if (!isAllowedRemote(url)) throw new Error('Remote URL origin is not allowed by launcher-config.json.');
  await shell.openExternal(url);
  hideRemote();
}

function bringLauncherToFront() {
  if (!win || win.isDestroyed()) return;
  try {
    if (win.isMinimized()) win.restore();
    // Guard against a window ending up off-screen after display/layout changes.
    const bounds = win.getBounds();
    const displays = require('electron').screen.getAllDisplays();
    const visible = displays.some(display => {
      const area = display.workArea;
      return bounds.x < area.x + area.width && bounds.x + bounds.width > area.x &&
             bounds.y < area.y + area.height && bounds.y + bounds.height > area.y;
    });
    if (!visible) win.center();
    win.setSkipTaskbar(false);
    win.show();
    win.moveTop();
    win.focus();
  } catch (error) {
    console.warn('[Window] Could not bring launcher to front:', error.message);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function setSplashStatus(text, state = 'checking', detail = '') {
  if (!splashWin || splashWin.isDestroyed()) return;
  const script = `window.setSplashStatus && window.setSplashStatus(${JSON.stringify(String(text || ''))}, ${JSON.stringify(String(state || 'checking'))}, ${JSON.stringify(String(detail || ''))})`;
  splashWin.webContents.executeJavaScript(script).catch(() => {});
}

async function checkForLauncherUpdate() {
  const cfg = readConfig().autoUpdate || {};
  const enabled = cfg.enabled !== false;
  const provider = String(cfg.provider || 'github').trim().toLowerCase();
  const feedUrl = String(cfg.url || '').trim();
  const owner = String(cfg.owner || '').trim();
  const repo = String(cfg.repo || '').trim();
  const timeoutMs = Math.max(5000, Number(cfg.checkTimeoutMs || 15000));
  const hasFeedConfig = provider === 'github' ? Boolean(owner && repo) : Boolean(feedUrl);

  setSplashStatus('Checking for updates...', 'checking');

  if (!enabled || !app.isPackaged || !hasFeedConfig) {
    await sleep(700);
    setSplashStatus("You're up to date!", 'ready');
    await sleep(900);
    return { installing: false, skipped: true };
  }

  if (!autoUpdater) {
    setSplashStatus('Update check unavailable', 'warning', 'Starting RoyakGamesLab...');
    await sleep(900);
    return { installing: false, updaterUnavailable: true };
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = cfg.autoInstall !== false;
  autoUpdater.allowDowngrade = false;

  if (cfg.channel) autoUpdater.channel = String(cfg.channel);

  if (provider === 'github') {
    autoUpdater.setFeedURL({
      provider: 'github',
      owner,
      repo,
      private: false,
      releaseType: 'release'
    });
  } else {
    autoUpdater.setFeedURL({ provider, url: feedUrl });
  }

  return new Promise(resolve => {
    let finished = false;
    let sawUpdate = false;

    const finish = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(async () => {
      if (finished) return;
      setSplashStatus('Update check unavailable', 'warning', 'Starting RoyakGamesLab...');
      await sleep(900);
      finish({ installing: false, timedOut: true });
    }, timeoutMs);

    autoUpdater.once('checking-for-update', () => {
      setSplashStatus('Checking for updates...', 'checking');
    });

    autoUpdater.once('update-available', info => {
      sawUpdate = true;
      setSplashStatus('Update Ready!', 'update', info?.version ? `Version ${info.version}` : 'Downloading update...');
    });

    autoUpdater.on('download-progress', progress => {
      if (!sawUpdate) return;
      const percent = Number.isFinite(progress?.percent) ? Math.max(0, Math.min(100, Math.round(progress.percent))) : null;
      setSplashStatus('Update Ready!', 'update', percent === null ? 'Downloading update...' : `Downloading ${percent}%`);
    });

    autoUpdater.once('update-not-available', async () => {
      setSplashStatus("You're up to date!", 'ready');
      await sleep(900);
      finish({ installing: false, current: true });
    });

    autoUpdater.once('update-downloaded', async info => {
      setSplashStatus('Update Ready!', 'update', info?.version ? `Installing version ${info.version}...` : 'Installing update...');
      await sleep(900);
      finish({ installing: true, version: info?.version || null });
      setTimeout(() => {
        try { autoUpdater.quitAndInstall(false, true); } catch (error) { console.error('[Updater] Install failed:', error); app.quit(); }
      }, 120);
    });

    autoUpdater.once('error', async error => {
      console.warn('[Updater] Update check failed:', error?.message || error);
      setSplashStatus('Update check unavailable', 'warning', 'Starting RoyakGamesLab...');
      await sleep(900);
      finish({ installing: false, error: error?.message || String(error) });
    });

    autoUpdater.checkForUpdates().catch(async error => {
      console.warn('[Updater] checkForUpdates failed:', error?.message || error);
      if (finished) return;
      setSplashStatus('Update check unavailable', 'warning', 'Starting RoyakGamesLab...');
      await sleep(900);
      finish({ installing: false, error: error?.message || String(error) });
    });
  });
}

function createSplashWindow() {
  splashWin = new BrowserWindow({
    width:620, height:390, resizable:false, frame:false, transparent:true,
    show:false, alwaysOnTop:true, skipTaskbar:true, center:true,
    backgroundColor:'#00000000',
    webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}
  });
  installDevToolsGuard(splashWin.webContents);
  splashWin.on('closed',()=>{splashWin=null});
  splashWin.loadFile(path.join(__dirname,'splash.html')).then(() => {
    if (splashWin && !splashWin.isDestroyed()) splashWin.show();
  }).catch(error => console.warn('[Splash] Failed to load:', error.message));
}

function createWindow({showOnReady=true} = {}) {
  win=new BrowserWindow({
    width:1280,height:800,minWidth:1000,minHeight:680,
    frame:false,backgroundColor:'#0b0c0f',show:false,
    center:true,
    skipTaskbar:false,
    icon:resolveResource('assets/royakgameslab.ico'),
    webPreferences:{
      preload:path.join(__dirname,'preload.js'),
      contextIsolation:true,nodeIntegration:false,sandbox:true
    }
  });
  installDevToolsGuard(win.webContents);
  win.on('resize',()=>{ if(webView) webView.setBounds(remoteBounds()); });
  win.on('unresponsive',()=>console.warn('[Window] Main renderer became unresponsive.'));
  win.webContents.on('render-process-gone',(_event, details)=>console.error('[Window] Renderer exited:', details));

  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (showOnReady) bringLauncherToFront();
      resolve();
    };

    // `ready-to-show` can occasionally never fire on some Windows/GPU setups.
    // did-finish-load + timeout prevents the app from becoming a background-only process.
    win.once('ready-to-show', finish);
    win.webContents.once('did-finish-load', finish);
    setTimeout(finish, 5000);

    win.loadFile(path.join(__dirname,'index.html')).catch(error => {
      console.error('[Window] Failed to load launcher UI:', error);
      finish();
    });
  });
}

ipcMain.handle('app:get-bootstrap',async()=>({
  manifest:await getLauncherManifest(),
  servers:await getServersWithCounts(),
  engine:chooseEngine(),
  versions:{electron:process.versions.electron,node:process.versions.node,chrome:process.versions.chrome},
  refreshServersMs:readConfig().refreshServersMs,
  appVersion:app.getVersion(),
  discordRpc:{enabled:getDiscordRpcConfig().enabled, configured:!!getDiscordRpcConfig().clientId}
}));
ipcMain.handle('servers:refresh',()=>getServersWithCounts());
ipcMain.handle('rpc:update',async(_e,server,mode='browsing')=>({ok:await applyDiscordPresence(server,mode)}));
ipcMain.handle('rpc:get-enabled',()=>({ok:true,enabled:getDiscordRpcConfig().enabled,configured:!!getDiscordRpcConfig().clientId}));
ipcMain.handle('rpc:set-enabled',async(_e,enabled)=>setDiscordRpcEnabled(!!enabled));
ipcMain.handle('game:launch',async(_e,server)=>{
  const diagnostics = [];
  try {
    diagnostics.push({ok:true,label:`Server state: ${normalizeOnlineState(server?.onlineState ?? server?.online,0) === 1 ? 'Online' : 'Unavailable'}`});
    if (String(server?.play?.type || 'swf').toLowerCase() === 'swf') {
      const legacy = detectLegacy();
      diagnostics.push({ok:!!legacy.executable,label:`Legacy runtime ${legacy.executable ? 'found' : 'missing'}`});
      diagnostics.push({ok:legacy.electronVersionOk,label:`Flash player Electron ${legacy.electronVersion || 'unknown'} (required ${REQUIRED_FLASH_ELECTRON_VERSION})`});
      diagnostics.push({ok:!!legacy.plugin,label:`Flash plugin ${legacy.plugin ? 'found' : 'missing'} (${process.platform}/${process.platform === 'win32' ? getWindowsArchitecture() : process.arch})`});
      diagnostics.push({ok:/^https?:\/\//i.test(String(server?.play?.url || '')),label:'SWF URL valid'});
    }
    const result=await launchServer(server);
    diagnostics.push({ok:true,label:result.alreadyRunning ? 'Game already running' : `Process started${result.pid ? ` (PID ${result.pid})` : ''}`});
    if (getPreference('hideLauncherOnPlay', false) && win && !win.isDestroyed()) setTimeout(()=>{ if(win && !win.isDestroyed()) win.hide(); }, 1250);
    await refreshDiscordForRunningGames();
    return {...result, diagnostics};
  } catch(e) {
    diagnostics.push({ok:false,label:e.message});
    return {ok:false,error:e.message,diagnostics};
  }
});
ipcMain.handle('performance:get',(_e,gameId)=>({ok:true,performance:getPerformance(gameId)}));
ipcMain.handle('performance:set',(_e,gameId,performance)=>({ok:true,performance:savePerformance(gameId,performance)}));
ipcMain.handle('prefs:get',()=>({ok:true,preferences:{
  hideLauncherOnPlay:getPreference('hideLauncherOnPlay',false),
  restoreLauncherOnGameClose:getPreference('restoreLauncherOnGameClose',true),
  allowMultipleInstances:getPreference('allowMultipleInstances',false),
  discordRpcEnabled:getDiscordRpcConfig().enabled
}}));
ipcMain.handle('prefs:set',(_e,key,value)=>{try{return {ok:true,preferences:setPreference(String(key),!!value)}}catch(e){return {ok:false,error:e.message}}});
ipcMain.handle('game:status',()=>({ok:true,running:[...runningGames.values()].map(g=>({pid:g.pid,serverId:g.server.id,name:g.server.name,startedAt:g.startedAt})),active:mostRecentRunningGame()?.server?.id||null}));
ipcMain.handle('server:ping',(_e,server)=>new Promise(resolve=>{
  const host=String(server?.host||'').trim(); const port=Number(server?.port||0);
  if(!host||!port) return resolve({ok:false,latency:null,error:'No host/port'});
  const started=Date.now(); const socket=nodeNet.createConnection({host,port}); let done=false;
  const finish=(result)=>{if(done)return;done=true;try{socket.destroy()}catch{};resolve(result)};
  socket.setTimeout(1800);
  socket.once('connect',()=>finish({ok:true,latency:Date.now()-started}));
  socket.once('timeout',()=>finish({ok:false,latency:null,error:'Timeout'}));
  socket.once('error',err=>finish({ok:false,latency:null,error:err.message}));
}));
ipcMain.handle('view:remote',async(_e,url)=>{try{await showRemote(url);return {ok:true}}catch(e){return {ok:false,error:e.message}}});
ipcMain.handle('view:local',()=>{hideRemote();return {ok:true}});

ipcMain.handle('launcher:reload',()=>{hideRemote();win?.webContents.reloadIgnoringCache();return {ok:true}});
ipcMain.handle('launcher:clear-cache',async()=>{try{await win?.webContents.session.clearCache();if(webView)await webView.webContents.session.clearCache();return {ok:true}}catch(e){return {ok:false,error:e.message}}});
ipcMain.handle('launcher:hide',()=>{win?.minimize();return {ok:true}});
ipcMain.handle('launcher:open-external',async(_e,url)=>{try{const parsed=new URL(url);if(!['https:','http:'].includes(parsed.protocol))throw new Error('Unsupported URL protocol.');await shell.openExternal(url);return {ok:true}}catch(e){return {ok:false,error:e.message}}});

ipcMain.handle('window:minimize',()=>win?.minimize());
ipcMain.handle('window:maximize',()=>{if(!win)return; win.isMaximized()?win.unmaximize():win.maximize()});
ipcMain.handle('window:close',()=>win?.close());

app.setName('RoyakGamesLab');
if (process.platform === 'win32') app.setAppUserModelId('world.royakgames.lab.launcher');
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => bringLauncherToFront());

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);

    // Create the splash first so startup/update state is always visible.
    try { createSplashWindow(); } catch (error) {
      console.error('[Startup] Splash creation failed:', error);
    }

    try { setupDiscordRpc(); } catch (error) {
      console.warn('[Startup] Discord RPC setup skipped:', error.message);
    }

    try {
      const mainWindowReady = createWindow({showOnReady:false});
      await sleep(450);

      const updateResult = await checkForLauncherUpdate();
      if (updateResult?.installing) return;

      await mainWindowReady;
      if (splashWin && !splashWin.isDestroyed()) {
        try { splashWin.webContents.executeJavaScript("window.dispatchEvent(new Event('splash:fade'))"); } catch {}
        await sleep(430);
        if (splashWin && !splashWin.isDestroyed()) splashWin.close();
      }
      bringLauncherToFront();
      setTimeout(() => bringLauncherToFront(), 900);
    } catch (error) {
      console.error('[Startup] Launcher startup failed:', error);
      try {
        if (!win || win.isDestroyed()) {
          win = new BrowserWindow({width:760,height:420,show:true,center:true,backgroundColor:'#0b0c0f'});
          const message = String(error?.stack || error?.message || error).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
          await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<body style="margin:0;background:#0b0c0f;color:#fff;font-family:Segoe UI;padding:32px"><h2>RoyakGamesLab could not start</h2><pre style="white-space:pre-wrap;color:#f2c96d">${message}</pre></body>`)}`);
          bringLauncherToFront();
        }
      } catch {}
    }
  }).catch(error => {
    console.error('[Startup] app.whenReady failed:', error);
  });
}
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});
app.on('before-quit',()=>{stopRunningGameRefresh();try{discordRpcClient?.destroy()}catch{}});
app.on('activate',()=>{
  if(BrowserWindow.getAllWindows().length===0) createWindow().then(()=>bringLauncherToFront());
  else bringLauncherToFront();
});
