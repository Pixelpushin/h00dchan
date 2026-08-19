// Read-only X (Twitter) API v2 lookup - public bio text for a given
// handle, via this project's own Bearer Token (X_BEARER_TOKEN, server
// only). No OAuth, no permission grant from the account holder - this
// reads the exact same public profile data anyone gets by visiting
// x.com/<handle>, just automated. Billed pay-per-use as of X's Feb 2026
// pricing change (~$0.01/user lookup at time of writing) - cheap at the
// volume a bi-weekly recheck of a niche collection's opted-in holders
// actually needs (see app/api/cron/bio-recheck/route.ts).
const X_API_BASE = "https://api.x.com/2";
const FETCH_TIMEOUT_MS = 10_000;

function apiKey(): string {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) throw new Error("X_BEARER_TOKEN is not configured.");
  return token;
}

export interface XUserBio {
  username: string;
  description: string;
}

// Returns null for "user not found" (a typo'd or since-renamed handle) -
// distinct from throwing, which callers should treat as "couldn't check
// right now, try again" rather than "definitely not verified."
export async function fetchXUserBio(handle: string): Promise<XUserBio | null> {
  const username = handle.replace(/^@/, "");
  const res = await fetch(
    `${X_API_BASE}/users/by/username/${encodeURIComponent(username)}?user.fields=description`,
    {
      headers: { authorization: `Bearer ${apiKey()}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`X API lookup failed for @${username} (${res.status})`);
  }
  const body = await res.json();
  if (!body.data) return null;
  return {
    username: body.data.username,
    description: body.data.description ?? "",
  };
}
