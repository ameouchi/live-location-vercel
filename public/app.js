/* ===========================================================
   MAPBOX INIT
=========================================================== */
mapboxgl.accessToken = 'pk.eyJ1IjoibGFtZW91Y2hpIiwiYSI6ImNsa3ZqdHZtMDBjbTQzcXBpNzRyc2ljNGsifQ.287002jl7xT9SBub-dbBbQ';

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/lameouchi/cme04okvl00be01rydkfj6r43',
  center: [-100.3846034891744, 20],
  zoom: 1
});

// Bias camera upward so features sit higher on screen
map.on('load', () => {
  map.setPadding({ top: 20, right: 20, bottom: 280, left: 20 });
});

/* ===========================================================
   AUDIO (iOS-safe) — core helpers
=========================================================== */
let audioCtx = null, masterGain = null;
const playingSources = new Set(); // legacy looped sources (kept for compatibility)
const MAX_SIMULTANEOUS = 6;
let interactionBound = false;

function setCtxText(txt){
  const a=document.getElementById('ctxState'); if(a) a.textContent = `Audio: ${txt}`;
  const b=document.getElementById('ctxStateMobile'); if(b) b.textContent = `Audio: ${txt}`;
}
function updateCtxBadge() { if (audioCtx) setCtxText(audioCtx.state); }

function createContextIfNeeded() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 1.0;
    masterGain.connect(audioCtx.destination);

    // tiny keep-alive to reduce iOS suspends
    const keepAliveOsc = audioCtx.createOscillator();
    const keepAliveGain = audioCtx.createGain();
    keepAliveOsc.frequency.value = 30;
    keepAliveGain.gain.value = 0.0003;
    keepAliveOsc.connect(keepAliveGain).connect(masterGain);
    try { keepAliveOsc.start(); } catch {}

    audioCtx.onstatechange = updateCtxBadge;
    updateCtxBadge();
  }
}
async function ensureAudioUnlocked() {
  createContextIfNeeded();
  if (audioCtx.state === 'suspended') { try { await audioCtx.resume(); } catch {} }
  updateCtxBadge();
  return audioCtx.state;
}
function bindFirstInteractionUnlock() {
  if (interactionBound) return;
  interactionBound = true;
  const onceUnlock = async () => {
    document.removeEventListener('pointerdown', onceUnlock);
    document.removeEventListener('touchend',  onceUnlock);
    await strongUnlock();
  };
  document.addEventListener('pointerdown', onceUnlock, { once: true });
  document.addEventListener('touchend',  onceUnlock, { once: true });
}
bindFirstInteractionUnlock();

async function strongUnlock() {
  createContextIfNeeded();

  // MediaElement trick + short osc ping to unlock on mobile Safari
  const el = document.createElement('audio');
  el.src = '/zone_sound1.mp3'; el.preload = 'auto'; el.crossOrigin = 'anonymous'; el.playsInline = true; el.volume = 0.05;
  document.body.appendChild(el);
  try { const node = audioCtx.createMediaElementSource(el); node.connect(masterGain); await el.play(); } catch(e){ console.warn('MediaElement unlock failed:', e); }

  try { const osc = audioCtx.createOscillator(); const g = audioCtx.createGain(); g.gain.value=0.08; osc.frequency.value=880; osc.connect(g).connect(masterGain); osc.start(); setTimeout(()=>{try{osc.stop()}catch{}},120); } catch(e){}

  const t0 = performance.now();
  const tick = async () => {
    if (!audioCtx) return;
    if (audioCtx.state !== 'running') { try { await audioCtx.resume(); } catch {} }
    updateCtxBadge();
    if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
  };
  tick();
  setTimeout(()=>{ try{el.pause()}catch{} el.src=''; el.remove(); }, 1500);
}

