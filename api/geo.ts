import type { VercelRequest, VercelResponse } from '@vercel/node';
import { addPoint, getAllAsFeatureCollection } from './_store';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('cache-control', 'no-store');
  if (req.method === 'GET') return res.status(200).json(getAllAsFeatureCollection());
  if (req.method === 'POST') {
    const { name, coords, timestamp } = req.body ?? {};
    if (!name || !coords) return res.status(400).json({ error: 'name and coords required' });
    addPoint(String(name), { t: Number(timestamp) || Date.now(), coords });
    return res.status(200).json({ ok: true });
  }
  res.setHeader('allow', 'GET,POST');
  res.status(405).end('Method Not Allowed');
}
