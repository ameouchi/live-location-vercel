/* ===========================================================
   MAP INIT  (reuse your token/style)
=========================================================== */
mapboxgl.accessToken =
  'pk.eyJ1IjoibGFtZW91Y2hpIiwiYSI6ImNsa3ZqdHZtMDBjbTQzcXBpNzRyc2ljNGsifQ.287002jl7xT9SBub-dbBbQ';

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/lameouchi/cme04okvl00be01rydkfj6r43',
  center: [-100.3846034891744, 20],
  zoom: 1
});

map.on('load', () => {
  map.setPadding({ top: 64, right: 20, bottom: 280, left: 260 });

  // sources/layers to show saved trajectories + heads
  map.addSource('saved-all', { type:'geojson', data:{ type:'FeatureCollection', features:[] }});
  map.addLayer({
    id:'saved-all',
    type:'line',
    source:'saved-all',
    paint:{ 'line-color':'#0e01f5', 'line-width':3, 'line-opacity':0.85 }
  });

  map.addSource('saved-heads', { type:'geojson', data:{ type:'FeatureCollection', features:[] }});
  map.addLayer({
    id:'saved-heads',
    type:'circle',
    source:'saved-heads',
    paint:{
      'circle-radius': 5,
      'circle-color': '#ffffff',
      'circle-stroke-color': '#0e01f5',
      'circle-stroke-width': 3
    }
  });

  // initial load
  fetchSaved();
});

/* ===========================================================
   DOM helpers
=========================================================== */
const $ = (id)=>document.getElementById(id);

