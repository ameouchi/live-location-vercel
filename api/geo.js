// /api/geo.js — Vercel Edge Function (no Node req/res)
// Keeps paths (with timestamps) in memory while the instance is warm.

export const config = { runtime: 'edge' };

// In-memory: Map<string, Array<{ lng:number, lat:number, t:number }>>
const store = new Map();

// CORS helper
function withCORS(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...extra,
  };
}

async function handleGET(url) {
  const raw = url.searchParams.get('raw');

  if (raw) {
    // Raw per-user arrays with timestamps
    const obj = Object.fromEntries([...store.entries()]);
    return new Response(JSON.stringify(obj), {
      status: 200,
      headers: withCORS({ 'Content-Type': 'application/json' }),
    });
  }

  // GeoJSON: coordinates + parallel timestamps array
  const features = [...store.entries()].map(([name, path]) => ({
    type: 'Feature',
    properties: {
      name,
      timestamps: path.map(p => p.t),
    },
    geometry: {
      type: 'LineString',
      coordinates: path.map(p => [p.lng, p.lat]),
    },
  }));

  return new Response(JSON.stringify({ type: 'FeatureCollection', features }), {
    status: 200,
    headers: withCORS({ 'Content-Type': 'application/json' }),
  });
}

async function handlePOST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Bad JSON body' }), {
      status: 400,
      headers: withCORS({ 'Content-Type': 'application/json' }),
    });
  }

  const { name, coords, timestamp } = body || {};
  if (
    !name ||
    !coords ||
    typeof coords.lng !== 'number' ||
    typeof coords.lat !== 'number'
  ) {
    return new Response(JSON.stringify({ error: 'Missing or invalid name/coords' }), {
      status: 400,
      headers: withCORS({ 'Content-Type': 'application/json' }),
    });
  }

  const key = String(name).trim();
  const t = typeof timestamp === 'number' ? timestamp : Date.now();

  const arr = store.get(key) || [];
  arr.push({ lng: coords.lng, lat: coords.lat, t });

  // Optional cap to avoid unbounded growth
  const MAX_POINTS = 1000;
  if (arr.length > MAX_POINTS) arr.splice(0, arr.length - MAX_POINTS);

  store.set(key, arr);

  return new Response(JSON.stringify({ ok: true, points: arr.length }), {
    status: 200,
    headers: withCORS({ 'Content-Type': 'application/json' }),
  });
}

async function handleDELETE() {
  store.clear();
  return new Response(JSON.stringify({ ok: true, cleared: true }), {
    status: 200,
    headers: withCORS({ 'Content-Type': 'application/json' }),
  });
}

export default async function handler(req) {
  const url = new URL(req.url);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: withCORS() });
  }
  if (req.method === 'GET')    return handleGET(url);
  if (req.method === 'POST')   return handlePOST(req);
  if (req.method === 'DELETE') return handleDELETE();

  return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
    status: 405,
    headers: withCORS({ 'Content-Type': 'application/json' }),
  });
}
