import { NextRequest, NextResponse } from "next/server";
import { verifyPersonaClaim } from "@/lib/auth-server";
import {
  checkWriteIpRateLimit,
  consumeVerifiedWriteBudget,
} from "@/lib/rate-limit";
import { ADDRESS_PATTERN } from "@/lib/address";
import { checkRegistryEligibility } from "@/lib/registryEligibility";
import {
  createRegistryEntry,
  isContractRegistered,
  listRegistryEntries,
  type RegistryKind,
} from "@/lib/registryStore";

// Node runtime (not edge) - needed for ethers' verifyMessage in
// lib/auth-server.ts, same reasoning as app/api/threads/route.ts.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_NAME_LEN = 60;
const MAX_URL_LEN = 300;
const MAX_DESCRIPTION_LEN = 280;
const VALID_KINDS: RegistryKind[] = ["nft", "token"];

export async function GET() {
  try {
    const entries = await listRegistryEntries();
    return NextResponse.json({ entries });
  } catch (error) {
    console.error("Failed to list registry entries", error);
    return NextResponse.json(
      { error: "Unable to list registry entries." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const {
    name,
    kind,
    contractAddress,
    url,
    description,
    tokenId,
    address,
    signature,
    issuedAt,
    batchTokenIds,
  } = (payload ?? {}) as Record<string, unknown>;

  if (
    typeof name !== "string" ||
    !name.trim() ||
    typeof kind !== "string" ||
    !VALID_KINDS.includes(kind as RegistryKind) ||
    typeof contractAddress !== "string" ||
    !ADDRESS_PATTERN.test(contractAddress) ||
    typeof url !== "string" ||
    !url.trim() ||
    typeof description !== "string" ||
    typeof tokenId !== "string" ||
    typeof address !== "string" ||
    typeof signature !== "string" ||
    typeof issuedAt !== "string"
  ) {
    return NextResponse.json(
      { error: "Missing or invalid fields." },
      { status: 400 },
    );
  }

  if (name.length > MAX_NAME_LEN) {
    return NextResponse.json(
      { error: `Name must be ${MAX_NAME_LEN} characters or fewer.` },
      { status: 400 },
    );
  }
  if (url.length > MAX_URL_LEN) {
    return NextResponse.json(
      { error: `URL must be ${MAX_URL_LEN} characters or fewer.` },
      { status: 400 },
    );
  }
  if (description.length > MAX_DESCRIPTION_LEN) {
    return NextResponse.json(
      {
        error: `Description must be ${MAX_DESCRIPTION_LEN} characters or fewer.`,
      },
      { status: 400 },
    );
  }
  try {
    new URL(url);
  } catch {
    return NextResponse.json(
      { error: "URL must be a valid link." },
      { status: 400 },
    );
  }

  // Same dual-layer rate-limit pattern as every other write path in this
  // app (see app/api/threads/route.ts) - IP-only pre-verify, then a
  // per-identity budget only after signature+ownership are confirmed.
  const ipRate = checkWriteIpRateLimit(request);
  if (!ipRate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      {
        status: 429,
        headers: { "Retry-After": String(ipRate.retryAfterSeconds) },
      },
    );
  }

  const verification = await verifyPersonaClaim({
    tokenId,
    address,
    signature,
    issuedAt,
    batchTokenIds: Array.isArray(batchTokenIds) ? batchTokenIds : undefined,
  });
  if (!verification.ok) {
    return NextResponse.json(
      {
        error: verification.reason ?? "Not authorized.",
        code: verification.code,
      },
      { status: 403 },
    );
  }

  const identityRate = consumeVerifiedWriteBudget(address, tokenId);
  if (!identityRate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      {
        status: 429,
        headers: { "Retry-After": String(identityRate.retryAfterSeconds) },
      },
    );
  }

  const lowerContract = contractAddress.toLowerCase();
  if (await isContractRegistered(lowerContract)) {
    return NextResponse.json(
      { error: "This contract is already registered." },
      { status: 409 },
    );
  }

  const eligibility = await checkRegistryEligibility(tokenId, address);
  if (!eligibility.ok) {
    return NextResponse.json(
      { error: eligibility.reason ?? "Not eligible to list a project." },
      { status: 403 },
    );
  }

  const result = await createRegistryEntry({
    kind: kind as RegistryKind,
    name: name.trim(),
    contractAddress: lowerContract,
    url: url.trim(),
    description: description.trim(),
    submitterTokenId: tokenId,
    submitterAddress: address.toLowerCase(),
    sponsored: eligibility.sponsored,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 409 });
  }

  return NextResponse.json({ entry: result.entry }, { status: 201 });
}
