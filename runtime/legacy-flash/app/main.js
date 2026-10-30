const { app, BrowserWindow, session, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

const ROYAK_GAMES_LAB_AGENT = 'RoyakGamesLabAgent/1.0';

const REQUIRED_ELECTRON_VERSION = '11.5.0';

// Match the rendering environment used by the old working RoyakGamesLab browser.
// Pepper Flash 32 in Electron 11 is most reliable here with Chromium GPU
// acceleration/compositing disabled while leaving the software rasterizer enabled.
if (process.platform === 'win32') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

// The old working browser disabled renderer process reuse for the PPAPI host.
app.allowRendererProcessReuse = false;

console.log('[Flash Host] Electron:', process.versions.electron);
console.log('[Flash Host] Chromium:', process.versions.chrome);
console.log('[Flash Host] Node:', process.versions.node);

if (String(process.versions.electron || '') !== REQUIRED_ELECTRON_VERSION) {
  console.error(`[Flash Host] Refusing to start: Electron ${REQUIRED_ELECTRON_VERSION} is required, detected ${process.versions.electron || 'unknown'}.`);
  app.whenReady().then(() => {
    dialog.showErrorBox(
      'RoyakGamesLab Flash Runtime',
      `This Flash player must run with Electron ${REQUIRED_ELECTRON_VERSION}.\n\nDetected: ${process.versions.electron || 'unknown'}`
    );
    app.quit();
  });
}

app.setName('RoyakGamesLabFlash');
const persistentUserData = path.join(app.getPath('appData'), 'RoyakGamesLab', 'LegacyFlash');
app.setPath('userData', persistentUserData);

function argValue(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find(v => String(v).startsWith(prefix));
  return arg ? arg.slice(prefix.length) : '';
}

function decodedArgValue(name) {
  const value = argValue(name);
  if (!value) return '';
  try { return decodeURIComponent(value); } catch { return value; }
}

const runtimeDir = path.resolve(__dirname, '..');
const flashRoot = path.resolve(runtimeDir, '..', 'flash');
const explicitPlugin = argValue('flash-plugin');
let localPlayerServer = null;

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

function systemPluginCandidate() {
  const platform = process.platform;

  if (platform === 'win32') {
    return path.join(flashRoot, 'windows', getWindowsArchitecture(), 'pepflashplayer.dll');
  }
  if (platform === 'linux') {
    if (process.arch !== 'x64') return '';
    return path.join(flashRoot, 'linux', 'x64', 'libpepflashplayer.so');
  }
  if (platform === 'darwin') {
    if (process.arch !== 'x64') return '';
    return path.join(flashRoot, 'mac', 'x64', 'PepperFlashPlayer');
  }
  return '';
}

// Only the plugin path explicitly supplied by the trusted launcher, or the
// exact bundled architecture-specific runtime path, may be loaded.
const pluginCandidates = [
  explicitPlugin,
  systemPluginCandidate()
].filter(Boolean);

const pluginPath = pluginCandidates.find(p => {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
});

const versionFile = path.join(runtimeDir, 'flash-version.txt');
const flashVersion = fs.existsSync(versionFile)
  ? fs.readFileSync(versionFile, 'utf8').trim()
  : '32.0.0.465';

if (pluginPath) {
  app.commandLine.appendSwitch('ppapi-flash-path', pluginPath);
  app.commandLine.appendSwitch('ppapi-flash-version', flashVersion);
}
app.commandLine.appendSwitch('enable-plugins');

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function normalizeBaseUrl(value, swf) {
  if (validHttpUrl(value)) {
    try {
      return new URL(value).toString();
    } catch {}
  }

  try {
    const url = new URL(swf);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.substring(0, url.pathname.lastIndexOf('/') + 1);
    return url.toString();
  } catch {
    return '';
  }
}

function downloadBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (!validHttpUrl(url)) return reject(new Error('Invalid icon URL'));
    if (redirects > 3) return reject(new Error('Too many icon redirects'));

    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, {
      headers: { 'User-Agent': ROYAK_GAMES_LAB_AGENT }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        return resolve(downloadBuffer(next, redirects + 1));
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Icon HTTP ${res.statusCode}`));
      }

      const chunks = [];
      let total = 0;

      res.on('data', chunk => {
        total += chunk.length;
        if (total > 5 * 1024 * 1024) {
          req.destroy(new Error('Icon is too large'));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => resolve(Buffer.concat(chunks)));
    });

    req.setTimeout(7000, () => req.destroy(new Error('Icon download timed out')));
    req.on('error', reject);
  });
}

async function loadGameIcon(value) {
  if (!value) return null;

  try {
    if (validHttpUrl(value)) {
      const buffer = await downloadBuffer(value);
      const image = nativeImage.createFromBuffer(buffer);
      return image.isEmpty() ? null : image;
    }

    if (fs.existsSync(value)) {
      const image = nativeImage.createFromPath(value);
      return image.isEmpty() ? null : image;
    }
  } catch {}

  return null;
}

function startLocalPlayerServer() {
  const html = fs.readFileSync(path.join(__dirname, 'player.html'));

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let pathname = '/';
      try {
        pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      } catch {}

      if (pathname !== '/' && pathname !== '/player' && pathname !== '/player.html') {
        res.writeHead(404, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        res.end('Not found');
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(html);
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/player.html`
      });
    });
  });
}

