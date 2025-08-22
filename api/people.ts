import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPeople } from './_store';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('cache-control', 'no-store');
  res.status(200).json({ people: getPeople() });
}
