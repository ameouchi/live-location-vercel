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

map.on('load', () => {
  map.setPadding({ top: 20, right: 20, bottom: 280, left: 20 });
});

/* ===========================================================
   AUDIO (iOS-safe) — core helpers
=========================================================== */
let audioCtx = null, masterGain = null;
const playingSources = new Set(); // active loop handles
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

    // tiny keep-alive to reduce iOS suspensions
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

/* ===========================================================
   BUFFER LOADING & LOOPED SOURCES
=========================================================== */
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
=========================================================== */
const RATE_MIN_HZ = 1.0;
const RATE_MAX_HZ = 18.0;
const RATE_GAMMA  = 1.15;

function dnToRateHz(dn, dnMin, dnMax){
  const tRaw = (dn - dnMax) / (dnMin - dnMax); // 0 at max, 1 at min
  const t = Math.min(1, Math.max(0, tRaw));
  const shaped = Math.pow(t, RATE_GAMMA);
  return RATE_MIN_HZ + shaped * (RATE_MAX_HZ - RATE_MIN_HZ);
}

function geigerClick(vol = 0.14){
  if (!audioCtx) return;
  const dur = 0.022;
  const sr  = audioCtx.sampleRate;
  const buf = audioCtx.createBuffer(1, Math.ceil(sr*dur), sr);
  const ch  = buf.getChannelData(0);
  for (let i=0;i<ch.length;i++){ ch[i] = (Math.random()*2 - 1); }

  const src = audioCtx.createBufferSource(); src.buffer = buf;

  const bp  = audioCtx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1800 + Math.random()*1200;
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

const cellTimers = [];
function startCellClicks(i, dn){
  createContextIfNeeded();
  const hz = dnToRateHz(dn, map.__DN_MIN__ ?? -11, map.__DN_MAX__ ?? -1);
  const periodMs = Math.max(20, 1000 / Math.max(0.001, hz));
  stopCellClicks(i);
  const id = setInterval(()=> geigerClick(0.14), periodMs);
  cellTimers[i] = { id, hz, dn };
  console.info(`[AUDIO] Zone ${i} (DN ${dn}) → Geiger ${hz.toFixed(2)} Hz`);
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
   SOUND MODE TOGGLE (Loops ↔ Geiger) with 11 MP3s
=========================================================== */
const SOUND_MODES = { LOOPS:'LOOPS', GEIGER:'GEIGER' };
let SOUND_MODE = SOUND_MODES.GEIGER;

const SOUND_FILE_COUNT = 11;

function dnToSoundIndex(dn, dnMin = -11, dnMax = -1){
  const t = Math.min(1, Math.max(0, (dn - dnMin) / (dnMax - dnMin)));
  return 1 + Math.round(t * (SOUND_FILE_COUNT - 1));
}

const soundCache = new Map(); // idx -> AudioBuffer|null
async function getSoundBuffer(idx){
  if (soundCache.has(idx)) return soundCache.get(idx);
  const url = `/zone_sound${idx}.mp3`;
  const buf = await loadSound(url);
  soundCache.set(idx, buf);
  return buf;
}

let loopHandles = [], loopMeta = [];

async function startLoopsForIndex(i, dn){
  const idx = dnToSoundIndex(dn, map.__DN_MIN__ ?? -11, map.__DN_MAX__ ?? -1);
  const url = `/zone_sound${idx}.mp3`;
  const buf = await getSoundBuffer(idx);
  if (buf) {
    const h = startZoneSound(buf);
    loopHandles[i] = h;
    loopMeta[i] = { idx, url, dn };
    console.info(`[AUDIO] Zone ${i} (DN ${dn}) → ${url}`);
  }
}
function stopLoopsForIndex(i){
  const h = loopHandles[i];
  if (h){ try{ stopHandle(h); }catch{} }
  loopHandles[i]=null;
  loopMeta[i]=null;
}

function stopAllModes(){
  stopAllCellClicks();
  for (let i=0;i<loopHandles.length;i++) stopLoopsForIndex(i);
  stopAllSounds();
}

function setSoundMode(mode){
  if (mode === SOUND_MODE) return;
  SOUND_MODE = mode;
  const btn = document.getElementById('toggleSoundModeBtn');
  if (btn) btn.textContent = SOUND_MODE === SOUND_MODES.GEIGER ? 'GEIGER' : 'LOOPS';
  stopAllModes();
  if (zoneFlags?.length){ for (let i=0;i<zoneFlags.length;i++) zoneFlags[i]=false; }
  updateSimulation();
}
function toggleSoundMode(){
  setSoundMode(SOUND_MODE === SOUND_MODES.GEIGER ? SOUND_MODES.LOOPS : SOUND_MODES.GEIGER);
}
function ensureModeButton(){
  let chip = document.querySelector('.chip');
  if (!chip){
    chip = document.createElement('div');
    chip.className = 'chip';
    chip.style.position='absolute'; chip.style.top='12px'; chip.style.left='12px'; chip.style.zIndex='999';
    document.body.appendChild(chip);
  }
  let btn = document.getElementById('toggleSoundModeBtn');
  if (!btn){
    btn = document.createElement('button');
    btn.id = 'toggleSoundModeBtn';
    btn.className = 'ghost';
    btn.addEventListener('click', toggleSoundMode);
    chip.appendChild(btn);
  }
  btn.textContent = SOUND_MODE === SOUND_MODES.GEIGER ? 'GEIGER' : 'LOOPS';
}

/* ===========================================================
   ACTIVE-ZONE RECONCILER
=========================================================== */
function startZoneByIndex(i){
  const dn = bedrockZones[i]?.properties?.DN;
  if (!Number.isFinite(dn)) return;
  if (SOUND_MODE === SOUND_MODES.GEIGER) startCellClicks(i, dn);
  else startLoopsForIndex(i, dn);
  zoneFlags[i] = true;
}
function stopZoneByIndex(i){
  if (SOUND_MODE === SOUND_MODES.GEIGER) stopCellClicks(i);
  else stopLoopsForIndex(i);
  zoneFlags[i] = false;
}

function computeZonesForPoint(pt, outSet){
  const [x,y] = pt.geometry.coordinates;
  for (let i=0; i<bedrockZones.length; i++){
    const bbox = zoneBBoxes[i];
    if (bbox && bbox.length === 4){
      const [minX,minY,maxX,maxY] = bbox;
      if (x<minX || x>maxX || y<minY || y>maxY) continue;
    }
    try{
      if (turf.booleanPointInPolygon(pt, bedrockZones[i], { ignoreBoundary: true })) {
        outSet.add(i);
      }
    } catch {}
  }
}

function reconcileActiveZones(activeSet){
  for (let i=0; i<bedrockZones.length; i++){
    const shouldBeOn = activeSet.has(i);
    if (shouldBeOn && !zoneFlags[i]) startZoneByIndex(i);
    else if (!shouldBeOn && zoneFlags[i]) stopZoneByIndex(i);
  }
}

async function updateActiveZonesFromPoints(points){
  await ensureAudioUnlocked();
  const active = new Set();
  for (const pt of points) computeZonesForPoint(pt, active);
  reconcileActiveZones(active);
}

/* ===========================================================
   MAP / DATA
=========================================================== */
let bedrockZones=[], zoneFlags=[], zoneBBoxes=[];
let drawnCoords=[], isDrawing=false;

map.on('load', async () => {
  ensureModeButton();

  const loadGeo = async (file) => (await fetch(file)).json();
  const bedrock = await loadGeo('acequia.geojson');
  bedrockZones = bedrock.features || [];
  zoneBBoxes = bedrockZones.map(f => turf.bbox(f));

  const dns = bedrockZones.map(f => f?.properties?.DN).filter(Number.isFinite);
  const [min,max] = dns.length ? [Math.min(...dns), Math.max(...dns)] : [-11,-1];

  map.__DN_MIN__ = min;
  map.__DN_MAX__ = max;

  cellTimers.length = bedrockZones.length;
  loopHandles  = new Array(bedrockZones.length).fill(null);
  loopMeta     = new Array(bedrockZones.length).fill(null);
  zoneFlags    = new Array(bedrockZones.length).fill(false);

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

  // --- Add GeoTIFF layer (starts hidden) ---
  await addGeoTiffLayer(); // safe to call even if button not present yet
});

/* ===========================================================
   LIVE UPDATE
=========================================================== */
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

    // Build union of zones for last points of every line, reconcile once
    const points = [];
    (data.features||[]).forEach(feature => {
      const coords = feature?.geometry?.coordinates;
      if (coords && coords.length) {
        points.push(turf.point(coords[coords.length - 1]));
      }
    });
    await updateActiveZonesFromPoints(points);

  } catch (err) {
    console.error('Error updating live data', err);
    const src = map.getSource('live-lines');
    if (src) src.setData({ type:'FeatureCollection', features:[] });
  }
}