function appendRoyakAgent(userAgent) {
  const base = String(userAgent || '').trim();
  if (base.toLowerCase().includes(ROYAK_GAMES_LAB_AGENT.toLowerCase())) return base;
  return `${base} ${ROYAK_GAMES_LAB_AGENT}`.trim();
}

function safeGamePartition(value, fallbackUrl) {
  let source = String(value || '').trim().toLowerCase();
  if (!source) {
    try { source = new URL(fallbackUrl).hostname.toLowerCase(); } catch {}
  }
  source = source.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return source || 'game';
}

function installRemoteRequestHeaders(ses, baseUrl, userAgent) {
  const referer = normalizeBaseUrl(baseUrl, baseUrl);

  ses.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const headers = details.requestHeaders || {};
    headers['User-Agent'] = userAgent;

    // Do not fabricate AQW/API origins. Preserve Chromium/Flash-generated cookies,
    // origin and referer when they already exist. Only give direct SWF/resource
    // requests a web referer when none was generated by the plugin.
    if (referer && !headers.Referer && !headers.referer) {
      headers.Referer = referer;
    }

    callback({ cancel: false, requestHeaders: headers });
  });
}

async function warmUpGameSession(ses, baseUrl, userAgent) {
  if (!validHttpUrl(baseUrl)) return;

  let originUrl = baseUrl;
  try {
    const parsed = new URL(baseUrl);
    parsed.hash = '';
    originUrl = parsed.toString();
  } catch {
    return;
  }

  const warmup = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      session: ses,
      plugins: false,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true
    }
  });

  warmup.webContents.setUserAgent(userAgent);

  try {
    await warmup.loadURL(originUrl, { userAgent });
    await new Promise(resolve => setTimeout(resolve, 1200));
    await ses.cookies.flushStore();
    await ses.flushStorageData();
  } catch (error) {
    console.warn('[RoyakGamesLabFlash] Session warm-up failed:', error && error.message ? error.message : error);
  } finally {
    if (!warmup.isDestroyed()) warmup.destroy();
  }
}

