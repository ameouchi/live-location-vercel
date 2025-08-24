// api/saved_geo.js
// In-memory store of all paths by person: { [name]: Array<{lng,lat,timestamp}> }
let userPaths = {};

// Optional: ensure Next/Vercel parses JSON body
export const config = {
  api: { bodyParser: true },
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function buildFeatureCollection() {
  const features = Object.entries(userPaths).map(([name, path]) => {
    const coords = path.map(p => [p.lng, p.lat]);
    const first = path[0]?.timestamp ?? null;
    const last  = path[path.length - 1]?.timestamp ?? null;
    return {
      type: "Feature",
      properties: {
        name,
        count: path.length,
        startTs: first,
        endTs: last
      },
      geometry: {
        type: "LineString",
        coordinates: coords
      }
    };
  });

  return { type: "FeatureCollection", features };
}

export default async function handler(req, res) {
  cors(res);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    if (req.method === 'POST') {
      // Accept single point {name, coords:{lat,lng}, timestamp}
      // or batch {updates:[{name, coords, timestamp}, ...]}
      const body = req.body || {};
      const updates = Array.isArray(body.updates) ? body.updates : [body];

      for (const u of updates) {
        if (!u || !u.name || !u.coords || !Number.isFinite(u.coords.lat) || !Number.isFinite(u.coords.lng)) {
          continue;
        }
        const ts = Number.isFinite(u.timestamp) ? u.timestamp : Date.now();
        if (!userPaths[u.name]) userPaths[u.name] = [];
        userPaths[u.name].push({ lat: u.coords.lat, lng: u.coords.lng, timestamp: ts });

        // (Optional) cap per-person history to avoid unbounded growth
        const MAX_POINTS = 5000;
        if (userPaths[u.name].length > MAX_POINTS) {
          userPaths[u.name] = userPaths[u.name].slice(-MAX_POINTS);
        }
      }

      return res.status(200).json({ ok: true, people: Object.keys(userPaths) });
    }

    if (req.method === 'GET') {
      // Return a single FeatureCollection for everyone
      const fc = buildFeatureCollection();
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json(fc);
    }

    if (req.method === 'DELETE') {
      // Optional cleanup:
      //   DELETE /api/saved_geo           -> clear all
      //   DELETE /api/saved_geo?name=Ana  -> clear one person
      const name = (req.query?.name || '').toString().trim();
      if (name) {
        delete userPaths[name];
      } else {
        userPaths = {};
      }
      return res.status(200).json({ ok: true, people: Object.keys(userPaths) });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (e) {
    console.error('saved_geo error:', e);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