/* Keep desktop/mobile in sync */
function readTimeInputs(){
  const t0 = tsFromLocalInput($('startTime')) || tsFromLocalInput($('startTime_m'));
  const t1 = tsFromLocalInput($('endTime'))   || tsFromLocalInput($('endTime_m'));
  return [t0, t1];
}
function tsFromLocalInput(el){
  if (!el || !el.value) return null;
  const d = new Date(el.value);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

/* ===========================================================
   DATA + FILTER STATE
=========================================================== */
let rawFC = { type:'FeatureCollection', features:[] };   // normalized (has __pts)
let filteredFC = { type:'FeatureCollection', features:[] };

const peopleSet = new Set();
let selectedOne = '__ALL__';   // dropdown selection

function getSelectedPeopleSet(){
  if (selectedOne === '__ALL__') return peopleSet;
  return new Set([selectedOne]);
}

/* ===========================================================
   PEOPLE DROPDOWN
=========================================================== */
function buildPeopleDropdowns(){
  const options = Array.from(peopleSet).sort((a,b)=>a.localeCompare(b,'en',{sensitivity:'base'}));
  const fill = (selId) => {
    const sel = $(selId);
    if (!sel) return;
    const keep = sel.value || '__ALL__';
    sel.innerHTML = '<option value="__ALL__">Todos</option>' +
      options.map(n => `<option value="${n}">${n}</option>`).join('');
    sel.value = keep && (keep === '__ALL__' || peopleSet.has(keep)) ? keep : '__ALL__';
  };
  fill('peopleSelect');
  fill('peopleSelect_m');
}

/* ===========================================================
   TIME-SAFE SLICING (always show lines; slice only if we have per-point ts)
=========================================================== */
function featureToPartsByTime(f, t0, t1){
  const coords = f.geometry?.coordinates || [];
  if (coords.length < 2) return [];

  const pts = Array.isArray(f.properties?.__pts) ? f.properties.__pts : [];
  const noFilter = (t0 == null && t1 == null);

  // No timestamps? show whole line regardless of filter
  if (!pts.length) {
    return [{
      type:'Feature',
      properties:{ name: f.properties?.name || '' },
      geometry:{ type:'LineString', coordinates: coords }
    }];
  }

  // No filter? show whole line
  if (noFilter) {
    return [{
      type:'Feature',
      properties:{ name: f.properties?.name || '' },
      geometry:{ type:'LineString', coordinates: coords }
    }];
  }

  const inRange = (ts)=> (t0==null || ts >= t0) && (t1==null || ts <= t1);
  const segs = [];
  let cur = [];
  for (const p of pts){
    if (inRange(p.timestamp)) cur.push([p.lng, p.lat]);
    else { if (cur.length > 1) segs.push(cur); cur = []; }
  }
  if (cur.length > 1) segs.push(cur);

  return segs.map(seg => ({
    type:'Feature',
    properties:{ name:f.properties?.name || '' },
    geometry:{ type:'LineString', coordinates: seg }
  }));
}

/* ===========================================================
   FETCH + NORMALIZE
=========================================================== */
async function fetchSaved(){
  try{
    const r = await fetch('/api/saved_geo', { cache:'no-store' });
    if (!r.ok) throw new Error(`GET /api/saved_geo ${r.status}`);
    const fc = await r.json();

    peopleSet.clear();
    rawFC = { type:'FeatureCollection', features:[] };

    for (const f of (fc.features||[])){
      const name = f.properties?.name || 'Desconocido';
      peopleSet.add(name);

      // deep clone + ensure __pts exists
      const clone = JSON.parse(JSON.stringify(f));
      if (!Array.isArray(clone.properties?.__pts)) {
        const coords = clone.geometry?.coordinates || [];
        const startTs = Number.isFinite(clone.properties?.startTs) ? clone.properties.startTs : Date.now();
        clone.properties = clone.properties || {};
        clone.properties.__pts = coords.map((c,i)=>({ lng:c[0], lat:c[1], timestamp:startTs + i*1000 }));
      }
      rawFC.features.push(clone);
    }

    buildPeopleDropdowns();
    applyFilters();
  } catch(e){
    console.error('fetchSaved error', e);
    rawFC = { type:'FeatureCollection', features:[] };
    filteredFC = rawFC;
    drawFiltered();
    updateCounters();
  }
}

/* ===========================================================
   FILTER → DRAW
=========================================================== */
function applyFilters(){
  const [t0, t1] = readTimeInputs();
  const who = getSelectedPeopleSet();
  const out = [];

  for (const f of rawFC.features){
    const name = f.properties?.name || '';
    if (!who.has(name)) continue;
    featureToPartsByTime(f, t0, t1).forEach(p => out.push(p));
  }

  filteredFC = { type:'FeatureCollection', features: out };
  drawFiltered();
  updateCounters();
}

function clearFilters(){
  selectedOne = '__ALL__';
  ['startTime','endTime','startTime_m','endTime_m'].forEach(id => { const el=$(id); if (el) el.value=''; });
  buildPeopleDropdowns();
  applyFilters();
}

function drawFiltered(){
  // line geometry
  map.getSource('saved-all')?.setData(filteredFC);

  // compute head points
  const heads = [];
  for (const f of (filteredFC.features||[])){
    const g = f.geometry;
    if (g?.type === 'LineString' && g.coordinates.length){
      const last = g.coordinates[g.coordinates.length-1];
      heads.push({ type:'Feature', properties:{ name:f.properties?.name||'' }, geometry:{ type:'Point', coordinates:last }});
    }
  }
  map.getSource('saved-heads')?.setData({ type:'FeatureCollection', features:heads });
}

/* ===========================================================
   COUNTERS + FIT
=========================================================== */
function updateCounters(){
  const people = new Set((filteredFC.features||[]).map(f => f.properties?.name || ''));
  const segs = filteredFC.features?.length || 0;

  (function upd(pId, fId){
    if ($(pId)) $(pId).textContent = String(people.size || '0');
    if ($(fId)) $(fId).textContent = String(segs || '0');
  })('peopleCount','featCount');
  (function upd(pId, fId){
    if ($(pId)) $(pId).textContent = String(people.size || '0');
    if ($(fId)) $(fId).textContent = String(segs || '0');
  })('peopleCount_m','featCount_m');
}

function fitToData(){
  const feats = filteredFC.features || [];
  if (!feats.length) return;
  let minX= Infinity, minY= Infinity, maxX=-Infinity, maxY=-Infinity;
  for (const f of feats){
    const coords = f.geometry?.coordinates || [];
    if (f.geometry?.type === 'LineString'){
      for (const [x,y] of coords){
        if (x<minX) minX=x; if (y<minY) minY=y;
        if (x>maxX) maxX=x; if (y>maxY) maxY=y;
      }
    }
  }
  if (isFinite(minX) && isFinite(minY) && isFinite(maxX) && isFinite(maxY)){
    map.fitBounds([ [minX,minY], [maxX,maxY] ], {
      padding: { top: 80, right: 30, bottom: 300, left: 280 }
    });
  }
}

/* ===========================================================
   EXPORT (KML / KMZ)
=========================================================== */
function buildKml(fc){
  const header =
`<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
<name>trayectorias</name>
<Style id="lineBlue">
  <LineStyle><color>ffF5010E</color><width>3</width></LineStyle>
</Style>
`;
  const items = (fc.features||[]).map((f,i)=>{
    if (f.geometry?.type !== 'LineString') return '';
    const name = (f.properties?.name || `segmento ${i}`).replace(/[<&>]/g,'');
    const coords = f.geometry.coordinates.map(([x,y]) => `${x},${y},0`).join(' ');
    return `
<Placemark>
  <name>${name}</name>
  <styleUrl>#lineBlue</styleUrl>
  <LineString>
    <tessellate>1</tessellate>
    <coordinates>${coords}</coordinates>
  </LineString>
</Placemark>`;
  }).join('\n');

  const footer = '\n</Document>\n</kml>';
  return header + items + footer;
}

function downloadKML(){
  const kml = buildKml(filteredFC);
  const blob = new Blob([kml], { type:'application/vnd.google-earth.kml+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'trayectorias.kml';
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
}

async function downloadKMZ(){
  const kml = buildKml(filteredFC);
  const zip = new JSZip();
  zip.file('doc.kml', kml);
  const blob = await zip.generateAsync({ type:'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'trayectorias.kmz';
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
}

/* ===========================================================
   HOOKS
=========================================================== */
$('applyBtn')   ?.addEventListener('click', applyFilters);
$('clearBtn')   ?.addEventListener('click', clearFilters);
$('applyBtn_m') ?.addEventListener('click', applyFilters);
$('clearBtn_m') ?.addEventListener('click', clearFilters);

$('peopleSelect')  ?.addEventListener('change', (e)=>{ selectedOne = e.target.value || '__ALL__'; });
$('peopleSelect_m')?.addEventListener('change', (e)=>{ selectedOne = e.target.value || '__ALL__'; });

$('fitBtn')    ?.addEventListener('click', fitToData);
$('reloadBtn') ?.addEventListener('click', fetchSaved);
$('kmlBtn')    ?.addEventListener('click', downloadKML);
$('kmzBtn')    ?.addEventListener('click', downloadKMZ);

/* Mobile sheet drag is already in styles.css behavior on your site, so we just reuse it */
