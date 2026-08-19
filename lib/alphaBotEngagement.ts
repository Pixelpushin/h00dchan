// Orchestrates Alpha Bot's actual board presence: a qualifying holder
// starts a thread -> their own anon's research desk replies in it with
// real Nansen-grounded commentary; they reply again in their own
// thread -> the desk talks back. Deliberately narrow on both ends - only
// the thread's own OP token ever gets a desk response (never random other
// posters, "only talk to the owner of the bots nested in the wallet" was
// explicit), and every trigger burns from a hard site-wide daily budget
// (this is a paid-API experiment, not a guaranteed-forever feature) before
// anything gets generated or posted.
import { CONTRACT, CHAIN_ID_HEX } from "@/lib/chain";
import {
  getCollectionSnapshot,
  nestedHoldingCount,
} from "@/lib/collectionSnapshot";
import {
  ALPHA_BOT_ATTRIBUTION,
  ALPHA_BOT_DISCLAIMER,
  ALPHA_BOT_SNAPSHOT_CUTOFF_MS,
  MAX_ALPHA_BOT_EVENTS_PER_DAY,
} from "@/lib/alphaBotConfig";
import {
  consumeDailyAlphaBotBudget,
  getAlphaBotEntry,
  type AlphaBotEntry,
} from "@/lib/alphaBotStore";
import {
  generateAlphaBotFollowUp,
  generateAlphaBotResearch,
} from "@/lib/alphaBotResearch";
import { addAlphaBotReply, type Thread } from "@/lib/store";
import * as tbaKit from "@pixelpushin/tba-kit";

const RESEARCH_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const ALCHEMY_RPC_URL = process.env.ALCHEMY_API_KEY
  ? `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
  : undefined;

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw new Error("unreachable");
}

export async function resolveTbaAddress(tokenId: string): Promise<string> {
  return withRetry(() =>
    tbaKit.computeTbaAddress({
      tokenContract: CONTRACT,
      tokenId,
      chainIdHex: CHAIN_ID_HEX,
      rpcUrl: ALCHEMY_RPC_URL,
    }),
  );
}

// Two independent ways in: (a) already held this specific anon as of the
// fixed launch snapshot (rewards existing believers, permanently, not a
// rolling window - see lib/alphaBotConfig.ts's own comment on why this
// replaced an earlier hold-duration rule), or (b) currently has another
// HOODCHAN NFT nested inside this anon's own token-bound wallet - "anyone
// with nested NFTs," a direct reward for actually locking assets into the
// TBA rather than just holding the outer NFT in an EOA.
export async function alphaBotQualifies(
  tokenId: string,
  tbaAddress: string,
): Promise<boolean> {
  if (!process.env.VENICE_API_KEY || !process.env.NANSEN_API_KEY) return false;
  const snapshot = await getCollectionSnapshot();
  const acquiredAtMs = snapshot.acquiredAtMs.get(tokenId);
  const heldSinceSnapshot =
    acquiredAtMs !== undefined && acquiredAtMs <= ALPHA_BOT_SNAPSHOT_CUTOFF_MS;
  const hasNestedNfts = nestedHoldingCount(snapshot, tbaAddress) > 0;
  return heldSinceSnapshot || hasNestedNfts;
}

export async function getOrRefreshAlphaBotEntry(
  tokenId: string,
  tbaAddress: string,
): Promise<AlphaBotEntry> {
  const existing = await getAlphaBotEntry(tokenId);
  const fresh =
    existing &&
    Date.now() - Date.parse(existing.generatedAt) < RESEARCH_COOLDOWN_MS;
  if (fresh) return existing;
  return generateAlphaBotResearch(tokenId, tbaAddress);
}

// Every single Alpha Bot post carries the full warning, not a soft "DYOR"
// tacked onto just one desk's last line - "every post go hard so people
// know this may not be accurate and may be bad advice" (explicit
// instruction, not a one-time footer). Also carries the Nansen attribution
// line every time, not once per thread - Nansen's own terms require
// attribution "in a reasonably visible location" anywhere their data is
// publicly displayed, and each of these posts is its own standalone public
// display of it.
function deskPostBody(deskName: string, bullets: string[]): string {
  return `**${deskName}:**\n${bullets.map((b) => `- ${b}`).join("\n")}\n\n${ALPHA_BOT_ATTRIBUTION} ${ALPHA_BOT_DISCLAIMER}`;
}

// Fired once per qualifying new thread (app/api/threads/route.ts's after()
// hook) - posts each desk's take as its own reply, so it reads like a few
// different desks chiming in rather than one wall of text.
export async function triggerAlphaBotThreadReplies(
  thread: Thread,
  tokenId: string,
): Promise<void> {
  try {
    const tbaAddress = await resolveTbaAddress(tokenId);
    if (!(await alphaBotQualifies(tokenId, tbaAddress))) return;
    if (!(await consumeDailyAlphaBotBudget(MAX_ALPHA_BOT_EVENTS_PER_DAY)))
      return;

    const entry = await getOrRefreshAlphaBotEntry(tokenId, tbaAddress);
    for (const desk of entry.desks) {
      if (desk.bullets.length === 0) continue;
      await addAlphaBotReply(
        thread.id,
        tokenId,
        deskPostBody(desk.name, desk.bullets),
      );
    }
  } catch (error) {
    console.error(`Alpha Bot thread replies failed for #${tokenId}`, error);
  }
}

// Fired only when a reply in a thread comes from that thread's OWN OP
// token (app/api/threads/[threadId]/posts/route.ts's after() hook) - the
// desk "talking back" to its own owner. Never fires for any other poster
// in the thread, by construction (the caller only invokes this after
// confirming replyTokenId === thread.tokenId).
export async function triggerAlphaBotFollowUp(
  thread: Thread,
  tokenId: string,
  ownerMessage: string,
): Promise<void> {
  try {
    const tbaAddress = await resolveTbaAddress(tokenId);
    if (!(await alphaBotQualifies(tokenId, tbaAddress))) return;
    // A follow-up only makes sense once there's already research to talk
    // back from - no cached entry means this owner hasn't triggered the
    // opening round yet (or it's expired past recall), nothing to
    // continue.
    const entry = await getAlphaBotEntry(tokenId);
    if (!entry) return;
    if (!(await consumeDailyAlphaBotBudget(MAX_ALPHA_BOT_EVENTS_PER_DAY)))
      return;

    const desk = await generateAlphaBotFollowUp(entry, ownerMessage);
    if (desk.bullets.length === 0) return;
    await addAlphaBotReply(
      thread.id,
      tokenId,
      deskPostBody(desk.name, desk.bullets),
    );
  } catch (error) {
    console.error(`Alpha Bot follow-up failed for #${tokenId}`, error);
  }
}
