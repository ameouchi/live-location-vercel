import { NextResponse } from "next/server";
import { getPath } from "../../_store";

export async function GET(_: Request, ctx: { params: { name: string } }) {
  const name = decodeURIComponent(ctx.params.name || "");
  const coords = getPath(name);

  const fc = {
    type: "FeatureCollection",
    features: coords.length
      ? [
          {
            type: "Feature",
            properties: { name },
            geometry: { type: "LineString", coordinates: coords }
          }
        ]
      : []
  };

  return NextResponse.json(fc, { headers: { "cache-control": "no-store" } });
}
