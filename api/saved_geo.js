// api/saved_geo.js
// Persistent paths using either Vercel KV (REST) or Redis URL.
// Add this file exactly as-is, then restart your dev server.

export const config = { api: { bodyParser: true } };

// --- CORS (keeps things simple) ---
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// --- Backend selection (KV first, Redis fallback) ---
let backend = null; // { type: 'kv'|'redis', ... }

function isFiniteNum(n){ return typeof n === 'number' && Number.isFinite(n); }

async function ensureBackend() {
  if (backend) return backend;

  const hasKV = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
  const hasRedis = !!process.env.REDIS_URL;

  if (hasKV) {
    // Lazy import @vercel/kv
    const mod = await import('@vercel/kv');
    backend = { type: 'kv', kv: mod.kv };
    console.log('[saved_geo] Using Vercel KV (REST)');
  } else if (hasRedis) {
    // Lazy import redis 5 client
    const { createClient } = await import('redis');
    const client = createClient({ url: process.env.REDIS_URL });
    client.on('error', (err) => console.error('[saved_geo] Redis client error:', err));
    try {
      await client.connect();
      backend = { type: 'redis', client };
      console.log('[saved_geo] Using Redis URL');
    } catch (e) {
      console.error('[saved_geo] Redis connect failed:', e);
      throw e;
    }
  } else {
    console.error('[saved_geo] No KV_REST_API_* or REDIS_URL found. Add env vars!');
    throw new Error('Missing KV_REST_API_URL/KV_REST_API_TOKEN or REDIS_URL');
  }

  return backend;
}

// --- Helpers for set/list ops abstracted over KV/Redis ---
async function saddPeople(name){
  const b = await ensureBackend();
  if (b.type === 'kv') return b.kv.sadd('people', name);
  return b.client.sAdd('people', name);
}
async function smembersPeople(){
  const b = await ensureBackend();
  if (b.type === 'kv') return b.kv.smembers('people');
  return b.client.sMembers('people');
}
async function sremPeople(name){
  const b = await ensureBackend();
  if (b.type === 'kv') return b.kv.srem('people', name);
  return b.client.sRem('people', name);
}
async function rpushPoint(key, point){
  const b = await ensureBackend();
  const payload = JSON.stringify(point);
  if (b.type === 'kv') return b.kv.rpush(key, payload);
  return b.client.rPush(key, payload);
}
async function llen(key){
  const b = await ensureBackend();
  if (b.type === 'kv') return b.kv.llen(key);
  return b.client.lLen(key);
}
async function ltrim(key, start, stop){
  const b = await ensureBackend();
  if (b.type === 'kv') return b.kv.ltrim(key, start, stop);
  return b.client.lTrim(key, start, stop);
}
async function lrangeParse(key, start, stop){
  const b = await ensureBackend();
  let arr;
  if (b.type === 'kv') arr = await b.kv.lrange(key, start, stop);
  else arr = await b.client.lRange(key, start, stop);
  return (arr || []).map(v => (typeof v === 'string' ? JSON.parse(v) : v));
}
async function delKeys(...keys){
  const b = await ensureBackend();
  if (!keys.length) return;
  if (b.type === 'kv') return b.kv.del(...keys);
  return b.client.del(...keys);
}

// --- Domain helpers ---
async function addPoint(name, coords, timestamp) {
  const key = `path:${name}`;
  await saddPeople(name);
  await rpushPoint(key, { lat: coords.lat, lng: coords.lng, timestamp });

  // Optional cap
  const MAX_POINTS = 5000;
  const len = await llen(key);
  if (len > MAX_POINTS) {
    await ltrim(key, len - MAX_POINTS, -1);
  }
}

async function buildFeatureCollection() {
  const people = await smembersPeople();
  const features = [];

  for (const name of people) {
    const pts = await lrangeParse(`path:${name}`, 0, -1);
    if (!pts.length) continue;

    const coords = pts.map(p => [p.lng, p.lat]);
    const first = pts[0]?.timestamp ?? null;
    const last  = pts[pts.length - 1]?.timestamp ?? null;

    features.push({
      type: 'Feature',
      properties: { name, count: pts.length, startTs: first, endTs: last },
      geometry: { type: 'LineString', coordinates: coords }
    });
  }

  return { type: 'FeatureCollection', features };
}

// --- HTTP handler ---
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Print once at cold start which env vars we see (safe)
  if (!global._saved_geo_env_logged) {
    console.log('[saved_geo] Env present:', {
      KV_REST_API_URL: !!process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: !!process.env.KV_REST_API_TOKEN,
      REDIS_URL: !!process.env.REDIS_URL
    });
    global._saved_geo_env_logged = true;
  }

  try {
    await ensureBackend();

    if (req.method === 'POST') {
      const body = req.body || {};
      const updates = Array.isArray(body.updates) ? body.updates : [body];

      for (const u of updates) {
        if (!u || !u.name || !u.coords) continue;
        const { lat, lng } = u.coords || {};
        if (!isFiniteNum(lat) || !isFiniteNum(lng)) continue;
        const ts = isFiniteNum(u.timestamp) ? u.timestamp : Date.now();
        await addPoint(u.name, { lat, lng }, ts);
      }

      const people = await smembersPeople();
      return res.status(200).json({ ok: true, people });
    }

    if (req.method === 'GET') {
      const fc = await buildFeatureCollection();
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json(fc);
    }

    if (req.method === 'DELETE') {
      const name = (req.query?.name || '').toString().trim();
      if (name) {
        await delKeys(`path:${name}`);
        await sremPeople(name);
      } else {
        const people = await smembersPeople();
        const keys = people.map(n => `path:${n}`);
        if (keys.length) await delKeys(...keys);
        // remove the set itself
        await delKeys('people');
      }
      const remaining = await smembersPeople();
      return res.status(200).json({ ok: true, people: remaining });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (e) {
    console.error('[saved_geo] Handler error:', e);
    return res.status(500).json({ error: e?.message || 'Internal Server Error' });
  }
}
