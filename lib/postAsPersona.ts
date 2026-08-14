"use client";

// POSTs a JSON body with a PersonaClaim attached, and transparently retries
// once with a freshly re-signed claim if the server says the previous one
// expired - so a reply/new-thread submit doesn't dead-end with a confusing
// error just because 15 minutes passed since the last signature. Any other
// 403 (bad signature, no-longer-holds-token) surfaces as a real error
// instead of retrying, since re-signing can't fix those.
import type { PersonaClaim } from "@/lib/persona";

export async function postJsonAsPersona<T>(
  url: string,
  extraFields: Record<string, unknown>,
  persona: PersonaClaim,
  reauthorize: () => Promise<PersonaClaim>,
): Promise<T> {
  const attempt = (claim: PersonaClaim) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...extraFields,
        tokenId: claim.tokenId,
        address: claim.address,
        signature: claim.signature,
        issuedAt: claim.issuedAt,
      }),
    });

  let res = await attempt(persona);

  if (res.status === 403) {
    const body = await res
      .clone()
      .json()
      .catch(() => null);
    const reason = typeof body?.error === "string" ? body.error : "";
    if (reason.toLowerCase().includes("expired")) {
      const refreshed = await reauthorize();
      res = await attempt(refreshed);
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message =
      typeof body?.error === "string"
        ? body.error
        : `Request failed (${res.status})`;
    throw new Error(message);
  }

  return (await res.json()) as T;
}
