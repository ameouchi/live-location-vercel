import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPath } from '../_store';

export default function handler(req: VercelRequest, res: VercelResponse) {
  const name = decodeURIComponent(String(req.query.name || ''));
  const samples = getPath(name);
  const fc = {
    type: 'FeatureCollection',
    features: samples.length ? [{
      type: 'Feature',
      properties: { name },
      geometry: { type: 'LineString', coordinates: samples.map(s => [s.coords.lng, s.coords.lat]) }
    }] : []
  };
  res.setHeader('cache-control', 'no-store');
  res.status(200).json(fc);
}
