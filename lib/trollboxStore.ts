// Live flat scrolling chat - the classic crypto-site "troll box" pattern.
// No threads/subjects, no AI replies, just a capped-length RPUSH list of
// recent messages, same redisCommand primitive as lib/store.ts's board
// (thread:counter INCR, thread:<id> JSON blob pattern) but simpler: one
// list, always trimmed to the last MAX_MESSAGES on write, so it never
// grows unbounded like the board's permanent archive is allowed to.
import { redisCommand } from "@/lib/store";

export interface TrollboxMessage {
  id: string;
  // null only for bridged messages (see addBridgedTrollboxMessage) - those
  // aren't attributable to any specific claimed anon, so there's no real
  // tokenId to attach. Every message written via the public, wallet-signed
  // POST /api/trollbox route always has a real one.
  tokenId: string | null;
  body: string;
  createdAt: string;
  // Present only for messages relayed in from elsewhere (e.g. the X chat
  // bridge) - never set by the normal signed posting path. Rendered
  // distinctly (see TrollboxWidget) so it's always honest about not being
  // a real board member's own words, same "always labeled, never passed
  // off as a real holder's words" promise Post.isAi already makes.
  source?: "x-bridge";
}

const MESSAGES_KEY = "trollbox:messages";
export const MAX_MESSAGES = 200;

async function nextTrollboxId(): Promise<string> {
  const id = await redisCommand("INCR", "trollbox:counter");
  return String(id);
}

export async function addTrollboxMessage(
  tokenId: string,
  body: string,
): Promise<TrollboxMessage> {
  const message: TrollboxMessage = {
    id: await nextTrollboxId(),
    tokenId,
    body,
    createdAt: new Date().toISOString(),
  };
  await redisCommand("RPUSH", MESSAGES_KEY, JSON.stringify(message));
  // Trim right after every write rather than on read - keeps the list's
  // on-disk size bounded continuously instead of letting it balloon
  // between occasional cleanup passes.
  await redisCommand("LTRIM", MESSAGES_KEY, -MAX_MESSAGES, -1);
  return message;
}

// Server-only - deliberately NOT exposed via the public POST /api/trollbox
// route, which requires a real wallet-signed persona claim. This is for
// the X-chat bridge (app/api/admin/trollbox-bridge/route.ts), which is
// requireAdmin-gated (wallet-signed admin claim OR the cron bearer
// secret) instead, since relayed messages have no claimed anon to sign as.
export async function addBridgedTrollboxMessage(
  body: string,
): Promise<TrollboxMessage> {
  const message: TrollboxMessage = {
    id: await nextTrollboxId(),
    tokenId: null,
    body,
    createdAt: new Date().toISOString(),
    source: "x-bridge",
  };
  await redisCommand("RPUSH", MESSAGES_KEY, JSON.stringify(message));
  await redisCommand("LTRIM", MESSAGES_KEY, -MAX_MESSAGES, -1);
  return message;
}

export async function listTrollboxMessages(): Promise<TrollboxMessage[]> {
  const raw = (await redisCommand(
    "LRANGE",
    MESSAGES_KEY,
    -MAX_MESSAGES,
    -1,
  )) as string[];
  return raw
    .map((entry) => {
      try {
        return JSON.parse(entry) as TrollboxMessage;
      } catch {
        return null;
      }
    })
    .filter((m): m is TrollboxMessage => m !== null);
}
