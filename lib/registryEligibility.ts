// CircleJerkFinance registry submission bar - "not too heavy a lift" but
// also "not just garbage": a submitting anon needs to actually be
// participating (>=1 nested HOODCHAN held in its own token-bound wallet,
// AND >=1 human post/thread), or a core member vouches for it directly
// (lib/coreMembers.ts) and the bar is skipped entirely.
import { computeTbaAddress } from "@/lib/tba";
import {
  getCollectionSnapshot,
  nestedHoldingCount,
} from "@/lib/collectionSnapshot";
import { countHumanPostsByToken, countHumanThreadsByToken } from "@/lib/store";
import { isCoreMemberAddress } from "@/lib/coreMembers";

export interface EligibilityResult {
  ok: boolean;
  reason?: string;
  sponsored: boolean;
}

export async function checkRegistryEligibility(
  tokenId: string,
  address: string,
): Promise<EligibilityResult> {
  if (isCoreMemberAddress(address)) {
    return { ok: true, sponsored: true };
  }

  const [tbaAddress, snapshot, humanPosts, humanThreads] = await Promise.all([
    computeTbaAddress(tokenId),
    getCollectionSnapshot(),
    countHumanPostsByToken(tokenId),
    countHumanThreadsByToken(tokenId),
  ]);

  const nested = nestedHoldingCount(snapshot, tbaAddress);
  const posted = humanPosts + humanThreads > 0;

  if (nested < 1 && !posted) {
    return {
      ok: false,
      sponsored: false,
      reason:
        "This anon needs to hold a nested HOODCHAN and have posted at least once to list a project.",
    };
  }
  if (nested < 1) {
    return {
      ok: false,
      sponsored: false,
      reason:
        "This anon needs to hold at least one nested HOODCHAN to list a project.",
    };
  }
  if (!posted) {
    return {
      ok: false,
      sponsored: false,
      reason: "This anon needs to have posted at least once to list a project.",
    };
  }

  return { ok: true, sponsored: false };
}
