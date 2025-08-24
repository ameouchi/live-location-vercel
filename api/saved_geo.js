// api/saved_geo.js
// Persistent paths using Vercel KV (Redis). Data survives restarts and redeploys.

import { kv } from '@vercel/kv';

export const config = { api: { bodyParser: true } };

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function isFiniteNum(n){ return typeof n === 'number' && Number.isFinite(n); }

async function addPoint(name, coords, timestamp) {
  const key = `path:${name}`;
  const point = { lat: coords.lat, lng: coords.lng, timestamp };
  // Keep an index of all people in a Set
  await kv.sadd('people', name);
  // Append to that person's list (right side = chronological)
  await kv.rpush(key, point);

  // Optional cap to prevent unbounded growth per person
  const MAX_POINTS = 5000;
  const len = await kv.llen(key);
  if (len > MAX_POINTS) {
    // Trim to last MAX_POINTS items (Redis LTRIM is inclusive)
    await kv.ltrim(key, len - MAX_POINTS, -1);
  }
}

async function buildFeatureCollection() {
  const people = await kv.smembers('people'); // ['Ana', 'Ben', ...]
  const features = [];

  for (const name of people) {
    const arr = await kv.lrange(`path:${name}`, 0, -1); // returns array of points
    // Some KV clients return raw; ensure objects:
    const pts = (arr || []).map(v => (typeof v === 'string' ? JSON.parse(v) : v));

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

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
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

      const people = await kv.smembers('people');
      return res.status(200).json({ ok: true, people });
    }

    if (req.method === 'GET') {
      const fc = await buildFeatureCollection();
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json(fc);
    }

    if (req.method === 'DELETE') {
      // Optional cleanup endpoints:
      //   DELETE /api/saved_geo           -> clear all
      //   DELETE /api/saved_geo?name=Ana  -> clear one person
      const name = (req.query?.name || '').toString().trim();
      if (name) {
        await kv.del(`path:${name}`);
        await kv.srem('people', name);
      } else {
        const people = await kv.smembers('people');
        const keys = people.map(n => `path:${n}`);
        if (keys.length) await kv.del(...keys);
        await kv.del('people');
      }
      const remaining = await kv.smembers('people');
      return res.status(200).json({ ok: true, people: remaining });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (e) {
    console.error('saved_geo error:', e);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