/* (Legacy) decode queue — not used by Geiger, safe to keep */
const decodeQueue = []; let decoding = false;
function loadSoundQueued(url) { return new Promise((resolve)=>{ decodeQueue.push({url,resolve}); processDecodeQueue(); }); }
async function processDecodeQueue() {
  if (decoding || decodeQueue.length===0) return;
  decoding = true;
  const {url, resolve} = decodeQueue.shift();
  try {
    const res = await fetch(url, { cache:'force-cache' });
    if (!res.ok) throw new Error('HTTP '+res.status);
    const buf = await res.arrayBuffer();
    createContextIfNeeded();
    const audioBuffer = await audioCtx.decodeAudioData(buf);
    resolve(audioBuffer);
  } catch(e){ console.warn('❌ Could not load sound:', url, e.message||e); resolve(null); }
  finally { decoding=false; setTimeout(processDecodeQueue,50); }
}
async function loadSound(url){ createContextIfNeeded(); return loadSoundQueued(url); }

// Legacy loop API (not used now, but referenced by buttons)
function startZoneSound(buffer) {
  if (!buffer) return null;
  if (playingSources.size >= MAX_SIMULTANEOUS) {
    const oldest = playingSources.values().next().value;
    stopHandle(oldest); playingSources.delete(oldest);
  }
  const src = audioCtx.createBufferSource();
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0, audioCtx.currentTime);
  g.gain.linearRampToValueAtTime(1, audioCtx.currentTime + 0.15);
  src.buffer = buffer; src.loop = true;
  src.connect(g).connect(masterGain || audioCtx.destination);
  src.start(0);
  const handle = { src, gain: g };
  playingSources.add(handle);
  return handle;
}
function stopHandle(handle){
  if (!handle) return;
  try{
    const now = audioCtx.currentTime;
    handle.gain.gain.cancelScheduledValues(now);
    handle.gain.gain.setValueAtTime(handle.gain.gain.value, now);
    handle.gain.gain.linearRampToValueAtTime(0, now + 0.12);
    setTimeout(()=>{ try{ handle.src.stop(0); handle.src.disconnect(); handle.gain.disconnect(); } catch{} playingSources.delete(handle); },130);
  }catch{}
}
function stopAllSounds(){
  try{
    for (const h of Array.from(playingSources)) {
      try { h.gain?.gain?.setValueAtTime?.(0, audioCtx?.currentTime || 0); } catch {}
      try { h.src?.stop?.(0); } catch {}
      try { h.src?.disconnect?.(); } catch {}
      try { h.gain?.disconnect?.(); } catch {}
      playingSources.delete(h);
    }
  }catch{}
}

/* ===========================================================
   DETERMINISTIC GEIGER CLICKS (rate ∝ DN)
   - DN range expected ~ [-11 .. -1]
   - Lower DN (closer to dataset MIN) => higher click rate
=========================================================== */
const RATE_MIN_HZ = 1.0;   // slowest click rate (near DN max ≈ -1)
const RATE_MAX_HZ = 18.0;  // fastest click rate (near DN min ≈ -11)
const RATE_GAMMA  = 1.15;  // curve shaping (1 = linear; >1 ramps faster near DN min)

// Map DN to clicks/second: t=0 at DN max (-1), t=1 at DN min (-11)
function dnToRateHz(dn, dnMin, dnMax){
  const tRaw = (dn - dnMax) / (dnMin - dnMax);
  const t = Math.min(1, Math.max(0, tRaw));
  const shaped = Math.pow(t, RATE_GAMMA);
  return RATE_MIN_HZ + shaped * (RATE_MAX_HZ - RATE_MIN_HZ);
}

// One Geiger "click" (short filtered-noise burst)
function geigerClick(vol = 0.14){
  if (!audioCtx) return;
  const dur = 0.022; // ~22ms burst
  const sr  = audioCtx.sampleRate;
  const buf = audioCtx.createBuffer(1, Math.ceil(sr*dur), sr);
  const ch  = buf.getChannelData(0);
  for (let i=0;i<ch.length;i++){ ch[i] = (Math.random()*2 - 1); } // white noise

  const src = audioCtx.createBufferSource(); src.buffer = buf;

  // bandpass ~2kHz for classic Geiger timbre
  const bp  = audioCtx.createBiquadFilter(); bp.type = 'bandpass';
  bp.frequency.value = 1800 + Math.random()*1200; // small variance
  bp.Q.value = 8;

  const g = audioCtx.createGain();
  const now = audioCtx.currentTime;
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(vol, now + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.020);

  src.connect(bp).connect(g).connect(masterGain || audioCtx.destination);
  src.start(now);
  src.stop(now + 0.03);
}