async function createWindow() {
  const swf = argValue('swf');
  const gameId = argValue('game-id');
  const gameName = (argValue('game-name') || 'RoyakGamesLab Game').trim();
  const gameIconUrl = argValue('game-icon');
  const gameWidth = Math.max(640, Number(argValue('game-width') || 960) || 960);
  const gameHeight = Math.max(360, Number(argValue('game-height') || 550) || 550);
  const baseUrl = normalizeBaseUrl(argValue('base-url'), swf);
  const pageUrl = argValue('page-url');
  const requestedEmbedMode = String(argValue('embed-mode') || '').trim().toLowerCase();
  const embedMode = pageUrl ? 'page' : (requestedEmbedMode === 'direct' ? 'direct' : 'wrapper');
  const playerSelector = decodedArgValue('player-selector') || '#flashContent';
  const scale = argValue('scale') || 'exactfit';
  const allowFullscreen = argValue('allow-fullscreen') !== '0';
  const flashVarsEncoded = argValue('flash-vars');

  if (!validHttpUrl(swf)) {
    dialog.showErrorBox(gameName, 'A valid http/https SWF URL was not supplied.');
    app.quit();
    return;
  }

  if (pageUrl && !validHttpUrl(pageUrl)) {
    dialog.showErrorBox(gameName, 'The supplied pageUrl is not a valid http/https URL.');
    app.quit();
    return;
  }

  const icon = await loadGameIcon(gameIconUrl);
  const partitionId = safeGamePartition(gameId, swf);
  const ses = session.fromPartition(`persist:royakgameslab-flash-${partitionId}`);
  const browserUserAgent = appendRoyakAgent(ses.getUserAgent());
  ses.setUserAgent(browserUserAgent);
  installRemoteRequestHeaders(ses, pageUrl ? '' : baseUrl, browserUserAgent);
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'flash');
  });

  const windowOptions = {
    width: gameWidth,
    height: gameHeight,
    useContentSize: true,
    minWidth: 640,
    minHeight: 360,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: gameName,
    webPreferences: {
      session: ses,
      plugins: true,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true
    }
  };

  if (icon) windowOptions.icon = icon;

  const win = new BrowserWindow(windowOptions);
  win.webContents.setUserAgent(browserUserAgent);
  win.setTitle(gameName);
  win.setMenuBarVisibility(false);

  win.webContents.on('page-title-updated', event => {
    event.preventDefault();
    win.setTitle(gameName);
  });

  const heldDevKeys = new Set();
  const secretDevKeys = new Set(['ControlRight', 'ShiftRight', 'KeyA', 'KeyS', 'KeyW']);
  let devToolsLatch = false;
  let devToolsArmed = true;

  win.webContents.on('before-input-event', (event, input) => {
    const key = String(input.key || '').toLowerCase();
    const code = String(input.code || '');
    const type = String(input.type || '');

    if (type === 'keyDown' || type === 'rawKeyDown') heldDevKeys.add(code);
    if (type === 'keyUp') {
      heldDevKeys.delete(code);

      // Re-arm only after the ENTIRE secret chord is released. Electron 11
      // may emit repeat/rawKeyDown events while keys are held; re-arming on a
      // single keyUp caused DevTools to reopen right after it was closed.
      if ([...secretDevKeys].every(c => !heldDevKeys.has(c))) {
        devToolsLatch = false;
        devToolsArmed = true;
      }
      return;
    }

    const secretCombo = [...secretDevKeys].every(c => heldDevKeys.has(c));
    const hasRightModifiers = heldDevKeys.has('ControlRight') && heldDevKeys.has('ShiftRight');

    if (hasRightModifiers && ['KeyA', 'KeyS', 'KeyW'].includes(code)) {
      event.preventDefault();
    }

    if (secretCombo && !devToolsLatch && devToolsArmed) {
      event.preventDefault();
      devToolsLatch = true;
      devToolsArmed = false;
      if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
      else win.webContents.openDevTools({ mode: 'detach' });
      return;
    }

    if (key === 'f11' && type === 'keyDown') {
      event.preventDefault();
      win.setFullScreen(!win.isFullScreen());
      return;
    }

    if (key === 'f12' || (input.control && input.shift && ['i', 'j', 'c'].includes(key))) {
      event.preventDefault();
    }
  });

  win.webContents.on('context-menu', event => event.preventDefault());

  win.on('close', () => {
    try { ses.flushStorageData(); } catch {}
  });

  if (embedMode === 'direct') {
    // Old RoyakGames browser behavior: navigate Chromium/PPAPI straight to
    // the SWF URL. This is intentionally different from the local player.html
    // wrapper. Some AQW-derived clients (notably AdventureVanilla) use nested
    // MovieClip/ColorTransform animation code that behaves correctly in the
    // direct plugin document but differently when embedded in a localhost
    // <object> wrapper.
    let directUrl = swf;

    if (flashVarsEncoded) {
      try {
        const vars = JSON.parse(decodeURIComponent(flashVarsEncoded));
        const u = new URL(directUrl);
        for (const [k, v] of Object.entries(vars || {})) {
          if (v !== undefined && v !== null && !u.searchParams.has(k)) {
            u.searchParams.set(k, String(v));
          }
        }
        directUrl = u.toString();
      } catch {}
    }

    console.log('[Flash Host] embed mode: direct');
    console.log('[Flash Host] direct SWF:', directUrl);
    await win.loadURL(directUrl, { userAgent: browserUserAgent });
  } else if (pageUrl) {
    // Real-page mode: load the game's own web player in the SAME persistent
    // session so Flash requests keep the site's native origin, cookies and
    // same-origin request context. RoyakGamesLab only crops the page visually.
    await win.loadURL(pageUrl, { userAgent: browserUserAgent });

    const selectorJson = JSON.stringify(playerSelector);
    const isolated = await win.webContents.executeJavaScript(`
      (async () => {
        const selector = ${selectorJson};
        const deadline = Date.now() + 15000;
        let player = null;

        while (Date.now() < deadline) {
          player = document.querySelector(selector);
          if (player) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (!player) return false;

        let node = player;
        while (node && node !== document.body) {
          const parent = node.parentElement;
          if (!parent) break;
          for (const sibling of Array.from(parent.children)) {
            if (sibling !== node) sibling.style.setProperty('display', 'none', 'important');
          }
          node = parent;
        }

        const style = document.createElement('style');
        style.textContent = \`
          html, body {
            width: 100% !important;
            height: 100% !important;
            margin: 0 !important;
            padding: 0 !important;
            overflow: hidden !important;
            background: #000 !important;
          }
        \`;
        document.head.appendChild(style);

        let current = player;
        while (current && current !== document.documentElement) {
          current.style.setProperty('width', '100%', 'important');
          current.style.setProperty('height', '100%', 'important');
          current.style.setProperty('max-width', 'none', 'important');
          current.style.setProperty('max-height', 'none', 'important');
          current.style.setProperty('margin', '0', 'important');
          current.style.setProperty('padding', '0', 'important');
          current = current.parentElement;
        }

        player.style.setProperty('position', 'fixed', 'important');
        player.style.setProperty('inset', '0', 'important');
        player.style.setProperty('z-index', '2147483647', 'important');
        player.style.setProperty('display', 'block', 'important');

        for (const el of player.querySelectorAll('object, embed')) {
          el.setAttribute('width', '100%');
          el.setAttribute('height', '100%');
          el.style.setProperty('width', '100%', 'important');
          el.style.setProperty('height', '100%', 'important');
          el.style.setProperty('display', 'block', 'important');
        }

        return true;
      })();
    `, true);

    if (!isolated) {
      dialog.showErrorBox(gameName, `Player element not found: ${playerSelector}`);
    }
  } else {
    // Wrapper mode is kept for games such as AQW that explicitly use FlashVars/player embedding.
    await warmUpGameSession(ses, baseUrl, browserUserAgent);

    const local = await startLocalPlayerServer();
    localPlayerServer = local.server;

    const player = new URL(local.url);
    player.searchParams.set('swf', swf);
    player.searchParams.set('name', gameName);
    player.searchParams.set('base', baseUrl);
    if (flashVarsEncoded) player.searchParams.set('flashVars', flashVarsEncoded);
    player.searchParams.set('scale', scale);
    player.searchParams.set('allowFullScreen', allowFullscreen ? '1' : '0');

    await win.loadURL(player.toString(), {
      userAgent: browserUserAgent,
      httpReferrer: baseUrl || undefined
    });
  }
}

app.whenReady().then(async () => {
  if (!pluginPath) {
    dialog.showErrorBox(
      'RoyakGamesLab Legacy Flash',
      `No compatible PPAPI Flash plugin was found for ${process.platform}/${process.platform === 'win32' ? getWindowsArchitecture() : process.arch}.\n\nExpected: ${systemPluginCandidate() || 'No bundled plugin for this architecture.'}`
    );
    app.quit();
    return;
  }

  await createWindow();
});

app.on('before-quit', () => {
  if (localPlayerServer) {
    try {
      localPlayerServer.close();
    } catch {}
    localPlayerServer = null;
  }
});

app.on('window-all-closed', () => app.quit());
