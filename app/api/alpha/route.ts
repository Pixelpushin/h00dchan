// Public, read-only - serves the latest daily digest to the /alpha page
// and to anything external (an LLM crawler following llms.txt, a bot,
// whatever) that wants it as plain JSON instead of scraping the HTML page.
import { NextResponse } from "next/server";
import { getDailyAlphaDigest } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const digest = await getDailyAlphaDigest();
  return NextResponse.json({ digest });
}