// Per-zone deterministic timers
const cellTimers = []; // [{ id:number, hz:number }] parallel to bedrockZones

function startCellClicks(i, dn){
  createContextIfNeeded();
  const hz = dnToRateHz(dn, map.__DN_MIN__ ?? -11, map.__DN_MAX__ ?? -1);
  const periodMs = Math.max(20, 1000 / Math.max(0.001, hz));

  stopCellClicks(i); // reset if exists
  const id = setInterval(()=> geigerClick(0.14), periodMs);
  cellTimers[i] = { id, hz };
}
function stopCellClicks(i){
  const t = cellTimers[i];
  if (t && t.id){ clearInterval(t.id); }
  cellTimers[i] = null;
}
function stopAllCellClicks(){
  for (let i = 0; i < cellTimers.length; i++){ stopCellClicks(i); }
}

/* ===========================================================
   MAP / DATA
=========================================================== */
let bedrockZones=[], zoneFlags=[], zoneBBoxes=[];
let drawnCoords=[], isDrawing=false;

map.on('load', async () => {
  const loadGeo = async (file) => (await fetch(file)).json();

  const bedrock = await loadGeo('acequia.geojson');
  bedrockZones = bedrock.features || [];
  zoneBBoxes = bedrockZones.map(f => turf.bbox(f));

  const dns = bedrockZones.map(f => f?.properties?.DN).filter(Number.isFinite);
  const [min,max] = dns.length ? [Math.min(...dns), Math.max(...dns)] : [-11,-1]; // expected [-11 .. -1]

  // Save DN range for the audio mapping
  map.__DN_MIN__ = min;
  map.__DN_MAX__ = max;

  // Make timers/flags parallel to features
  cellTimers.length = bedrockZones.length;
  zoneFlags   = new Array(bedrockZones.length).fill(false);

  /* ---------- MAGMA GRADIENT SETUP (INVERTED) ---------- */
  const INVERT_SCALE = true;

  const MAGMA = [
    '#000004','#1b0c41','#4f0c6b','#781c6d',
    '#a02c60','#c43c4e','#e16462','#f2844b',
    '#fca636','#fcce25'
  ];
  function rampStops(minVal, maxVal, colors){
    const out = [];
    for (let i=0;i<colors.length;i++){
      const t = i / (colors.length - 1);
      out.push(minVal + t*(maxVal - minVal), colors[i]);
    }
    return out;
  }
  const palette = INVERT_SCALE ? MAGMA.slice().reverse() : MAGMA;
  const magmaStops = rampStops(min, max, palette);

  map.addSource('bedrock', { type:'geojson', data: bedrock });
  map.addLayer({
    id:'bedrock', type:'fill', source:'bedrock',
    paint:{
      'fill-color': ['interpolate', ['linear'], ['get','DN'], ...magmaStops],
      'fill-opacity': 0.75,
      'fill-outline-color': 'rgba(255,255,255,0.25)'
    }
  });

  map.addSource('live-lines', { type:'geojson', data:{ type:'FeatureCollection', features:[] }});
  map.addLayer({ id:'live-lines', type:'line', source:'live-lines', paint:{ 'line-color':'#FF0000', 'line-width':4 } });

  if (bedrock.features?.length) {
    map.fitBounds(turf.bbox(bedrock), {
      padding: { top: 20, right: 20, bottom: 280, left: 20 }
    });
  }

  // Optional legend ramp to match inverted palette direction
  const legend = document.getElementById('legend');
  if (legend){
    legend.style.background = `linear-gradient(to left, ${MAGMA.join(',')})`;
    legend.style.border = '1px solid rgba(255,255,255,0.35)';
  }

  updateLegendPosition();
});

