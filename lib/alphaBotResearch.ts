// The actual "Alpha Bot": takes a claimed anon's real token-bound wallet
// address, pulls its real cross-chain holdings + Nansen labels, and has
// Venice narrate them into a few short bullets - the one part of this
// app's AI writing that is grounded in real data end to end, unlike the
// "AI shitposts" bucket (lib/dailyAlpha.ts, lib/ai-persona.ts), which is
// deliberately fictional satire. Same Venice call shape as
// lib/dailyAlpha.ts (same model, same response_format: json_object
// convention) - not extracted into a shared helper, this repo already
// tolerates that duplication elsewhere for the same "server-only vs.
// client-safe module boundary" reasons documented on lib/leaderboard.ts.
import { fetchAddressBalances, fetchAddressLabels } from "@/lib/nansen";
import { saveAlphaBotEntry, type AlphaBotEntry } from "@/lib/alphaBotStore";

const VENICE_API_URL = "https://api.venice.ai/api/v1/chat/completions";
const VENICE_MODEL = "venice-uncensored-1-2";
const MAX_HOLDINGS_IN_PROMPT = 10;

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
      temperature: 0.6,
      max_tokens: 500,
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

function buildPrompt(
  tokenId: string,
  address: string,
  topHoldings: Array<{
    chain: string;
    tokenSymbol: string;
    tokenName: string;
    amount: number;
    valueUsd: number;
  }>,
  totalValueUsd: number,
  labels: string[],
): string {
  return `
You are the "Alpha Bot" for h00dchan, an anonymous message board for HOODCHAN NFT holders. Unlike every other AI-written thing on this site (which is deliberate fake satire), your job is to summarize REAL on-chain research data pulled from Nansen about one specific anon's real crypto wallet. Never invent a holding, label, or number that isn't in the data below - if the data is sparse, say so plainly instead of padding it out.

Anon #${tokenId}, wallet ${address}.

Total portfolio value across all chains: $${totalValueUsd.toFixed(2)}

Top holdings (${topHoldings.length}):
${
  topHoldings.length > 0
    ? topHoldings
        .map(
          (h) =>
            `- ${h.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${h.tokenSymbol} (${h.tokenName}) on ${h.chain}, worth $${h.valueUsd.toFixed(2)}`,
        )
        .join("\n")
    : "(none found)"
}

Nansen labels on this address (${labels.length}):
${labels.length > 0 ? labels.join(", ") : "(none)"}

Return valid JSON only, matching this shape:
{
  "bullets": ["short factual bullet grounded only in the data above", ...]
}

Write 2-5 bullets, each under 30 words, dry and factual (this is real research, not a joke) but you can have a LITTLE personality - a bit deadpan is fine. If there's genuinely nothing interesting (empty/near-empty wallet, no labels), one honest bullet saying so is correct - do not stretch to fill more.
`.trim();
}

export async function generateAlphaBotResearch(
  tokenId: string,
  address: string,
): Promise<AlphaBotEntry> {
  const veniceApiKey = process.env.VENICE_API_KEY;
  if (!veniceApiKey) throw new Error("VENICE_API_KEY is not configured.");

  const [balances, labelResults] = await Promise.all([
    fetchAddressBalances(address).catch(() => []),
    fetchAddressLabels(address).catch(() => []),
  ]);

  const totalValueUsd = balances.reduce((sum, b) => sum + b.valueUsd, 0);
  const topHoldings = [...balances]
    .sort((a, b) => b.valueUsd - a.valueUsd)
    .slice(0, MAX_HOLDINGS_IN_PROMPT);
  const labels = labelResults.map((l) => l.label);

  const prompt = buildPrompt(
    tokenId,
    address,
    topHoldings,
    totalValueUsd,
    labels,
  );
  const raw = await callVenice(prompt, veniceApiKey);
  const parsed = JSON.parse(cleanJsonText(raw)) as { bullets?: unknown };
  const bullets = Array.isArray(parsed.bullets)
    ? parsed.bullets.filter((b): b is string => typeof b === "string")
    : [];

  const entry: AlphaBotEntry = {
    tokenId,
    address,
    generatedAt: new Date().toISOString(),
    bullets,
    totalValueUsd,
    labels,
  };
  await saveAlphaBotEntry(entry);
  return entry;
}
