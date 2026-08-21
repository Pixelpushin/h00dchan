// Orchestrates Alpha Bot's actual board presence: a qualifying holder
// starts a thread -> their own anon's research desk replies in it with
// real Nansen-grounded commentary; they reply again in their own
// thread -> the desk talks back. Deliberately narrow on both ends - only
// the thread's own OP token ever gets a desk response (never random other
// posters, "only talk to the owner of the bots nested in the wallet" was
// explicit).
//
// Every trigger checks TWO independent caps before anything gets generated
// or posted: a per-anon daily posting cap (consumeDailyAlphaBotPostCap -
// applies even to a cache-hit, which costs zero real API spend but is
// still a board-quality/spam concern) and, only on the branch that
// actually generates fresh research, a hard site-wide daily budget
// (consumeDailyAlphaBotBudget - this is a paid-API experiment, not a
// guaranteed-forever feature). A cache hit never touches the site-wide
// budget at all, by design - see getOrRefreshAlphaBotEntry/
// triggerAlphaBotThreadReplies below for why that ordering matters.
import { CONTRACT, CHAIN_ID_HEX } from "@/lib/chain";
import {
  getCollectionSnapshot,
  nestedHoldingCount,
} from "@/lib/collectionSnapshot";
import {
  ALPHA_BOT_ATTRIBUTION,
  ALPHA_BOT_DISCLAIMER,
  ALPHA_BOT_NEW_THREAD_COOLDOWN_DAYS,
  ALPHA_BOT_SNAPSHOT_CUTOFF_MS,
  MAX_ALPHA_BOT_EVENTS_PER_DAY,
  MAX_ALPHA_BOT_POSTS_PER_TOKEN_PER_DAY,
} from "@/lib/alphaBotConfig";
import {
  acquireAlphaBotGenerationLock,
  consumeAlphaBotNewThreadCooldown,
  consumeDailyAlphaBotBudget,
  consumeDailyAlphaBotPostCap,
  getAlphaBotEntry,
  saveAlphaBotEntry,
  type AlphaBotEntry,
} from "@/lib/alphaBotStore";
import {
  generateAlphaBotFollowUp,
  generateAlphaBotResearch,
} from "@/lib/alphaBotResearch";
import {
  addAlphaBotReply,
  createAlphaBotThread,
  type Thread,
} from "@/lib/store";
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

// The anon's own token-bound wallet only ever holds what's been nested
// inside it - the current owner's actual EOA (or, if nested inside
// another anon, that anon's own TBA) can hold a very different, often
// much larger, real on-chain footprint. Research previously only ever
// looked at the TBA ("what's nested"), missing the holder's own wallet
// entirely - reported live as a real gap once the research came back
// as "empty" for anons whose real holder wallet clearly wasn't. Comes
// from the same cached collection snapshot alphaBotQualifies already
// reads, so this costs no extra RPC call.
export async function resolveHolderAddress(
  tokenId: string,
): Promise<string | null> {
  const snapshot = await getCollectionSnapshot();
  return snapshot.ownerOfToken.get(tokenId) ?? null;
}

// Shared "is this entry still within the cooldown window" check - used by
// both getOrRefreshAlphaBotEntry and triggerAlphaBotThreadReplies below so
// the two can never quietly drift out of agreement on what counts as
// fresh, mirroring app/api/alpha/research/route.ts's own cache check.
function isAlphaBotEntryFresh(
  entry: AlphaBotEntry | null,
): entry is AlphaBotEntry {
  return (
    !!entry && Date.now() - Date.parse(entry.generatedAt) < RESEARCH_COOLDOWN_MS
  );
}