async function checkSoundZones(pt) {
  for (let i=0; i<bedrockZones.length; i++){
    const feature = bedrockZones[i];

    // bbox quick reject
    const [minX,minY,maxX,maxY] = zoneBBoxes[i] || [];
    const [x,y] = pt.geometry.coordinates;
    if (zoneBBoxes[i] && (x<minX || x>maxX || y<minY || y>maxY)){
      if (zoneFlags[i]) { stopCellClicks(i); zoneFlags[i]=false; }
      continue;
    }

    const isInside = turf.booleanPointInPolygon(pt, feature);

    if (isInside && !zoneFlags[i]) {
      const dn = feature.properties?.DN;
      if (Number.isFinite(dn)) {
        await ensureAudioUnlocked();
        startCellClicks(i, dn); // rate depends on DN (deterministic)
        zoneFlags[i] = true;
      }
    } else if (!isInside && zoneFlags[i]) {
      stopCellClicks(i);
      zoneFlags[i] = false;
    }
  }
}

/* Robust live update (avoids JSON parse when server returns HTML) */
async function updateMap() {
  try {
    const res = await fetch('/api/geo', { cache:'no-store' });

    if (!res.ok) {
      console.warn('GET /api/geo failed:', res.status, res.statusText);
      const src = map.getSource('live-lines');
      if (src) src.setData({ type:'FeatureCollection', features:[] });
      return;
    }

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    let data;
    if (ct.includes('application/json')) {
      data = await res.json();
    } else {
      console.warn('GET /api/geo returned non-JSON content-type:', ct);
      data = { type:'FeatureCollection', features:[] };
    }

    const src = map.getSource('live-lines');
    if (src) src.setData(data);

    // People lists (desktop + mobile)
    const names = new Set((data.features||[]).map(f => f.properties?.name).filter(Boolean));
    const renderList = (ul) => {
      if (!ul) return; ul.innerHTML='';
      [...names].sort().forEach(n => { const li=document.createElement('li'); li.textContent=n; ul.appendChild(li); });
    };
    renderList(document.getElementById('peopleList'));
    renderList(document.getElementById('peopleList_m'));

    // Trigger Geiger checks at latest point of each line
    (data.features||[]).forEach(feature => {
      const coords = feature?.geometry?.coordinates;
      if (coords && coords.length) {
        const lastCoord = coords[coords.length - 1];
        const pt = turf.point(lastCoord);
        checkSoundZones(pt);
      }
    });

  } catch (err) {
    console.error('Error updating live data', err);
    const src = map.getSource('live-lines');
    if (src) src.setData({ type:'FeatureCollection', features:[] });
  }
}

/* Draw tool */
map.on('click', (e) => {
  if (!isDrawing) return;
  drawnCoords.push([e.lngLat.lng, e.lngLat.lat]);
  const line = { type:'FeatureCollection', features:[{ type:'Feature', geometry:{ type:'LineString', coordinates: drawnCoords } }] };
  const src = map.getSource('live-lines'); if (src) src.setData(line);
});
document.getElementById('drawBtn').onclick  = () => { isDrawing=true; drawnCoords=[]; };
document.getElementById('clearBtn').onclick = () => {
  isDrawing=false; drawnCoords=[];
  const src = map.getSource('live-lines'); if (src) src.setData({ type:'FeatureCollection', features:[] });
  stopAllCellClicks(); // stop DN-driven clicks
  stopAllSounds();     // stop any legacy loops
};

async function updateSimulation(){
  if (!drawnCoords.length) return;
  const pt = turf.point(drawnCoords[drawnCoords.length-1]);
  await ensureAudioUnlocked();
  await checkSoundZones(pt);
}

/* ===========================================================
   CONTROLS  (desktop and mobile mirror to same handlers)
=========================================================== */
let mainTimer=null;
function startMain(){
  strongUnlock().then(()=>{
    // optional legacy preloads; not required for clicks
    ['/zone_sound1.mp3','/zone_sound2.mp3','/zone_sound3.mp3'].forEach(loadSound);
    if (mainTimer) return;
    let lastResume=0;
    mainTimer=setInterval(async ()=>{
      if (audioCtx && audioCtx.state!=='running'){
        const now=performance.now();
        if (now-lastResume>1000){ try{await audioCtx.resume();}catch{} lastResume=now; updateCtxBadge(); }
      }
      updateSimulation(); updateMap();
    }, 1200);
  });
}
function stopMain(){
  stopAllCellClicks();
  stopAllSounds();
  if (mainTimer){ clearInterval(mainTimer); mainTimer=null; }
}

