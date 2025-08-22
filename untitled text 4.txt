// Lightweight in-memory store (demo). Replace with a real DB for persistence.
export type LngLat = [number, number];

type PersonTrack = {
  name: string;
  coords: LngLat[];     // [lng, lat]
  lastAt: number;       // timestamp ms
};

const tracks = new Map<string, PersonTrack>();

export function upsertPoint(name: string, lng: number, lat: number, ts: number) {
  const key = name.trim();
  if (!key) return;
  const ex = tracks.get(key);
  if (ex) {
    const last = ex.coords[ex.coords.length - 1];
    if (!last || last[0] !== lng || last[1] !== lat) ex.coords.push([lng, lat]);
    ex.lastAt = ts || Date.now();
  } else {
    tracks.set(key, { name: key, coords: [[lng, lat]], lastAt: ts || Date.now() });
  }
}

export function listPeople(): string[] {
  return Array.from(tracks.keys()).sort();
}

export function getPath(name: string): LngLat[] {
  return tracks.get(name)?.coords || [];
}

export function getAllAsFeatureCollection() {
  return {
    type: "FeatureCollection",
    features: Array.from(tracks.values())
      .filter(t => t.coords.length > 0)
      .map(t => ({
        type: "Feature",
        properties: { name: t.name, lastAt: t.lastAt },
        geometry: { type: "LineString", coordinates: t.coords }
      }))
  };
}
