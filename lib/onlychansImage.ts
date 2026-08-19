// Server-only: calls OpenAI's image generation API directly (raw fetch,
// same zero-SDK-dependency convention as every other external call in this
// repo - see lib/opensea.ts, lib/dailyAlpha.ts) and uploads the result to
// Vercel Blob, same pattern as app/api/admin/backfill-images/route.ts.
import { put } from "@vercel/blob";
import { IMAGE_MODEL, IMAGE_QUALITY, IMAGE_SIZE } from "@/lib/onlychansConfig";

const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";
const FETCH_TIMEOUT_MS = 60_000;

function apiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not configured.");
  return key;
}

export interface GeneratedImage {
  blobUrl: string;
}

export async function generateOnlyChanImage(
  prompt: string,
): Promise<GeneratedImage> {
  const res = await fetch(OPENAI_IMAGES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt,
      size: IMAGE_SIZE,
      quality: IMAGE_QUALITY,
      n: 1,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI image generation failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const b64: string | undefined = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI response had no image data.");

  const bytes = Buffer.from(b64, "base64");
  const blob = await put(`onlychans/${Date.now()}.png`, bytes, {
    access: "public",
    contentType: "image/png",
    addRandomSuffix: true,
  });

  return { blobUrl: blob.url };
}
