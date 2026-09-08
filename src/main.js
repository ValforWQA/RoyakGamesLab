const { app, BrowserWindow, WebContentsView, ipcMain, net, shell, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const nodeNet = require('net');

const devBase = path.resolve(__dirname, '..');
const baseDir = app.isPackaged ? process.resourcesPath : devBase;
const configPath = path.join(baseDir, 'launcher-config.json');

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
    comboLatched: false
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
      if (!DEVTOOLS_COMBO.has(code)) return;
      if (![...DEVTOOLS_COMBO].every(c => state.pressed.has(c))) state.comboLatched = false;
      return;
    }

    const hasCombo = [...DEVTOOLS_COMBO].every(c => state.pressed.has(c));
    const hasRightModifiers = state.pressed.has('ControlRight') && state.pressed.has('ShiftRight');

    // Once the two right-side modifiers are held, swallow A/S/W so the secret
    // chord is not typed into forms or remote admin pages.
    if (hasRightModifiers && ['KeyA', 'KeyS', 'KeyW'].includes(code)) {
      event.preventDefault();
    }

    if (hasCombo && !state.comboLatched) {
      event.preventDefault();
      state.comboLatched = true;

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
  return path.resolve(baseDir, rel);
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
  const legacy = readConfig().game.legacy || {};
  const configuredHosts = [legacy.hostExecutable, ...(legacy.hostExecutableCandidates || [])].filter(Boolean);
  const defaultHosts = [
    'runtime/legacy-flash/app/node_modules/electron/dist/electron.exe',
    'runtime/legacy-flash/RoyakGamesLabFlash.exe',
    'runtime/legacy-flash/electron.exe',
    'runtime/flash/electron.exe',
    'client/legacy-flash/RoyakGamesLabFlash.exe'
  ];
  const seen = new Set();
  return [...configuredHosts, ...defaultHosts]
    .map(v => String(v).trim())
    .filter(Boolean)
    .filter(v => {
      const k = v.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map(relative => ({ relative, absolute: resolveResource(relative) }));
}

function getBundledSystemFlashPluginRelative() {
  if (process.platform === 'win32') {
    return `runtime/flash/windows/${process.arch === 'ia32' ? 'x86' : 'x64'}/pepflashplayer.dll`;
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
  const legacy = readConfig().game.legacy || {};
  const configured = Array.isArray(legacy.pluginCandidates) ? legacy.pluginCandidates : [];
  const systemBundled = getBundledSystemFlashPluginRelative();
  const defaults = [systemBundled].filter(Boolean);
  const envPlugin = String(process.env.ROYAK_FLASH_PLUGIN || '').trim();
  const values = [...configured, ...defaults];
  if (envPlugin) values.unshift(envPlugin);
  const seen = new Set();
  return values.map(v => String(v).trim()).filter(Boolean).filter(v => {
    const key = v.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(value => ({
    relative: path.isAbsolute(value) ? null : value,
    absolute: path.isAbsolute(value) ? value : resolveResource(value)
  }));
}

function detectLegacy() {
  const legacy = readConfig().game.legacy || {};
  const candidates = getLegacyFlashHostCandidates();
  const found = candidates.find(entry => {
    try { return fs.existsSync(entry.absolute) && fs.statSync(entry.absolute).isFile(); }
    catch { return false; }
  }) || null;

  const appRelative = legacy.hostAppPath || 'runtime/legacy-flash/app';
  const appAbsolute = resolveResource(appRelative);
  const pluginCandidates = getLegacyFlashPluginCandidates();
  const plugin = pluginCandidates.find(entry => {
    try { return fs.existsSync(entry.absolute) && fs.statSync(entry.absolute).isFile(); }
    catch { return false; }
  }) || null;
  return {
    detected: !!found && !!plugin,
    hostDetected: !!found,
    pluginDetected: !!plugin,
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

async function launchServer(server) {
  if (!server || normalizeOnlineState(server.onlineState ?? server.online, 0)!==1)
    throw new Error('This server is not online.');

  const cfg=readConfig();
  const play=server.play || {};
  const type=String(play.type || 'swf').toLowerCase();
  const existing = [...runningGames.values()].find(g => g.server?.id === server.id);
  if (existing && !getPreference('allowMultipleInstances', false)) {
    return {ok:true, alreadyRunning:true, pid:existing.pid, engine:'existing', server:server.id};
  }

  if (type==='web' || type==='url' || type==='browser') {
    if (!/^https?:\/\//i.test(String(play.url || ''))) throw new Error('Server play URL must be http/https.');
    await shell.openExternal(play.url);
    return {ok:true,engine:'web',server:server.id};
  }

  if (type==='swf' || type==='flash') {
    if (!/^https?:\/\//i.test(String(play.url || ''))) throw new Error('Server SWF URL must be http/https.');
    const host = detectLegacy();
    if (!host.executable) {
      const tried = host.tried.length ? `\n\nLegacy host paths checked:\n${host.tried.map(p => ` - ${p}`).join('\n')}` : '';
      throw new Error('Legacy Flash host is not installed. Run SETUP.cmd once to install the isolated legacy Electron host.' + tried);
    }
    if (!host.plugin) {
      const tried = host.pluginTried.length ? `\n\nFlash plugin paths checked:\n${host.pluginTried.map(p => ` - ${p}`).join('\n')}` : '';
      throw new Error('The legacy host is installed, but pepflashplayer.dll is missing. Put your PPAPI Flash plugin in runtime\\legacy-flash\\pepflashplayer.dll or set ROYAK_FLASH_PLUGIN.' + tried);
    }
    const args = makeLegacyFlashHostArgs(host, play, server);
    return {
      ok:true,
      engine:'legacy-flash-plugin',
      host:host.executable,
      hostRelative:host.executableRelative,
      pid:spawnTracked(host.executable,args,path.dirname(host.executable),server),
      server:server.id,
      swf:play.url
    };
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
  const view=ensureRemoteView();
  view.setBounds(remoteBounds());
  view.setVisible(true);
  currentRemoteUrl=url;
  await view.webContents.loadURL(url);
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
  splashWin.loadFile(path.join(__dirname,'splash.html'));
  splashWin.once('ready-to-show',()=>splashWin?.show());
  splashWin.on('closed',()=>{splashWin=null});
}

function createWindow({showOnReady=true} = {}) {
  win=new BrowserWindow({
    width:1280,height:800,minWidth:1000,minHeight:680,
    frame:false,backgroundColor:'#0b0c0f',show:false,
    icon:resolveResource('assets/royakgameslab.ico'),
    webPreferences:{
      preload:path.join(__dirname,'preload.js'),
      contextIsolation:true,nodeIntegration:false,sandbox:true
    }
  });
  installDevToolsGuard(win.webContents);
  win.loadFile(path.join(__dirname,'index.html'));
  win.on('resize',()=>{ if(webView) webView.setBounds(remoteBounds()); });
  return new Promise(resolve => {
    win.once('ready-to-show',()=>{
      if(showOnReady) win.show();
      resolve();
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
      diagnostics.push({ok:!!legacy.plugin,label:`Flash plugin ${legacy.plugin ? 'found' : 'missing'} (${process.platform}/${process.arch})`});
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

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  setupDiscordRpc();
  createSplashWindow();

  const mainWindowReady = createWindow({showOnReady:false});
  await sleep(450);
  const updateResult = await checkForLauncherUpdate();

  if (updateResult?.installing) return;

  await mainWindowReady;
  if (splashWin && !splashWin.isDestroyed()) {
    try { splashWin.webContents.executeJavaScript("window.dispatchEvent(new Event('splash:fade'))"); } catch {}
    await sleep(360);
    if (splashWin && !splashWin.isDestroyed()) splashWin.close();
  }
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
  }
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});
app.on('before-quit',()=>{stopRunningGameRefresh();try{discordRpcClient?.destroy()}catch{}});
app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow()});
