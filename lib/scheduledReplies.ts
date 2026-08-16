// Delayed, staggered AI replies - reward for a human going out of their way
// to start a real thread: instead of one instant AI reply, a few land
// spaced out over ~30 minutes so the thread feels like it's getting real
// organic engagement rather than an obvious instant bot dump. Backed by a
// Redis ZSET (score = due timestamp, same store already used for
// everything else here) rather than a new queue service (Upstash QStash,
// etc.) - this project already removed its one always-on cron to keep AI
// activity purely reactive, so the replacement here is deliberately the
// cheapest possible mechanism: a cron that runs often but does real work
// (a Venice call) only when something is actually due, not one that
// generates content on a blind schedule regardless of activity.
import { redisCommand } from "@/lib/store";

const QUEUE_KEY = "scheduled:ai-replies";

// Shared by both reward call sites (app/api/threads/route.ts for new
// threads, app/api/threads/[threadId]/posts/route.ts for replies) - each
// gated by lib/threadQuality.ts's scoreThreadQuality before this ever gets
// scheduled.
export const REWARD_REPLY_COUNT = 3;
export const REWARD_WINDOW_MS = 30 * 60 * 1000;

export interface ScheduledReply {
  threadId: string;
}

export async function scheduleAiReply(
  threadId: string,
  dueAtMs: number,
): Promise<void> {
  // Random suffix, not just threadId+dueAtMs - two replies for the same
  // thread can land at the same millisecond-rounded due time in theory,
  // and ZSET members must be unique or the second ZADD silently overwrites
  // the first's score instead of adding a second entry.
  const nonce = Math.random().toString(36).slice(2, 8);
  const payload: ScheduledReply = { threadId };
  await redisCommand(
    "ZADD",
    QUEUE_KEY,
    dueAtMs,
    `${JSON.stringify(payload)}#${nonce}`,
  );
}

// Schedules a few replies to the same thread at jittered offsets across
// roughly the given window, instead of one immediate one - the actual
// "reward" behavior. First one lands soon enough that the thread doesn't
// feel ignored; the rest trickle in after.
export async function scheduleStaggeredReplies(
  threadId: string,
  count: number,
  windowMs: number,
): Promise<void> {
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    // Divide the window into `count` slices and jitter within each slice,
    // rather than fully random offsets - avoids two replies landing right
    // next to each other by chance, and avoids all of them clustering near
    // the start or end.
    const sliceStart = (windowMs / count) * i;
    const sliceEnd = (windowMs / count) * (i + 1);
    const offset = sliceStart + Math.random() * (sliceEnd - sliceStart);
    await scheduleAiReply(threadId, now + offset);
  }
}

// Cost guardrail: a thread that keeps clearing the quality bar on every
// human reply could otherwise stack unbounded reward batches (3 extra
// Venice replies each time). Caps total reward batches per thread over its
// lifetime rather than capping per-time-window - a genuinely great thread
// can still earn a few waves of reward, just not infinite ones.
const REWARD_COUNT_KEY_PREFIX = "reward-count:";
const MAX_REWARD_BATCHES_PER_THREAD = 3;

export async function claimRewardSlot(threadId: string): Promise<boolean> {
  const count = (await redisCommand(
    "INCR",
    `${REWARD_COUNT_KEY_PREFIX}${threadId}`,
  )) as number;
  return count <= MAX_REWARD_BATCHES_PER_THREAD;
}

export async function popDueAiReplies(
  nowMs: number,
): Promise<ScheduledReply[]> {
  const members = (await redisCommand(
    "ZRANGEBYSCORE",
    QUEUE_KEY,
    0,
    nowMs,
  )) as string[];
  if (members.length === 0) return [];
  await redisCommand("ZREM", QUEUE_KEY, ...members);
  return members.map((raw) => {
    const [json] = raw.split("#");
    return JSON.parse(json) as ScheduledReply;
  });
}
