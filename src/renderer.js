const $ = id => document.getElementById(id);

let bootstrapState = null;
let servers = [];
let selectedServerId = null;
let refreshTimer = null;
let toastTimer = null;
let launchStateTimer = null;
let tooltipTimer = null;
let rpcEnabled = true;
let preferences = {
  hideLauncherOnPlay:false,
  restoreLauncherOnGameClose:true,
  allowMultipleInstances:false
};
let serverLatency = new Map();
let lastDiagnostics = [];
let lastDiagnosticGame = '';

function stateOf(server){
  const value = Number(server?.onlineState);
  if(value === 2) return {code:2,key:'maintenance',label:'MAINTENANCE'};
  if(value === 0) return {code:0,key:'offline',label:'OFFLINE'};
  return {code:1,key:'online',label:'ONLINE'};
}
function initials(name='Server'){
  const words=String(name).trim().split(/\s+/).filter(Boolean);
  return (words.length>1 ? words[0][0]+words[1][0] : words[0]?.slice(0,2)||'SV').toUpperCase();
}
function inferCountryCode(server){
  const explicit=String(server?.countryCode||'').trim().toUpperCase();
  if(/^[A-Z]{2}$/.test(explicit)) return explicit;
  const region=String(server?.region||'').trim().toLowerCase();
  const aliases=[[/^(us|usa|united states)\b/,'US'],[/^(ca|canada)\b/,'CA'],[/^(uk|united kingdom|gb|great britain)\b/,'GB'],[/^(au|australia)\b/,'AU'],[/^(br|brazil)\b/,'BR'],[/^(de|germany)\b/,'DE'],[/^(fr|france)\b/,'FR'],[/^(jp|japan)\b/,'JP'],[/^(kr|korea|south korea)\b/,'KR'],[/^(sg|singapore)\b/,'SG']];
  for(const [rx,code] of aliases) if(rx.test(region)) return code;
  return '';
}
function flagEmoji(code){
  if(!/^[A-Z]{2}$/.test(code||'')) return '';
  return [...code].map(ch=>String.fromCodePoint(127397+ch.charCodeAt(0))).join('');
}
function flagImageUrl(code){
  if(!/^[A-Z]{2}$/.test(code||'')) return '';
  return `https://flagcdn.com/${code.toLowerCase()}.svg`;
}
function validCssColor(value){
  const v=String(value||'').trim();
  return v && CSS.supports('color',v) ? v : null;
}
function safeImageUrl(value){return String(value||'').replace(/"/g,'%22')}
function selectedServer(){return servers.find(s=>s.id===selectedServerId)||null}
function showToast(message){
  const toast=$('toast'); toast.textContent=message; toast.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>toast.classList.add('hidden'),2600);
}
function applyServerTheme(server){
  const ui=server?.ui||{}, root=document.documentElement;
  root.style.setProperty('--server-play-color',validCssColor(ui.playButtonColor)||'#438cff');
  root.style.setProperty('--server-play-hover',validCssColor(ui.playButtonHoverColor)||validCssColor(ui.playButtonColor)||'#5b9cff');
  root.style.setProperty('--server-play-text',validCssColor(ui.playButtonTextColor)||'#fff');
  root.style.setProperty('--server-discord-color',validCssColor(ui.discordButtonColor)||'rgba(8,8,8,.18)');
  root.style.setProperty('--server-discord-text',validCssColor(ui.discordButtonTextColor)||'#fff');
  root.style.setProperty('--server-accent',validCssColor(ui.accentColor)||'#438cff');
  root.style.setProperty('--player-count-color',validCssColor(ui.playerCountColor)||'#59e787');
  root.style.setProperty('--status-online-color',validCssColor(ui.statusOnlineColor)||'#43df75');
  root.style.setProperty('--status-maintenance-color',validCssColor(ui.statusMaintenanceColor)||'#f2b84b');
  root.style.setProperty('--status-offline-color',validCssColor(ui.statusOfflineColor)||'#9b9b9b');
  $('playSubText').textContent=ui.playButtonSubText||'LAUNCH GAME';
  $('discordButtonText').textContent=ui.discordButtonText||'JOIN DISCORD';
}
function setLaunchVisual(state,text,detail=''){
  const play=$('playBtn'); clearTimeout(launchStateTimer);
  play.classList.remove('launching','success','error'); if(state) play.classList.add(state);
  if(text) $('playText').textContent=text;
  $('launchMessage').className=`launchMessage ${state||''}`.trim();
  $('launchMessage').textContent=detail;
}
function chooseAvailable(){
  const current=servers.find(s=>s.id===selectedServerId);
  if(current && stateOf(current).code===1) return;
  selectedServerId=servers.find(s=>stateOf(s).code===1)?.id||servers[0]?.id||null;
}

function hideRailTooltip(){
  clearTimeout(tooltipTimer);
  $('railTooltip').classList.add('hidden');
}
function showSimpleTooltip(target,text){
  const tip=$('railTooltip');
  tip.classList.remove('serverNameOnly');
  $('tooltipIcon').classList.add('hidden');
  $('tooltipName').textContent=text;
  $('tooltipStatus').textContent='ROYAKGAMESLAB';
  $('tooltipStatus').className='tooltipStatus neutral';
  $('tooltipMeta').textContent='';
  $('tooltipMeta').classList.remove('hidden');
  positionTooltip(target);
  tip.classList.remove('hidden');
}
function showServerTooltip(target,server){
  const tip=$('railTooltip');
  tip.classList.add('serverNameOnly');
  $('tooltipIcon').classList.add('hidden');
  $('tooltipName').textContent=server.name;
  $('tooltipStatus').textContent='';
  $('tooltipStatus').className='tooltipStatus hidden';
  $('tooltipMeta').textContent='';
  $('tooltipMeta').classList.add('hidden');
  positionTooltip(target);
  tip.classList.remove('hidden');
}
function positionTooltip(target){
  const rect=target.getBoundingClientRect(), tip=$('railTooltip');
  tip.style.left=`${Math.round(rect.right+14)}px`;
  tip.style.top=`${Math.max(12,Math.round(rect.top+rect.height/2))}px`;
}
function bindCustomTooltip(target,handler){
  target.addEventListener('mouseenter',()=>{clearTimeout(tooltipTimer);tooltipTimer=setTimeout(()=>handler(target),90)});
  target.addEventListener('mouseleave',()=>{clearTimeout(tooltipTimer);tooltipTimer=setTimeout(hideRailTooltip,70)});
  target.addEventListener('focus',()=>handler(target));
  target.addEventListener('blur',hideRailTooltip);
}

function renderRail(){
  const rail=$('serverRail'); rail.innerHTML=''; hideRailTooltip();
  for(const server of servers){
    const st=stateOf(server), button=document.createElement('button');
    button.type='button'; button.className=`serverIcon ${st.key}${server.id===selectedServerId?' selected':''}`;
    button.dataset.serverId=server.id; button.disabled=false; button.setAttribute('aria-disabled',st.code!==1?'true':'false'); button.setAttribute('aria-label',`${server.name}, ${st.label}`);
    if(server.ogImage){
      const img=document.createElement('img'); img.src=server.ogImage; img.alt='';
      img.addEventListener('error',()=>{img.remove();const f=document.createElement('span');f.className='iconFallback';f.textContent=initials(server.name);button.prepend(f)});
      button.appendChild(img);
    }else{const f=document.createElement('span');f.className='iconFallback';f.textContent=initials(server.name);button.appendChild(f)}
    const dot=document.createElement('span'); dot.className='railState'; button.appendChild(dot);
    bindCustomTooltip(button,t=>showServerTooltip(t,server));
    if(st.code===1) button.addEventListener('click',async()=>{
      await window.AV.showLocal(); selectedServerId=server.id; renderRail(); renderSelected();
      window.AV.updateDiscordRpc(server,'browsing').catch(()=>{}); pingSelectedServer();
    });
    rail.appendChild(button);
  }
}

function renderSelected(){
  const server=selectedServer(), play=$('playBtn');
  if(!server){
    $('fallbackTitle').textContent='NO SERVERS'; $('serverLogo').classList.add('hidden'); $('serverDescription').textContent='No server information is available yet.';
    $('statusBadge').className='statusBadge offline'; $('statusBadge').textContent='OFFLINE'; $('playerCount').textContent='—'; $('serverRegion').textContent='—'; $('countryFlag').removeAttribute('src'); $('countryFlag').classList.add('hidden'); play.disabled=true; $('playText').textContent='UNAVAILABLE'; $('discordBtn').classList.add('hidden'); return;
  }
  const st=stateOf(server); applyServerTheme(server);
  const hero=$('hero');
  hero.style.backgroundImage=server.background ? `linear-gradient(90deg,rgba(4,7,5,.84) 0%,rgba(4,7,5,.45) 47%,rgba(4,7,5,.08) 77%),linear-gradient(0deg,rgba(3,4,3,.82),transparent 42%),url("${safeImageUrl(server.background)}")` : 'linear-gradient(90deg,rgba(4,7,5,.84),rgba(4,7,5,.14)),radial-gradient(circle at 77% 32%,rgba(70,112,63,.42),transparent 28%),linear-gradient(135deg,#304a57,#23372b 50%,#10170f)';
  const logo=$('serverLogo');
  if(server.logo){logo.src=server.logo;logo.classList.remove('hidden');$('fallbackTitle').classList.add('hidden')} else {logo.removeAttribute('src');logo.classList.add('hidden');$('fallbackTitle').classList.remove('hidden');$('fallbackTitle').textContent=server.name.toUpperCase()}
  $('serverDescription').textContent=st.code===2 && server.maintenanceMessage ? server.maintenanceMessage : (server.description||`${server.name} game server.`);
  $('statusBadge').className=`statusBadge ${st.key}`; $('statusBadge').textContent=st.label;
  $('playerCount').textContent=st.code===1 ? Number(server.players||0).toLocaleString() : '—';
  $('serverRegion').textContent=server.region||'Global';
  const code=inferCountryCode(server);
  const countryFlag=$('countryFlag');
  if(code){
    countryFlag.src=flagImageUrl(code);
    countryFlag.alt=`${code} flag`;
    countryFlag.classList.remove('hidden');
    countryFlag.onerror=()=>{countryFlag.removeAttribute('src');countryFlag.classList.add('hidden')};
  }else{
    countryFlag.removeAttribute('src');
    countryFlag.classList.add('hidden');
  }
  const canPlay=st.code===1 && bootstrapState?.engine?.engine!=='none'; play.disabled=!canPlay;
  $('playText').textContent=st.code===0?'SERVER OFFLINE':st.code===2?'MAINTENANCE':bootstrapState?.engine?.engine==='none'?'CLIENT MISSING':server.ui?.playButtonText||'PLAY NOW';
  const discord=server.discord||server.raw?.discord||server.raw?.discordUrl||server.raw?.discord_url; $('discordBtn').classList.toggle('hidden',!discord);
}

async function pingSelectedServer(){
  const server=selectedServer(); if(!server || stateOf(server).code!==1) return;
  try{const r=await window.AV.pingServer(server);serverLatency.set(server.id,r?.ok?r.latency:null)}catch{serverLatency.set(server.id,null)}
}
function renderServerData(result){
  servers=Array.isArray(result?.servers)?result.servers:[]; chooseAvailable(); renderRail(); renderSelected(); pingSelectedServer();
  const error=!result?.ok?`Server feed unavailable: ${result?.error||'Unknown error'}`:''; $('feedMessage').textContent=error; $('feedMessage').classList.toggle('hidden',!error);
}
async function refreshServers(){try{renderServerData(await window.AV.refreshServers())}catch(error){$('feedMessage').textContent=`Server refresh failed: ${error.message}`;$('feedMessage').classList.remove('hidden')}}

function closeSettings(){$('settingsBackdrop').classList.add('hidden');$('settingsBackdrop').setAttribute('aria-hidden','true');$('settingsBtn').classList.remove('active');$('settingsBtn').setAttribute('aria-expanded','false')}
function updateSwitch(button,enabled){
  button.classList.toggle('on',!!enabled);button.classList.toggle('off',!enabled);button.setAttribute('aria-checked',enabled?'true':'false');
  const text=button.querySelector('.rpcStateText'); if(text) text.textContent=enabled?'ON':'OFF';
}
function updatePreferenceSwitches(){
  updateSwitch($('hideOnPlayToggle'),preferences.hideLauncherOnPlay);
  updateSwitch($('restoreOnCloseToggle'),preferences.restoreLauncherOnGameClose);
  updateSwitch($('multiInstanceToggle'),preferences.allowMultipleInstances);
  updateSwitch($('rpcToggle'),rpcEnabled);
}
async function toggleSettings(){
  if(!$('settingsBackdrop').classList.contains('hidden')) return closeSettings();
  await window.AV.showLocal();
  const [rpc,prefs]=await Promise.all([window.AV.getDiscordRpcEnabled(),window.AV.getPreferences()]);
  rpcEnabled=rpc?.enabled!==false; Object.assign(preferences,prefs?.preferences||{}); updatePreferenceSwitches();
  $('settingsBackdrop').classList.remove('hidden'); $('settingsBackdrop').setAttribute('aria-hidden','false'); $('settingsBtn').classList.add('active'); $('settingsBtn').setAttribute('aria-expanded','true');
}
async function setBooleanPreference(key,button){
  const desired=!preferences[key], result=await window.AV.setPreference(key,desired);
  if(!result?.ok) return showToast(result?.error||'Could not save setting.');
  preferences[key]=desired; updateSwitch(button,desired);
}
async function toggleRpc(){
  const result=await window.AV.setDiscordRpcEnabled(!rpcEnabled); if(!result?.ok) return showToast(result?.error||'Could not change Discord Presence.');
  rpcEnabled=result.enabled; updateSwitch($('rpcToggle'),rpcEnabled); if(rpcEnabled && selectedServer()) window.AV.updateDiscordRpc(selectedServer(),'browsing').catch(()=>{});
}
async function handleMenuAction(action){
  closeSettings(); if(action==='reload') return window.AV.reloadLauncher();
  if(action==='clear-cache'){const r=await window.AV.clearCache();return showToast(r?.ok?'Launcher cache cleared.':r?.error||'Could not clear cache.')}
  if(action==='hide') return window.AV.hideLauncher();
}

function showDiagnostics(game,items){
  lastDiagnosticGame=game||lastDiagnosticGame; lastDiagnostics=Array.isArray(items)?items:lastDiagnostics;
  $('diagnosticsGame').textContent=lastDiagnosticGame; $('diagnosticsList').innerHTML='';
  for(const item of lastDiagnostics){const row=document.createElement('div');row.className=`diagnosticRow ${item.ok?'ok':'bad'}`;row.innerHTML=`<span class="diagIcon">${item.ok?'✓':'×'}</span><span>${String(item.label||'')}</span>`;$('diagnosticsList').appendChild(row)}
  $('diagnosticsBackdrop').classList.remove('hidden'); $('diagnosticsBackdrop').setAttribute('aria-hidden','false');
}
function closeDiagnostics(){$('diagnosticsBackdrop').classList.add('hidden');$('diagnosticsBackdrop').setAttribute('aria-hidden','true')}

async function init(){
  bootstrapState=await window.AV.bootstrap(); $('versionText').textContent=`v${bootstrapState.appVersion||'1.0.0'}`; renderServerData(bootstrapState.servers);
  const prefs=await window.AV.getPreferences(); Object.assign(preferences,prefs?.preferences||{}); rpcEnabled=bootstrapState?.discordRpc?.enabled!==false; updatePreferenceSwitches();
  if(selectedServer()) window.AV.updateDiscordRpc(selectedServer(),'browsing').catch(()=>{});
  clearInterval(refreshTimer); refreshTimer=setInterval(refreshServers,Math.max(5000,Number(bootstrapState.refreshServersMs||15000)));
}

$('minBtn').addEventListener('click',()=>window.AV.minimize()); $('maxBtn').addEventListener('click',()=>window.AV.maximize()); $('closeBtn').addEventListener('click',()=>window.AV.close());
$('settingsBtn').addEventListener('click',toggleSettings); $('settingsClose').addEventListener('click',closeSettings); $('settingsBackdrop').addEventListener('pointerdown',e=>{if(e.target===$('settingsBackdrop'))closeSettings()});
$('rpcToggle').addEventListener('click',toggleRpc); $('hideOnPlayToggle').addEventListener('click',()=>setBooleanPreference('hideLauncherOnPlay',$('hideOnPlayToggle'))); $('restoreOnCloseToggle').addEventListener('click',()=>setBooleanPreference('restoreLauncherOnGameClose',$('restoreOnCloseToggle'))); $('multiInstanceToggle').addEventListener('click',()=>setBooleanPreference('allowMultipleInstances',$('multiInstanceToggle')));
document.querySelectorAll('#settingsMenu [data-action]').forEach(b=>b.addEventListener('click',()=>handleMenuAction(b.dataset.action)));
bindCustomTooltip(document.querySelector('.brandButton'),t=>showSimpleTooltip(t,'RoyakGamesLab')); bindCustomTooltip($('settingsBtn'),t=>showSimpleTooltip(t,'Launcher Settings'));
$('diagnosticsClose').addEventListener('click',closeDiagnostics); $('diagnosticsBackdrop').addEventListener('pointerdown',e=>{if(e.target===$('diagnosticsBackdrop'))closeDiagnostics()});

$('playBtn').addEventListener('click',async()=>{
  const server=selectedServer(); if(!server||stateOf(server).code!==1)return;
  $('playBtn').disabled=true; setLaunchVisual('launching','PREPARING...',`Checking ${server.name}...`);
  await new Promise(r=>setTimeout(r,180)); setLaunchVisual('launching','STARTING RUNTIME...',`Loading the correct ${navigator.platform||'system'} Flash runtime...`);
  const result=await window.AV.launchGame(server);
  lastDiagnostics=result?.diagnostics||[]; lastDiagnosticGame=server.name;
  if(!result?.ok){setLaunchVisual('error','LAUNCH ERROR',result?.error||`Could not launch ${server.name}. Click the red message for diagnostics.`);$('launchMessage').onclick=()=>showDiagnostics(server.name,lastDiagnostics);launchStateTimer=setTimeout(()=>{renderSelected();setLaunchVisual('',server.ui?.playButtonText||'PLAY NOW','')},5200);return}
  setLaunchVisual('launching','LOADING GAME...',`${server.name} process started${result.pid?` • PID ${result.pid}`:''}`);
  await new Promise(r=>setTimeout(r,240)); setLaunchVisual('success','SUCCESSFULLY LAUNCHED',result.alreadyRunning?`${server.name} is already running.`:`${server.name} is running.`);
  $('launchMessage').onclick=()=>showDiagnostics(server.name,lastDiagnostics); launchStateTimer=setTimeout(()=>{renderSelected();setLaunchVisual('',server.ui?.playButtonText||'PLAY NOW','')},2600);
});
$('discordBtn').addEventListener('click',async()=>{const server=selectedServer(),url=server?.discord||server?.raw?.discord||server?.raw?.discord_url;if(url)await window.AV.openExternal(url)});

window.AV.onGameStatus(status=>{if(status?.active){const active=servers.find(s=>s.id===status.active);if(active&&rpcEnabled)window.AV.updateDiscordRpc(active,'playing').catch(()=>{})}});
init().catch(error=>{$('fallbackTitle').textContent='LAUNCHER ERROR';$('serverDescription').textContent=error.message;$('playText').textContent='ERROR';$('playBtn').disabled=true});
