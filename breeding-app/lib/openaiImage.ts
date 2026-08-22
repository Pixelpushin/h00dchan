// Shared low-level OpenAI image-generation + Blob-upload primitive, used by
// both lib/breedingImage.ts (offspring art) and lib/girlfriendsImage.ts
// (dummy Girlfriends collection art). Copied precisely from the parent
// repo's lib/onlychansImage.ts pattern: raw fetch POST to
// /v1/images/generations (no openai SDK - same zero-SDK-dependency
// convention as every other external call in that repo), gpt-image-1,
// b64_json (not url) read off data[0], uploaded to Vercel Blob. Both
// callers just supply a prompt and a blob path prefix; the fetch/decode/
// upload mechanics live here once instead of being duplicated per caller.
import { put } from "@vercel/blob";
import { IMAGE_MODEL, IMAGE_QUALITY, IMAGE_SIZE } from "@/lib/imageConfig";

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

// blobPathPrefix e.g. "breeding/" or "girlfriends/" - keeps each caller's
// uploads in their own logical folder within the shared Blob store.
export async function generateAndUploadImage(
  prompt: string,
  blobPathPrefix: string,
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
  const blob = await put(`${blobPathPrefix}${Date.now()}.png`, bytes, {
    access: "public",
    contentType: "image/png",
    addRandomSuffix: true,
  });

  return { blobUrl: blob.url };
}
