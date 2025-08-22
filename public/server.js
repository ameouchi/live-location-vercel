// npm i express sqlite sqlite3
import express from "express";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const app = express();
app.use(express.json());

// --- tiny DB ---
const db = await open({ filename: "./locations.db", driver: sqlite3.Database });
await db.exec(`
CREATE TABLE IF NOT EXISTS locations(
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  lat  REAL NOT NULL,
  lng  REAL NOT NULL,
  ts   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_name_ts ON locations(name, ts);
`);

// --- ingest points (you already POST here) ---
app.post("/api/geo", async (req, res) => {
  try {
    const { name, coords, timestamp, stop } = req.body || {};
    if (stop) return res.json({ ok: true }); // nothing to store

    if (
      typeof name !== "string" || !name.trim() ||
      !coords || typeof coords.lat !== "number" || typeof coords.lng !== "number" ||
      typeof timestamp !== "number"
    ) return res.status(400).json({ error: "Bad payload" });

    await db.run(
      "INSERT INTO locations(name, lat, lng, ts) VALUES (?,?,?,?)",
      name.trim(), coords.lat, coords.lng, Math.floor(timestamp)
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server" });
  }
});

// --- list distinct people (for UI lists) ---
app.get("/api/people", async (_req, res) => {
  const rows = await db.all("SELECT DISTINCT name FROM locations ORDER BY name ASC");
  res.json({ people: rows.map(r => r.name) });
});

// --- raw history (points) for one person, optional time range ---
app.get("/api/history/:name", async (req, res) => {
  const { name } = req.params;
  const { from, to, limit = 5000 } = req.query;
  const params = [name];
  let where = "name = ?";
  if (from) { where += " AND ts >= ?"; params.push(Number(from)); }
  if (to)   { where += " AND ts <= ?"; params.push(Number(to));   }
  params.push(Number(limit));

  const rows = await db.all(
    `SELECT lat,lng,ts FROM locations WHERE ${where} ORDER BY ts ASC LIMIT ?`, params
  );
  res.json({ name, points: rows });
});

// --- GeoJSON path (LineString) for one person ---
app.get("/api/path/:name", async (req, res) => {
  const { name } = req.params;
  const rows = await db.all(
    "SELECT lat,lng,ts FROM locations WHERE name=? ORDER BY ts ASC LIMIT 10000",
    name
  );
  const coords = rows.map(r => [r.lng, r.lat]);
  res.json({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { name, count: rows.length, startTs: rows[0]?.ts || null, endTs: rows.at(-1)?.ts || null },
      geometry: { type: "LineString", coordinates: coords }
    }]
  });
});

// --- (optional) delete my data ---
app.delete("/api/history/:name", async (req, res) => {
  await db.run("DELETE FROM locations WHERE name=?", req.params.name);
  res.json({ ok: true });
});

app.listen(3000, () => console.log("Server listening on http://localhost:3000"));
