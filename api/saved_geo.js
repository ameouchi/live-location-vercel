// api/saved_geo.js
// Persistent paths using the Redis integration (REDIS_URL). Data survives restarts/redeploys.

import { createClient } from 'redis';

export const config = { api: { bodyParser: true } };

// ----- Redis client (singleton) -----
let client;
let ready = false;
async function getRedis() {
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL });
    client.on('error', (e) => console.error('[redis] error', e));
    await client.connect();
    ready = true;
  } else if (!ready) {
    await client.connect();
    ready = true;
  }
  return client;
}

// ----- CORS -----
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function isFiniteNum(n){ return typeof n === 'number' && Number.isFinite(n); }

// Keys
const PEOPLE_SET = 'people';               // set of all names
const PATH_KEY = (name) => `path:${name}`; // list per person (JSON strings)

// Append a point, keep optional cap
async function addPoint(redis, name, coords, timestamp) {
  const key = PATH_KEY(name);
  const point = { lat: coords.lat, lng: coords.lng, timestamp };
  await redis.sAdd(PEOPLE_SET, name);                     // index of all people
  await redis.rPush(key, JSON.stringify(point));          // append in order

  // Optional cap
  const MAX_POINTS = 5000;
  const len = await redis.lLen(key);
  if (len > MAX_POINTS) {
    // keep last MAX_POINTS
    await redis.lTrim(key, len - MAX_POINTS, -1);
  }
}

async function buildFeatureCollection(redis) {
  const people = await redis.sMembers(PEOPLE_SET); // ['Ana', 'Ben', ...]
  const features = [];
  for (const name of people) {
    const raw = await redis.lRange(PATH_KEY(name), 0, -1);
    const pts = (raw || []).map(s => {
      try { return JSON.parse(s); } catch { return null; }
    }).filter(Boolean);

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
    const redis = await getRedis();

    if (req.method === 'POST') {
      const body = req.body || {};
      const updates = Array.isArray(body.updates) ? body.updates : [body];

      for (const u of updates) {
        if (!u || !u.name || !u.coords) continue;
        const { lat, lng } = u.coords || {};
        if (!isFiniteNum(lat) || !isFiniteNum(lng)) continue;
        const ts = isFiniteNum(u.timestamp) ? u.timestamp : Date.now();
        await addPoint(redis, u.name.trim(), { lat, lng }, ts);
      }

      const people = await redis.sMembers(PEOPLE_SET);
      return res.status(200).json({ ok: true, people });
    }

    if (req.method === 'GET') {
      const fc = await buildFeatureCollection(redis);
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json(fc);
    }

    if (req.method === 'DELETE') {
      // DELETE /api/saved_geo           -> clear all
      // DELETE /api/saved_geo?name=Ana  -> clear one person
      const name = (req.query?.name || '').toString().trim();
      if (name) {
        await redis.del(PATH_KEY(name));
        await redis.sRem(PEOPLE_SET, name);
      } else {
        const people = await redis.sMembers(PEOPLE_SET);
        const keys = people.map(PATH_KEY);
        if (keys.length) await redis.del(keys);
        await redis.del(PEOPLE_SET);
      }
      const remaining = await redis.sMembers(PEOPLE_SET);
      return res.status(200).json({ ok: true