function enableAudio(){ strongUnlock().then(()=>alert('Sound enabled. If still silent on iPhone, set Ring switch to RING and raise volume.')); }
async function testMp3(){
  const el=new Audio('/zone_sound1.mp3'); el.playsInline=true; el.crossOrigin='anonymous';
  try{ await el.play(); }catch(e){ console.warn('MP3 test failed', e); }
  setTimeout(()=>{ try{el.pause(); el.src='';}catch{} }, 1500);
}

/* Hook desktop buttons */
document.getElementById('startBtn')?.addEventListener('click', startMain);
document.getElementById('stopBtn') ?.addEventListener('click', stopMain);
document.getElementById('enableAudioBtn')?.addEventListener('click', enableAudio);
document.getElementById('testMp3Btn')   ?.addEventListener('click', testMp3);

/* Hook mobile sheet buttons */
document.getElementById('startBtn_m')?.addEventListener('click', startMain);
document.getElementById('stopBtn_m') ?.addEventListener('click', stopMain);
document.getElementById('enableAudioBtn_m')?.addEventListener('click', enableAudio);
document.getElementById('testMp3Btn_m')   ?.addEventListener('click', testMp3);

/* Layer toggle */
function toggleLayer(id, btnId, label) {
  const vis = map.getLayoutProperty(id, 'visibility') || 'visible';
  const newVis = vis === 'visible' ? 'none' : 'visible';
  map.setLayoutProperty(id, 'visibility', newVis);
  const btn = document.getElementById(btnId);
  if (btn) btn.textContent = `${label}: ${newVis === 'visible' ? 'ENCENDIDA' : 'APAGADA'}`;
}
document.getElementById('bedrockToggle').onclick = () => toggleLayer('bedrock','bedrockToggle','Acequia');

/* Location sharing (desktop + mobile) */
const elName   = document.getElementById('name');
const elShare  = document.getElementById('shareLocationBtn');
const elStopSh = document.getElementById('stopSharingBtn');

const elNameM  = document.getElementById('name_m');
const elShareM = document.getElementById('shareLocationBtn_m');
const elStopSM = document.getElementById('stopSharingBtn_m');

let watchId=null, lastSentAt=0, lastCoords=null;

function isSecureContextForGeo(){ return location.protocol==='https:' || ['localhost','127.0.0.1'].includes(location.hostname); }
function requestGeoOnce(){
  return new Promise((resolve,reject)=>{
    navigator.geolocation.getCurrentPosition(()=>resolve(true),(e)=>reject(e),{enableHighAccuracy:true,timeout:8000,maximumAge:0});
  });
}
async function startSharing(nameInput, shareBtn, stopBtn){
  const name = nameInput.value.trim();
  if (!name) return alert('Enter your name');
  if (!('geolocation' in navigator)) return alert('Geolocation not supported.');
  if (!isSecureContextForGeo()) return alert('Use HTTPS or localhost for mobile GPS.');
  try { await requestGeoOnce(); } catch(e){ console.error(e); return alert('Location permission denied or unavailable.'); }

  shareBtn.style.display='none'; stopBtn.style.display='inline-block'; nameInput.disabled=true;

  const MIN_INTERVAL_MS=2000;
  watchId = navigator.geolocation.watchPosition(async (pos)=>{
    const now=Date.now();
    const coords={lat:pos.coords.latitude, lng:pos.coords.longitude};
    const same = lastCoords && Math.abs(coords.lat-lastCoords.lat)<1e-7 && Math.abs(coords.lng-lastCoords.lng)<1e-7;
    if (now-lastSentAt<MIN_INTERVAL_MS && same) return;
    lastCoords=coords; lastSentAt=now;
    try{
      const res=await fetch('/api/geo',{ method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name, coords, timestamp:now}), keepalive:true });
      if(!res.ok) console.warn('POST /api/geo failed:', res.status, res.statusText);
    }catch(err){ console.warn('Sending location failed:', err); }
  }, (err)=>{
    console.error('watchPosition error:', err);
    alert('Location error: ' + (err.message||err));
    stopSharing(nameInput, shareBtn, stopBtn);
  }, { enableHighAccuracy:true, maximumAge:0, timeout:10000 });
}
function stopSharing(nameInput, shareBtn, stopBtn){
  if (watchId!==null){ navigator.geolocation.clearWatch(watchId); watchId=null; }
  shareBtn.style.display='inline-block'; stopBtn.style.display='none'; nameInput.disabled=false;
}

