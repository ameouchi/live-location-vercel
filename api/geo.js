let userPaths = {};

export default async function handler(req, res) {
  if (req.method === 'POST') {
    const { name, coords, timestamp } = req.body;
    if (!name || !coords || !timestamp) return res.status(400).send('Missing data');
    if (!userPaths[name]) userPaths[name] = [];
    userPaths[name].push({ ...coords, timestamp });
    return res.status(200).send('OK');
  }

  if (req.method === 'GET') {
    const features = Object.entries(userPaths).map(([name, path]) => ({
      type: "Feature",
      properties: { name },
      geometry: {
        type: "LineString",
        coordinates: path.map(p => [p.lng, p.lat])
      }
    }));
    return res.status(200).json({ type: "FeatureCollection", features });
  }

  return res.status(405).send('Method Not Allowed');
}
