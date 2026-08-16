// Pre-scan quality gate for the staggered "reward" reply system
// (lib/scheduledReplies.ts). The reward exists to make genuinely funny
// human content feel like it's getting real organic engagement - if it
// fired on every single human post regardless of quality, it would just be
// a second blind bot-spam mechanic wearing a "reward" costume. This module
// asks Venice to judge wit/satire/relevance on a 1-10 scale before a
// thread or reply qualifies for the extra staggered replies. The baseline
// one-for-one reactive reply (lib/aiEngagement.ts's triggerAiReply/
// triggerAiThread) is NOT gated by this - that's the board's normal
// "someone posted, something responds" heartbeat, separate from the reward.
import type { Post } from "@/lib/store";

const VENICE_API_URL = "https://api.venice.ai/api/v1/chat/completions";
const VENICE_MODEL = "venice-uncensored-1-2";

// Out of 10. Deliberately a real bar, not a rubber stamp - the whole point
// is that most posts do NOT get the reward, only the ones actually worth
// rewarding.
export const QUALITY_THRESHOLD = 7;

// Bound how much thread content gets sent to the judge call - same
// reasoning as THREAD_CONTEXT_POSTS in lib/aiEngagement.ts (recent context
// is what matters, not the whole thread history).
const CONTEXT_POST_LIMIT = 10;
const MIN_WORDS_TO_SCORE = 4; // not enough content to be witty about either way

export interface QualityScoreResult {
  score: number;
  passed: boolean;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function buildScoringPrompt(subject: string, posts: Post[]): string {
  const recent = posts.slice(-CONTEXT_POST_LIMIT);
  const hasHumanReply = recent.slice(1).some((p) => !p.isAi);
  const postsSection = recent
    .map((p, i) => `${i + 1}. [${p.isAi ? "AI" : "HUMAN"}] ${p.body}`)
    .join("\n");

  return `
You are a strict comedy/quality judge for an anonymous satire imageboard called h00dchan. You decide which threads are funny and sharp enough to deserve MORE AI replies piling on - most threads should NOT pass.

Score 1-10 on wit, satirical sharpness, and relevance to what's actually being posted (not generic crypto-shitpost filler):
- 1-3: boring, generic, low-effort, or a non-sequitur
- 4-6: mildly amusing, average board content
- 7-8: genuinely funny, sharp, or has a real distinctive voice
- 9-10: exceptional, the kind of post that would get screenshotted

WEIGHTING: posts tagged [HUMAN] should count for more than posts tagged [AI] - a real person being funny matters more than a bot being funny. ${
    hasHumanReply
      ? "This thread has human replies beyond the OP - weight those most heavily."
      : "No human has replied beyond the original post - that's fine and expected, judge the OP and any AI replies on their own merit rather than penalizing the thread for lacking human replies."
  }

THREAD SUBJECT: ${subject}

POSTS (oldest first):
${postsSection}

Return valid JSON only: { "score": <integer 1-10> }
`.trim();
}

interface VeniceChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string } | string;
}

async function callVenice(prompt: string, apiKey: string): Promise<string> {
  const res = await fetch(VENICE_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: VENICE_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3, // judging, not creating - want consistent scoring, not variety
      max_tokens: 60,
      venice_parameters: { include_venice_system_prompt: false },
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(20_000),
  });

  const payload = (await res.json()) as VeniceChatResponse;
  if (!res.ok) {
    const message =
      typeof payload.error === "string"
        ? payload.error
        : payload.error?.message;
    throw new Error(message || `Venice API error (${res.status})`);
  }
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Venice returned no content.");
  }
  return content;
}

function cleanJsonText(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

// Scores a thread's current content and decides whether it clears the bar
// for the reward system. Fails CLOSED (passed: false) on any error - a
// scoring hiccup should never crash a human's post, and skipping the
// bonus reward is always a safe fallback (the normal one-for-one reactive
// reply still fires regardless of this result).
export async function scoreThreadQuality(
  subject: string,
  posts: Post[],
): Promise<QualityScoreResult> {
  const apiKey = process.env.VENICE_API_KEY;
  if (!apiKey || posts.length === 0) return { score: 0, passed: false };

  const totalWords = posts.reduce((sum, p) => sum + wordCount(p.body), 0);
  if (totalWords < MIN_WORDS_TO_SCORE) return { score: 0, passed: false };

  try {
    const prompt = buildScoringPrompt(subject, posts);
    const raw = await callVenice(prompt, apiKey);
    const parsed = JSON.parse(cleanJsonText(raw)) as { score?: unknown };
    const score = Math.max(0, Math.min(10, Number(parsed.score) || 0));
    return { score, passed: score >= QUALITY_THRESHOLD };
  } catch (error) {
    console.error("scoreThreadQuality failed", error);
    return { score: 0, passed: false };
  }
}
