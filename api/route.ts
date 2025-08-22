import { NextResponse } from "next/server";
import { upsertPoint, getAllAsFeatureCollection } from "../_store";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const name: string = body?.name || "";
    const coords = body?.coords;
    const ts: number = body?.timestamp || Date.now();

    if (!name || !coords || typeof coords.lat !== "number" || typeof coords.lng !== "number") {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }
    // Store as [lng, lat]
    upsertPoint(name, Number(coords.lng), Number(coords.lat), ts);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Bad Request" }, { status: 400 });
  }
}

export async function GET() {
  // Return all current polylines for the live layer
  const fc = getAllAsFeatureCollection();
  return NextResponse.json(fc, { headers: { "cache-control": "no-store" } });
}
