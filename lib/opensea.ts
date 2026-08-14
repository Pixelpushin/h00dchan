// OpenSea API v2 lookup for the paid-ad-rental feature - given a pasted
// collection URL, pulls the collection's own official art (never accepts a
// raw image upload; see lib/adConfig.ts/app/api/ads/route.ts for the rest
// of that flow) and its own is_nsfw/is_disabled flags as a free pre-filter.
// Confirmed live against OpenSea's own reference docs before writing this:
// GET /api/v2/collections/{slug} returns image_url, banner_image_url,
// is_nsfw, is_disabled, safelist_status alongside the usual name/contracts
// fields. Server-only - OPENSEA_API_KEY is not NEXT_PUBLIC_.
const OPENSEA_API_BASE = "https://api.opensea.io/api/v2";
const FETCH_TIMEOUT_MS = 8_000;

function apiKey(): string {
  const key = process.env.OPENSEA_API_KEY;
  if (!key) throw new Error("OPENSEA_API_KEY is not configured.");
  return key;
}

// Accepts a full collection URL ("https://opensea.io/collection/hoodchan"),
// a bare slug ("hoodchan"), or the same with trailing slash/query string -
// advertisers will paste whatever they have copied from their browser bar.
export function extractOpenSeaSlug(input: string): string | null {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/opensea\.io\/collection\/([a-z0-9-]+)/i);
  if (urlMatch) return urlMatch[1];
  if (/^[a-z0-9-]+$/i.test(trimmed)) return trimmed;
  return null;
}

export interface OpenSeaCollection {
  slug: string;
  name: string;
  imageUrl: string;
  openseaUrl: string;
}

export type OpenSeaLookupResult =
  { ok: true; collection: OpenSeaCollection } | { ok: false; reason: string };

export async function fetchOpenSeaCollection(
  urlOrSlug: string,
): Promise<OpenSeaLookupResult> {
  const slug = extractOpenSeaSlug(urlOrSlug);
  if (!slug) {
    return { ok: false, reason: "Not a valid OpenSea collection URL." };
  }

  let res: Response;
  try {
    res = await fetch(`${OPENSEA_API_BASE}/collections/${slug}`, {
      headers: { "x-api-key": apiKey() },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "Unable to reach OpenSea right now." };
  }

  if (res.status === 404) {
    return { ok: false, reason: "No OpenSea collection found at that URL." };
  }
  if (!res.ok) {
    return { ok: false, reason: `OpenSea lookup failed (${res.status}).` };
  }

  const data = await res.json();

  if (data.is_disabled === true) {
    return { ok: false, reason: "That collection is disabled on OpenSea." };
  }
  if (data.is_nsfw === true) {
    return {
      ok: false,
      reason: "That collection is flagged NSFW on OpenSea.",
    };
  }

  const imageUrl =
    typeof data.banner_image_url === "string" && data.banner_image_url
      ? data.banner_image_url
      : typeof data.image_url === "string"
        ? data.image_url
        : "";
  if (!imageUrl) {
    return {
      ok: false,
      reason: "That collection has no banner or image set on OpenSea.",
    };
  }

  return {
    ok: true,
    collection: {
      slug,
      name: typeof data.name === "string" ? data.name : slug,
      imageUrl,
      openseaUrl: `https://opensea.io/collection/${slug}`,
    },
  };
}