elShare?.addEventListener('click', ()=>startSharing(elName, elShare, elStopSh));
elStopSh?.addEventListener('click', ()=>stopSharing(elName, elShare, elStopSh));
elShareM?.addEventListener('click', ()=>startSharing(elNameM, elShareM, elStopSM));
elStopSM?.addEventListener('click', ()=>stopSharing(elNameM, elShareM, elStopSM));

window.addEventListener('pagehide', ()=>{
  try{ navigator.sendBeacon?.('/api/geo', JSON.stringify({ name:(elName?.value||elNameM?.value||'').trim(), stop:true, timestamp:Date.now() })); }catch{}
  stopAllCellClicks(); // ensure timers stop when navigating away
});

/* ===========================================================
   LEGEND POSITIONING — always above #sheet
=========================================================== */
function updateLegendPosition() {
  const legend = document.getElementById('legend');
  if (!legend) return;
  const sheet  = document.getElementById('sheet');

  const GAP_PX   = 10;  // distance above the sheet
  const MIN_PX   = 12;  // fallback when sheet is hidden/desktop

  if (sheet && getComputedStyle(sheet).display !== 'none') {
    const rect = sheet.getBoundingClientRect(); // accounts for transform while dragging
    const bottom = Math.max(MIN_PX, Math.round(window.innerHeight - rect.top + GAP_PX));
    legend.style.position = 'fixed';
    legend.style.left = '50%';
    legend.style.transform = 'translateX(-50%)';
    legend.style.bottom = `${bottom}px`;
  } else {
    legend.style.position = 'fixed';
    legend.style.left = '50%';
    legend.style.transform = 'translateX(-50%)';
    legend.style.bottom = `${MIN_PX}px`;
  }
}

/* ===========================================================
   MOBILE SHEET BEHAVIOR (expand/collapse)
=========================================================== */
const sheet = document.getElementById('sheet');
const handle = document.getElementById('sheetHandle');
let sheetOpen = true;

function setSheet(open){
  sheetOpen = open;
  // collapsed = 52px height, open = natural height
  sheet.style.transform = open ? 'translateY(0)' : 'translateY(calc(100% - 52px))';
  updateLegendPosition(); // keep legend pinned above sheet
}
setSheet(true); // start open on first load
updateLegendPosition();

let startY=0, startT=0, dragging=false;
function onStart(e){ dragging=true; startY=(e.touches?e.touches[0].clientY:e.clientY); startT=sheet.getBoundingClientRect().top; }
function onMove(e){
  if(!dragging) return;
  const y = e.touches ? e.touches[0].clientY : e.clientY;
  const dy=Math.max(0, y-startY);
  const h=window.innerHeight;
  const target = Math.min(h-52, startT+dy);
  sheet.style.transform = `translateY(${Math.max(0, target)}px)`;
  updateLegendPosition(); // live update while dragging
}
function onEnd(){
  if(!dragging) return;
  dragging=false;
  const rect=sheet.getBoundingClientRect();
  const h=window.innerHeight;
  const opened = rect.top < h*0.6; // snap
  setSheet(opened);
}
handle.addEventListener('mousedown', onStart); document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onEnd);
handle.addEventListener('touchstart', onStart, {passive:true}); document.addEventListener('touchmove', onMove, {passive:true}); document.addEventListener('touchend', onEnd);

// Keep legend correct on viewport changes
window.addEventListener('resize', updateLegendPosition);
window.addEventListener('orientationchange', updateLegendPosition);

/* ===========================================================
   VISIBILITY RESUME
=========================================================== */
document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible') { try { await ensureAudioUnlocked(); } catch {} }});
window.addEventListener('focus', async () => { try { await ensureAudioUnlocked(); } catch {} });
