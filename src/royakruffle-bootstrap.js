'use strict';
(async () => {
 const status = document.getElementById('status');
 const metrics = document.getElementById('metrics');
 const params = new URLSearchParams(location.search);
 const fail = e => { status.textContent = 'RoyakFlashEngine: ' + (e?.message || String(e)); console.error('[RoyakRuffle]', e); };
 try {
  const encoded = params.get('payload');
  if (!encoded) throw Error('Missing game launch payload');
  const payload = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')));
  document.title = String(payload.gameName || 'Game');
  if (!window.RufflePlayer) throw Error('Local runtime missing. Run npm run setup:ruffle before launching.');
  let settings = payload.performance || {profile:'balanced',fps:60,quality:'high',showFps:false};
  window.applyRoyakPerformance = next => {
    settings={...settings,...next};
    metrics.style.display=settings.showFps?'block':'none';
    // Ruffle's SWF frame rate is not controlled by this target.
  };
  window.applyRoyakPerformance(settings);
  // The self-hosted bundle resolves WASM from this directory, not the network.
  window.RufflePlayer.config = { ...window.RufflePlayer.config, publicPath: new URL('../vendor/royakruffle/', location.href).href,
    socketProxy: Array.isArray(payload.socketProxy) ? payload.socketProxy : [],
    logLevel: 'warn', preferredRenderer: 'wgpu-webgl', scale: 'exactfit', forceScale: true, autoplay: 'on', unmuteOverlay: 'visible' };
  const player = window.RufflePlayer.newest().createPlayer();
  player.addEventListener('error', event => { console.error('[RoyakFlashEngine player error]', event); status.textContent = 'RoyakFlashEngine player error — see runtime log'; status.style.display = 'block'; });
  player.style.display = 'block'; player.style.width = '100%'; player.style.height = '100%';
  document.getElementById('player').append(player);
  await player.load({ url: payload.swf, parameters: payload.flashvars || {}, quality: settings.quality || payload.quality || 'high', scale: 'exactfit', forceScale: true, autoplay: 'on', unmuteOverlay: 'visible', allowScriptAccess: true });
  status.remove();
  // Display-frame estimate from requestAnimationFrame; not the SWF timeline frame rate.
  let frames = 0, last = performance.now();
  const sample = now => { frames++; if (now - last >= 1000) {
   if (settings.showFps) metrics.textContent = `${Math.round(frames * 1000 / (now-last))} FPS`;
   frames=0;last=now;
  } requestAnimationFrame(sample); };
  requestAnimationFrame(sample);
 } catch(e) { fail(e); }
})();