/* ===========================================================
   DRAW TOOL
=========================================================== */
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
  stopAllModes();
};

async function updateSimulation(){
  if (!drawnCoords.length) return;
  const pt = turf.point(drawnCoords[drawnCoords.length-1]);
  await updateActiveZonesFromPoints([pt]);
}

/* ===========================================================
   CONTROLS
=========================================================== */
let mainTimer=null;
function startMain(){
  strongUnlock().then(()=>{
    for (let i=1;i<=SOUND_FILE_COUNT;i++) getSoundBuffer(i);
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
  stopAllModes();
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

// Sound mode toggle hooks (desktop + mobile)
document.getElementById('toggleSoundModeBtn')?.addEventListener('click', toggleSoundMode);
document.getElementById('toggleSoundModeBtn_m')?.addEventListener('click', toggleSoundMode);

/* Layer toggle helper (reused for GeoTIFF button) */
function toggleLayer(id, btnId, label) {
  const vis = map.getLayoutProperty(id, 'visibility') || 'visible';
  const newVis = vis === 'visible' ? 'none' : 'visible';
  map.setLayoutProperty(id, 'visibility', newVis);
  const btn = document.getElementById(btnId);
  if (btn) btn.textContent = `${label}: ${newVis === 'visible' ? 'ENCENDIDA' : 'APAGADA'}`;
}

/* Existing bedrock toggle */
document.getElementById('bedrockToggle')?.addEventListener('click', () =>
  toggleLayer('bedrock','bedrockToggle','Acequia')
);

/* ===========================================================
   LOCATION SHARING
=========================================================== */
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
  stopAllModes();
});

/* ===========================================================
   LEGEND POSITIONING
=========================================================== */
function updateLegendPosition() {
  const legend = document.getElementById('legend');
  if (!legend) return;
  const sheet  = document.getElementById('sheet');

  const GAP_PX   = 10;
  const MIN_PX   = 12;

  if (sheet && getComputedStyle(sheet).display !== 'none') {
    const rect = sheet.getBoundingClientRect();
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
   MOBILE SHEET
=========================================================== */
const sheet = document.getElementById('sheet');
const handle = document.getElementById('sheetHandle');
let sheetOpen = true;

function setSheet(open){
  sheetOpen = open;
  sheet.style.transform = open ? 'translateY(0)' : 'translateY(calc(100% - 52px))';
  updateLegendPosition();
}
setSheet(true);
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
  updateLegendPosition();
}
function onEnd(){
  if(!dragging) return;
  dragging=false;
  const rect=sheet.getBoundingClientRect();
  const h=window.innerHeight;
  const opened = rect.top < h*0.6;
  setSheet(opened);
}
handle.addEventListener('mousedown', onStart); document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onEnd);
handle.addEventListener('touchstart', onStart, {passive:true}); document.addEventListener('touchmove', onMove, {passive:true}); document.addEventListener('touchend', onEnd);

window.addEventListener('resize', updateLegendPosition);
window.addEventListener('orientationchange', updateLegendPosition);

/* ===========================================================
   VISIBILITY RESUME
=========================================================== */
document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible') { try { await ensureAudioUnlocked(); } catch {} }});
window.addEventListener('focus', async () => { try { await ensureAudioUnlocked(); } catch {} });

/* ===========================================================
   GEO-TIFF OVERLAY (resilient loader + toggle)
=========================================================== */
const GEO_TIFF_URL = '/geologic.tif'; // <-- must be a PUBLIC URL your browser can GET

function loadScriptOnce(src){
  return new Promise((resolve, reject)=>{
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function headOrGet(url){
  // Try HEAD (some hosts disallow it); fall back to GET with no-cache
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return { ok: r.ok, status: r.status, headers: r.headers };
  } catch {
    try {
      const r = await fetch(url, { method: 'GET', cache: 'no-store' });
      return { ok: r.ok, status: r.status, headers: r.headers };
    } catch (e) {
      return { ok: false, error: e };
    }
  }
}

let geotiffReady = false;
async function addGeoTiffLayer(){
  const srcId = 'geotiff-image';
  const layerId = 'geotiff-layer';

  try{
    // Load geotiff.js (remove if you bundle it yourself)
    await loadScriptOnce('https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.min.js');

    // Quick preflight so errors are obvious
    const probe = await headOrGet(GEO_TIFF_URL);
    if (!probe.ok) {
      console.error('[GeoTIFF] Fetch preflight failed', probe);
      throw new Error(`HTTP ${probe.status || 'fetch failed'} — check URL/CORS`);
    } else {
      const ar = probe.headers?.get?.('accept-ranges');
      console.log('[GeoTIFF] Preflight OK:', {
        status: probe.status,
        'content-type': probe.headers?.get?.('content-type'),
        'accept-ranges': ar || '(none)'
      });
    }

    // Try 1: fromUrl with full-file allowed (works even if Range unsupported)
    let tiff;
    try {
      tiff = await GeoTIFF.fromUrl(GEO_TIFF_URL, {
        allowFullFile: true,
        fetchOptions: { mode: 'cors', credentials: 'omit', cache: 'no-store' }
      });
    } catch (e1) {
      console.warn('[GeoTIFF] fromUrl failed, falling back to arrayBuffer:', e1);
      // Try 2: manual fetch + fromArrayBuffer (avoids range requests entirely)
      const res = await fetch(GEO_TIFF_URL, { cache: 'no-store', mode: 'cors' });
      if (!res.ok) throw new Error(`GET ${res.status} ${res.statusText}`);
      const buf = await res.arrayBuffer();
      tiff = await GeoTIFF.fromArrayBuffer(buf);
    }

    const image = await tiff.getImage();
    const [minX, minY, maxX, maxY] = image.getBoundingBox(); // assumes lon/lat degrees
    const width  = image.getWidth();
    const height = image.getHeight();

    // Read interleaved; normalize to RGBA
    let rasters = await image.readRasters({ interleave: true });
    let spp = image.getSamplesPerPixel();

    if (spp === 3){
      const rgba = new Uint8ClampedArray(width*height*4);
      for (let p=0,q=0; p<rgba.length; p+=4, q+=3){
        rgba[p]   = rasters[q];
        rgba[p+1] = rasters[q+1];
        rgba[p+2] = rasters[q+2];
        rgba[p+3] = 255;
      }
      rasters = rgba; spp = 4;
    } else if (spp === 1){
      const rgba = new Uint8ClampedArray(width*height*4);
      for (let p=0,q=0; p<rgba.length; p+=4, q++){
        const v = rasters[q] & 0xFF;
        rgba[p] = rgba[p+1] = rgba[p+2] = v;
        rgba[p+3] = 255;
      }
      rasters = rgba; spp = 4;
    } else if (spp === 4 && !(rasters instanceof Uint8ClampedArray)){
      rasters = new Uint8ClampedArray(rasters.buffer); // ensure correct view
    }

    // Draw to canvas (downscale if huge)
    const MAX_DIM = 4096;
    const scale = Math.min(1, MAX_DIM / Math.max(width, height));
    const outW = Math.max(1, Math.round(width * scale));
    const outH = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = outW; canvas.height = outH;
    const ctx = canvas.getContext('2d');

    if (scale === 1){
      ctx.putImageData(new ImageData(rasters, width, height), 0, 0);
    } else {
      const tmp = document.createElement('canvas');
      tmp.width = width; tmp.height = height;
      tmp.getContext('2d').putImageData(new ImageData(rasters, width, height), 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmp, 0, 0, outW, outH);
    }

    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    const url = URL.createObjectURL(blob);

    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(srcId)) map.removeSource(srcId);

    map.addSource(srcId, {
      type: 'image',
      url,
      coordinates: [
        [minX, maxY], // top-left
        [maxX, maxY], // top-right
        [maxX, minY], // bottom-right
        [minX, minY]  // bottom-left
      ]
    });
    map.addLayer({
      id: layerId,
      type: 'raster',
      source: srcId,
      paint: { 'raster-opacity': 0.8 }
    });

    // Start hidden; hook up the toggle button if present
    map.setLayoutProperty(layerId, 'visibility', 'none');
    const btn = document.getElementById('geotiffToggle');
    if (btn){
      btn.onclick = () => toggleLayer(layerId, 'geotiffToggle', 'GeoTIFF');
      btn.textContent = 'GeoTIFF: APAGADA';
      btn.disabled = false;
    }

    geotiffReady = true;
    console.log('[GeoTIFF] layer added', { bbox:[minX,minY,maxX,maxY], size:[outW,outH] });

  } catch (e){
    console.error('Failed to add GeoTIFF layer:', e);
    const btn = document.getElementById('geotiffToggle');
    if (btn){ btn.disabled = true; btn.textContent = 'GeoTIFF: ERROR'; }
  }
}

