// Daily digest of the last 24h of board activity, summarized into two
// clearly-labeled bullet lists - real human posts, and AI-shitpost fake
// "alpha" - for the public /alpha page and llms.txt's Daily Alpha section.
// Reuses the same Venice call pattern already established in
// lib/ai-persona.ts and lib/threadQuality.ts (same model, same
// response_format: json_object convention) rather than a new client.
import {
  listRecentPosts,
  type DailyAlphaDigest,
  type RecentPost,
} from "@/lib/store";

export type { DailyAlphaDigest };

const VENICE_API_URL = "https://api.venice.ai/api/v1/chat/completions";
const VENICE_MODEL = "venice-uncensored-1-2";

// Bound how many posts of each kind get summarized - a big 24h window on a
// busy board could be a lot of posts, and the digest is meant to be "the
// highlights," not a full transcript. Most recent first (post ids are
// sequential/INCR'd, so a numeric sort is equivalent to chronological).
const MAX_POSTS_PER_CATEGORY = 40;

function mostRecent(posts: RecentPost[]): RecentPost[] {
  return [...posts]
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, MAX_POSTS_PER_CATEGORY);
}

function formatPost(post: RecentPost): string {
  return `Anon #${post.tokenId} in "${post.threadSubject}": ${post.body}`;
}

function buildPrompt(humanPosts: RecentPost[], aiPosts: RecentPost[]): string {
  return `
You are writing a short daily digest for h00dchan, a satire anonymous imageboard for holders of the HOODCHAN NFT collection. Summarize the last 24 hours of board activity into two separate bullet lists.

HARD RULE: everything in the AI SHITPOSTS list is fictional satire - invented tickers, invented drama, invented "alpha." Never write it in a way that could be mistaken for real information. The HUMAN POSTS list is real holders actually posting, so summarize what they genuinely said/did, not invented content.

REAL HUMAN POSTS (${humanPosts.length} in the last 24h):
${humanPosts.length > 0 ? humanPosts.map(formatPost).join("\n") : "(none in the last 24 hours)"}

AI SHITPOSTS - fake, satire only (${aiPosts.length} in the last 24h):
${aiPosts.length > 0 ? aiPosts.map(formatPost).join("\n") : "(none in the last 24 hours)"}

Return valid JSON only, matching this shape:
{
  "humanBullets": ["short bullet summarizing one real post or a cluster of related ones, referencing the anon # and topic", ...],
  "aiBullets": ["short, funny bullet summarizing one piece of fake AI drama/alpha, referencing the anon # and topic", ...]
}

Keep each bullet under 25 words. If a list has no posts, return an empty array for it - do not invent content to fill an empty section. Cap each list at 8 bullets, picking the most interesting/representative ones if there are more posts than that.
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
      temperature: 0.7,
      max_tokens: 1200,
      venice_parameters: { include_venice_system_prompt: false },
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(30_000),
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

// Generates the digest from real board data - never called with fabricated
// input. Throws on failure rather than silently returning an empty digest,
// so the caller (the cron route) can log/alert instead of quietly
// publishing nothing.
export async function generateDailyAlphaDigest(): Promise<DailyAlphaDigest> {
  const apiKey = process.env.VENICE_API_KEY;
  if (!apiKey) throw new Error("VENICE_API_KEY is not configured.");

  const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
  const recentPosts = await listRecentPosts(sinceMs);
  const humanPosts = mostRecent(recentPosts.filter((p) => p.isAi !== true));
  const aiPosts = mostRecent(recentPosts.filter((p) => p.isAi === true));

  if (humanPosts.length === 0 && aiPosts.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      humanBullets: [],
      aiBullets: [],
    };
  }

  const prompt = buildPrompt(humanPosts, aiPosts);
  const raw = await callVenice(prompt, apiKey);
  const parsed = JSON.parse(cleanJsonText(raw)) as {
    humanBullets?: unknown;
    aiBullets?: unknown;
  };

  const humanBullets = Array.isArray(parsed.humanBullets)
    ? parsed.humanBullets.filter((b): b is string => typeof b === "string")
    : [];
  const aiBullets = Array.isArray(parsed.aiBullets)
    ? parsed.aiBullets.filter((b): b is string => typeof b === "string")
    : [];

  return { generatedAt: new Date().toISOString(), humanBullets, aiBullets };
}
