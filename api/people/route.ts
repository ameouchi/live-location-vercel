import { NextResponse } from "next/server";
import { listPeople } from "../_store";

export async function GET() {
  const people = listPeople();
  return NextResponse.json({ people }, { headers: { "cache-control": "no-store" } });
}
