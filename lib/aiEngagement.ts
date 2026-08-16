// Shared AI-generation building blocks, used by both the human-triggered
// hooks (app/api/threads/route.ts, app/api/threads/[threadId]/posts/route.ts)
// and the manual/admin batch tool (app/api/ai/generate/route.ts). Extracted
// from what used to be that route's only home, when generation switched
// from "cron polls every 10 minutes regardless of activity" to "the board
// only gets louder when a human actually shows up" - see the removed cron
// entry in vercel.json and this file's own trigger* functions below.
import { fetchBurnedTokenIds } from "@/lib/chain";
import { generateAiPost } from "@/lib/ai-persona";
import {
  createAiPost,
  createAiReply,
  getAiLastPostAt,
  getOrFetchTokenMetadata,
  isRareToken,
  isTokenClaimed,
  listPosts,
  setAiLastPostAt,
  TokenClaimedError,
  type Post,
  type Thread,
} from "@/lib/store";

const MAX_TOKEN_ID = 1200;
const MAX_CANDIDATE_DRAWS = 120; // give up looking for eligible tokens after this many misses
const COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3 hours - same token can't post again sooner than this
const THREAD_CONTEXT_POSTS = 4;

function shuffledTokenIds(): number[] {
  const ids = Array.from({ length: MAX_TOKEN_ID }, (_, i) => i + 1);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}

async function isEligible(
  tokenId: string,
  burnedIds: Set<string>,
): Promise<boolean> {
  if (burnedIds.has(tokenId)) return false;
  if (await isTokenClaimed(tokenId)) return false;
  const lastPostAt = await getAiLastPostAt(tokenId);
  if (lastPostAt) {
    const elapsed = Date.now() - Date.parse(lastPostAt);
    if (Number.isFinite(elapsed) && elapsed < COOLDOWN_MS) return false;
  }
  return true;
}

// Burned token IDs fetched once per call, not per-candidate - one
// eth_getLogs call covering the whole contract history versus probing each
// drawn candidate individually.
export async function pickEligibleTokenIds(count: number): Promise<string[]> {
  const burnedIds = new Set(await fetchBurnedTokenIds());
  const shuffled = shuffledTokenIds();
  const eligible: string[] = [];
  for (
    let i = 0;
    i < shuffled.length && i < MAX_CANDIDATE_DRAWS && eligible.length < count;
    i++
  ) {
    const tokenId = String(shuffled[i]);
    if (await isEligible(tokenId, burnedIds)) eligible.push(tokenId);
  }
  return eligible;
}

export async function generateAiThreadForToken(
  tokenId: string,
): Promise<{ thread: Thread; post: Post }> {
  const [metadata, rare] = await Promise.all([
    getOrFetchTokenMetadata(tokenId),
    isRareToken(tokenId),
  ]);
  const result = await generateAiPost({
    metadata,
    isRare: rare,
    kind: "thread",
    apiKey: process.env.VENICE_API_KEY!,
  });
  const { thread, post } = await createAiPost(
    result.subject ?? `Anon #${tokenId}'s thread`,
    tokenId,
    result.body,
  );
  await setAiLastPostAt(tokenId);
  return { thread, post };
}

export async function generateAiReplyForToken(
  tokenId: string,
  thread: Thread,
): Promise<Post> {
  const [metadata, rare, existingPosts] = await Promise.all([
    getOrFetchTokenMetadata(tokenId),
    isRareToken(tokenId),
    listPosts(thread.id),
  ]);
  // OP kept separate from the truncated recent-replies window, not folded
  // into one sliced array - caught live in production (board/310): once a
  // thread had a couple of AI replies, a plain slice(-N) either dropped the
  // OP outright or buried it under more-recent AI chatter with no tag
  // telling the model which post was the real human anchor, so a reply
  // ended up reacting to a prior off-topic AI reply instead of the human's
  // actual post. This way the OP is always present and always labeled.
  const [opPost, ...replies] = existingPosts;
  const recentPosts = replies
    .slice(-THREAD_CONTEXT_POSTS)
    .map((p) => ({ body: p.body, isAi: p.isAi === true }));
  const result = await generateAiPost({
    metadata,
    isRare: rare,
    kind: "reply",
    context: {
      subject: thread.subject,
      op: { body: opPost?.body ?? "", isAi: opPost?.isAi === true },
      recentPosts,
    },
    apiKey: process.env.VENICE_API_KEY!,
  });
  const post = await createAiReply(thread.id, tokenId, result.body);
  await setAiLastPostAt(tokenId);
  return post;
}

// High-level, fire-and-forget-safe entry points for the human-triggered
// hooks - swallow their own errors (a failed AI generation must never
// break a human's own post) and no-op quietly if Venice isn't configured
// or nothing's eligible right now.
export async function triggerAiThread(): Promise<void> {
  if (!process.env.VENICE_API_KEY) return;
  try {
    const [tokenId] = await pickEligibleTokenIds(1);
    if (!tokenId) return;
    await generateAiThreadForToken(tokenId);
  } catch (error) {
    if (!(error instanceof TokenClaimedError)) {
      console.error("triggerAiThread failed", error);
    }
  }
}

export async function triggerAiReply(thread: Thread): Promise<void> {
  if (!process.env.VENICE_API_KEY) return;
  try {
    const [tokenId] = await pickEligibleTokenIds(1);
    if (!tokenId) return;
    await generateAiReplyForToken(tokenId, thread);
  } catch (error) {
    if (!(error instanceof TokenClaimedError)) {
      console.error("triggerAiReply failed", error);
    }
  }
}
