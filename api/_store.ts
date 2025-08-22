export type Coords = { lat: number; lng: number };
export type Sample = { t: number; coords: Coords };

const paths = new Map<string, Sample[]>();

export function addPoint(name: string, sample: Sample) {
  const key = name.trim();
  const arr = paths.get(key) ?? [];
  arr.push(sample);
  paths.set(key, arr);
}

export function getPeople(): string[] {
  return Array.from(paths.keys()).sort();
}

export function getPath(name: string): Sample[] {
  return paths.get(name.trim()) ?? [];
}

export function getAllAsFeatureCollection() {
  const features = Array.from(paths.entries()).map(([name, samples]) => ({
    type: 'Feature',
    properties: { name },
    geometry: { type: 'LineString', coordinates: samples.map(s => [s.coords.lng, s.coords.lat]) }
  }));
  return { type: 'FeatureCollection', features };
}
