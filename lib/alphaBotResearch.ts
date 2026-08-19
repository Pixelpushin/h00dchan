// The actual "Alpha Bot": takes a claimed anon's real token-bound wallet
// address, pulls its real cross-chain holdings + Nansen labels, and has
// Venice narrate them as a small trade-room desk (Research/Risk/Skeptic)
// cross-referencing the same real data from different angles - not a
// single dry bullet list. This is the one part of this app's AI writing
// that is grounded in real data end to end, unlike the "AI shitposts"
// bucket (lib/dailyAlpha.ts, lib/ai-persona.ts), which is deliberately
// fictional satire. Same Venice call shape as lib/dailyAlpha.ts (same
// model, same response_format: json_object convention) - not extracted
// into a shared helper, this repo already tolerates that duplication
// elsewhere for the same "server-only vs. client-safe module boundary"
// reasons documented on lib/leaderboard.ts.
import { fetchAddressBalances, fetchAddressLabels } from "@/lib/nansen";
import {
  saveAlphaBotEntry,
  type AlphaBotEntry,
  type AlphaDesk,
} from "@/lib/alphaBotStore";

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
      temperature: 0.7,
      max_tokens: 700,
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

interface HoldingLine {
  chain: string;
  tokenSymbol: string;
  tokenName: string;
  amount: number;
  valueUsd: number;
}

function formatDataBlock(
  tokenId: string,
  address: string,
  topHoldings: HoldingLine[],
  totalValueUsd: number,
  labels: string[],
): string {
  return `Anon #${tokenId}, wallet ${address}.

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
${labels.length > 0 ? labels.join(", ") : "(none)"}`;
}

function buildDeskPrompt(dataBlock: string): string {
  return `
You are three people at a small crypto trading desk, riffing on ONE real wallet's real on-chain data pulled from Nansen for h00dchan (an anonymous message board for HOODCHAN NFT holders). Unlike every other AI-written thing on this site (which is deliberate fake satire), this is real research on a real wallet - never invent a holding, label, or number that isn't in the data below. If the data is sparse, say so plainly instead of padding it out.

The three voices:
- "Research Desk" - states what's actually in the wallet, plainly, like reading off a terminal. Casual trader voice, not corporate: e.g. "smart money label on this one, for what it's worth" or "seeing a decent NFT stack on Robinhood chain here."
- "Risk Desk" - flags anything worth a second look purely from the data (concentration in one asset, an unusual/negative label, a near-empty wallet, thin liquidity implied by small positions) - or says there's nothing notable if that's true.
- "Skeptic" - pushes back or cross-checks the other two, out loud, in the same casual voice - "can't confirm that's actually smart money just from one label," "wallet's too quiet to say much," that kind of thing. Directly reference what Research Desk or Risk Desk just said.

Real data:
${dataBlock}

Return valid JSON only, matching this shape:
{
  "desks": [
    { "name": "Research Desk", "bullets": ["...", ...] },
    { "name": "Risk Desk", "bullets": ["...", ...] },
    { "name": "Skeptic", "bullets": ["...", ...] }
  ]
}

1-3 short bullets per desk, each under 30 words, casual trading-desk tone (contractions fine, a little dry humor fine) but grounded ONLY in the real data above - do not invent anything. The LAST bullet of the Skeptic desk must always end with "DYOR." as its own short closing line, since none of this is financial advice even though it's real data.
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

  const dataBlock = formatDataBlock(
    tokenId,
    address,
    topHoldings,
    totalValueUsd,
    labels,
  );
  const raw = await callVenice(buildDeskPrompt(dataBlock), veniceApiKey);
  const parsed = JSON.parse(cleanJsonText(raw)) as { desks?: unknown };

  const desks: AlphaDesk[] = Array.isArray(parsed.desks)
    ? parsed.desks
        .filter(
          (d): d is { name: unknown; bullets: unknown } =>
            typeof d === "object" && d !== null,
        )
        .map((d) => ({
          name: typeof d.name === "string" ? d.name : "Desk",
          bullets: Array.isArray(d.bullets)
            ? d.bullets.filter((b): b is string => typeof b === "string")
            : [],
        }))
        .filter((d) => d.bullets.length > 0)
    : [];

  const entry: AlphaBotEntry = {
    tokenId,
    address,
    generatedAt: new Date().toISOString(),
    desks,
    bullets: desks.flatMap((d) => d.bullets),
    totalValueUsd,
    labels,
  };
  await saveAlphaBotEntry(entry);
  return entry;
}

// For the in-thread "talk back" continuation (owner replies again in
// their own thread) - reuses the SAME real data already pulled for the
// cached entry (no extra Nansen spend), just asks Venice for a fresh,
// short in-character response from ONE desk voice to what the owner just
// said. Deliberately narrow: this only ever fires when the reply is from
// the thread's own OP token (see lib/alphaBotEngagement.ts) - the desks
// talk to their own owner, not to random other posters in the thread.
export async function generateAlphaBotFollowUp(
  entry: AlphaBotEntry,
  ownerMessage: string,
): Promise<AlphaDesk> {
  const veniceApiKey = process.env.VENICE_API_KEY;
  if (!veniceApiKey) throw new Error("VENICE_API_KEY is not configured.");

  const dataBlock = `Total portfolio value across all chains: $${(entry.totalValueUsd ?? 0).toFixed(2)}
Labels: ${entry.labels.length > 0 ? entry.labels.join(", ") : "(none)"}
Prior desk notes:
${entry.bullets.map((b) => `- ${b}`).join("\n")}`;

  const prompt = `
You are "Research Desk" at a small crypto trading desk, continuing a conversation with the actual owner of the wallet you already researched for h00dchan. They just replied in their own thread. Respond directly to what they said, casually, grounded ONLY in the real data already gathered below - never invent a new holding or label that wasn't already found. If their message asks about something not in the data, say you don't have that, don't make it up.

${dataBlock}

Owner just said: "${ownerMessage}"

Return valid JSON only:
{ "bullets": ["1-2 short casual replies, under 30 words each, last one ending with DYOR."] }
`.trim();

  const raw = await callVenice(prompt, veniceApiKey);
  const parsed = JSON.parse(cleanJsonText(raw)) as { bullets?: unknown };
  const bullets = Array.isArray(parsed.bullets)
    ? parsed.bullets.filter((b): b is string => typeof b === "string")
    : [];
  return { name: "Research Desk", bullets };
}