export async function getOrRefreshAlphaBotEntry(
  tokenId: string,
  tbaAddress: string,
): Promise<AlphaBotEntry> {
  const existing = await getAlphaBotEntry(tokenId);
  if (isAlphaBotEntryFresh(existing)) return existing;
  const holderAddress = await resolveHolderAddress(tokenId);
  const entry = await generateAlphaBotResearch(
    tokenId,
    tbaAddress,
    holderAddress,
  );
  return maybeStartAlphaBotThread(entry);
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

// Alpha Bot's one narrow exception to "only humans start new threads" -
// see lib/alphaBotConfig.ts's ALPHA_BOT_NEW_THREAD_COOLDOWN_DAYS. Only
// ever reached right after a FRESH generation (never a cache-hit reuse -
// both call sites below only invoke this immediately after
// generateAlphaBotResearch returns), so a given research result can only
// ever attempt this once, and entry.threadStarted (persisted) means it's
// recorded even after the fact so re-displaying this same cached entry
// elsewhere never implies a second thread got started from it. The
// site-wide cooldown check happens LAST, after confirming there's
// actually a newsworthy finding to post - an ordinary result should never
// burn the cooldown window that a genuinely notable one might need.
async function maybeStartAlphaBotThread(
  entry: AlphaBotEntry,
): Promise<AlphaBotEntry> {
  if (!entry.newsworthy || entry.threadStarted) return entry;
  if (
    !(await consumeAlphaBotNewThreadCooldown(
      ALPHA_BOT_NEW_THREAD_COOLDOWN_DAYS,
    ))
  ) {
    return entry;
  }
  try {
    await createAlphaBotThread(
      entry.newsworthy.subject,
      entry.tokenId,
      `${entry.newsworthy.body}\n\n${ALPHA_BOT_ATTRIBUTION} ${ALPHA_BOT_DISCLAIMER}`,
    );
  } catch (error) {
    console.error(
      `Alpha Bot new-thread post failed for #${entry.tokenId}`,
      error,
    );
    return entry;
  }
  const updated: AlphaBotEntry = { ...entry, threadStarted: true };
  await saveAlphaBotEntry(updated);
  return updated;
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

    // Per-anon cap, checked before anything else - gates BOTH branches
    // below (cache-hit and fresh-generation) equally, since a cache-hit
    // event costs zero real spend and would otherwise be uncapped no
    // matter how many times this same anon triggers it in a day. See
    // lib/alphaBotConfig.ts's MAX_ALPHA_BOT_POSTS_PER_TOKEN_PER_DAY.
    if (
      !(await consumeDailyAlphaBotPostCap(
        tokenId,
        MAX_ALPHA_BOT_POSTS_PER_TOKEN_PER_DAY,
      ))
    ) {
      return;
    }

    // Cache check BEFORE spending a daily slot, same ordering as
    // app/api/alpha/research/route.ts: a cache hit is zero real Nansen/
    // Venice spend (still inside the 24h cooldown), so it must never burn
    // one of the MAX_ALPHA_BOT_EVENTS_PER_DAY site-wide slots. The budget
    // is only consumed on the branch that actually calls out to generate
    // fresh research.
    const existing = await getAlphaBotEntry(tokenId);
    let entry: AlphaBotEntry;
    if (isAlphaBotEntryFresh(existing)) {
      entry = existing;
    } else {
      // Atomic per-tokenId lock BEFORE spending the daily slot - closes a
      // real race where two near-simultaneous triggers for the same anon
      // (two tabs, or a thread-create landing next to a reply) both read
      // "no fresh entry" and both generate, double-spending Nansen credits
      // for one user action. Losing the lock is treated the same as
      // losing the budget check below - just skip, the other caller's
      // generation (already in flight) will populate the cache for next
      // time.
      if (!(await acquireAlphaBotGenerationLock(tokenId))) return;
      if (!(await consumeDailyAlphaBotBudget(MAX_ALPHA_BOT_EVENTS_PER_DAY)))
        return;
      // Budget already consumed above; if generation throws here the
      // slot is burned, not refunded - unchanged from prior behavior and
      // matches the route, which has no refund path either.
      const holderAddress = await resolveHolderAddress(tokenId);
      entry = await generateAlphaBotResearch(
        tokenId,
        tbaAddress,
        holderAddress,
      );
      entry = await maybeStartAlphaBotThread(entry);
    }

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
    // Same per-anon cap as the thread-reply path, shared across both -
    // an owner replying in their own thread repeatedly is exactly the
    // other way to rack up unbounded posts from one anon.
    if (
      !(await consumeDailyAlphaBotPostCap(
        tokenId,
        MAX_ALPHA_BOT_POSTS_PER_TOKEN_PER_DAY,
      ))
    ) {
      return;
    }
    // A follow-up only makes sense once there's already research to talk
    // back from - no cached entry means this owner hasn't triggered the
    // opening round yet (or it's expired past recall), nothing to
    // continue.
    const entry = await getAlphaBotEntry(tokenId);
    if (!entry) return;
    // Same lock as the thread-reply path - two near-simultaneous follow-up
    // replies for the same anon would otherwise both generate and both
    // spend real Nansen/Venice credit for what's one user action.
    if (!(await acquireAlphaBotGenerationLock(tokenId))) return;
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
