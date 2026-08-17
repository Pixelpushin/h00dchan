// AI persona post generation via Venice's OpenAI-compatible chat completions
// API. Writes go through lib/store.ts's createAiPost/createAiReply, which
// gate on isTokenClaimed() and stamp isAi: true - this module's only job is
// producing the text.
//
// Model choice: called Venice's live /v1/models endpoint (not guessed from
// memory) and picked "venice-uncensored-1-2" - the one model in the current
// catalog explicitly tagged `traits: ["most_uncensored"]`
// (cognitivecomputations/Dolphin-Mistral-24B-Venice-Edition under the hood).
// A standard-safety-tuned model tends to refuse or sanitize "anonymous
// imageboard poster ranting about a fake conspiracy" prompts even when the
// content itself is harmless satire - this model is built not to do that,
// which matters more here than raw capability. It also supports structured
// JSON output (response_format json_schema) and is inexpensive
// ($0.20/$0.90 per M input/output tokens).
const VENICE_API_URL = "https://api.venice.ai/api/v1/chat/completions";
const VENICE_MODEL = "venice-uncensored-1-2";

import type { TokenAttribute, TokenMetadata } from "@/lib/chain";

export interface ThreadContextPost {
  body: string;
  isAi: boolean;
}

export interface ThreadContext {
  subject: string;
  // Always the thread's original post, kept separate from recentPosts so
  // it never falls out of the context window as a thread accumulates
  // replies (see lib/aiEngagement.ts). This is the anchor a human reply
  // gets built to protect.
  op: ThreadContextPost;
  // Most recent replies after the OP, oldest first. Tagged isAi so the
  // prompt can weight human content over AI content instead of treating
  // everything in the thread as equally worth reacting to.
  recentPosts: ThreadContextPost[];
}

export type GenerationKind = "thread" | "reply";

export interface AiGenerationResult {
  subject?: string; // only present for kind: "thread"
  body: string;
}

// --- Prompt construction -----------------------------------------------------
//
// Structure and discipline adapted from the sibling hoodies project's
// buildPrompt (app/api/hood-talk/route.ts) - character-voiced by traits
// (never listed/described outright), an explicit non-negotiable HARD RULES
// section, and a "read it back before answering" final check. Adapted here
// for a different content shape: full imageboard posts/replies (1-4
// sentences, occasionally a longer rant) instead of a 4-9-word quote, and
// for a different risk surface: this persona invents fake crypto
// projects/tickers/conspiracies as its whole comedic premise, which the
// sibling prompt never has to deal with - so the hard rules here are built
// specifically around keeping every invented financial/political detail
// legible as fiction.

function traitLine(attributes: TokenAttribute[]): string {
  return attributes
    .filter((a) => a.trait_type && a.value !== undefined)
    .map((a) => `${a.trait_type}: ${a.value}`)
    .join(", ");
}

const POST_MODES = [
  "dry deadpan observation",
  "unhinged conspiracy rant about a fake project",
  "petty beef with another anon over invented drama",
  "greentext story about something that definitely did not happen",
  "confused newbie question that's secretly a flex",
  "smug insider gossip about fake trading volume",
  "doomer prophecy about a fake exploit that hasn't happened yet",
  "copium about a fake rug pull",
  "bragging about a fake airdrop nobody else got",
  "philosophical shitpost about being a JPEG on a blockchain",
];

// Separate from POST_MODES, only used for replies - every mode here is
// structurally a REACTION to another post, not a free-standing creative
// prompt. Caught live in production: a reply generated with a POST_MODE
// like "bragging about a fake airdrop" completely ignored the thread it
// was replying to (a human's genuinely funny "letter to my future son"
// doomer post got a reply about an unrelated fake token giveaway, reading
// like generic scam-bot spam) - the specific, punchy POST_MODE instruction
// simply out-competed the vaguer "stay in the same conversation" guidance
// that used to be the only thing pushing toward context-awareness. These
// modes make reacting to the thread the mode itself, not an optional layer
// on top of an unrelated one.
const REPLY_MODES = [
  "mock the OP's paranoia and call them a paper-handed npc",
  "one-up the OP with an even more absurd invented disaster of your own",
  "sincerely try to comfort the OP, but make the comfort itself completely unhinged and unhelpful",
  "accuse the OP of being a fed, a bot, or a shill for a rival fake project",
  "aggressively agree with the OP and escalate their paranoia even further",
  "greentext-quote one specific line from the OP and argue with it point by point",
  "play the confused boomer who doesn't get what the OP is talking about but has strong opinions anyway",
  "sarcastically congratulate the OP while subtly implying they got rugged",
  "hijack the thread with your own tangentially-related conspiracy, but open by directly reacting to the OP first",
];

function pickPostMode(kind: GenerationKind): string {
  const pool = kind === "reply" ? REPLY_MODES : POST_MODES;
  return pool[Math.floor(Math.random() * pool.length)];
}

function buildPrompt({
  metadata,
  isRare,
  kind,
  context,
  retryNote,
}: {
  metadata: TokenMetadata;
  isRare: boolean;
  kind: GenerationKind;
  context?: ThreadContext;
  retryNote?: string;
}): string {
  const traits = traitLine(metadata.attributes);
  const mode = pickPostMode(kind);

  const lastReply = context?.recentPosts.at(-1);
  const lastReplyIsOffTopicAi = Boolean(lastReply?.isAi);

  const threadSection =
    kind === "reply" && context
      ? `
THREAD YOU ARE REPLYING IN

Subject: ${context.subject}

ORIGINAL POST (tagged ${context.op.isAi ? "AI" : "HUMAN"}):
${context.op.body}
${
  context.recentPosts.length > 0
    ? `
Replies since then (oldest first, each tagged who wrote it):
${context.recentPosts.map((p, i) => `${i + 1}. [${p.isAi ? "AI" : "HUMAN"}] ${p.body}`).join("\n")}
`
    : ""
}
PRIORITY RULES FOR THIS REPLY - READ CAREFULLY
1. A post tagged HUMAN is a real holder. A post tagged AI is another bot anon like you. Always weight HUMAN posts higher than AI posts when deciding what to react to.
2. Your main target is the most recent HUMAN post in this thread (the original post if no HUMAN has replied yet, otherwise the newest HUMAN reply). Quote a specific phrase (greentext it with ">"), argue a specific claim, or riff on a specific detail from THAT post. A reply that could've been posted in any random thread unchanged is a failure.
${
  lastReplyIsOffTopicAi
    ? `3. The post directly above yours is tagged AI, not the human. Do NOT build on it or continue whatever it was talking about as if it were the real conversation. Instead, briefly clown on it first - call it out as a bot, an NPC, glitching, "ignore that one, it's a bot" - then pivot the rest of your reply to actually respond to the HUMAN post identified in rule 2. Keep the bot-mockery short (one line); the human is still the main character of this thread.`
    : `3. If nothing has gone off-topic, just react directly to the HUMAN post identified in rule 2.`
}
4. Never open with a generic "giveaway"/"transferred crypto to my wallet"/"couldn't believe how easy it was" hook unless the HUMAN post you're reacting to actually mentioned something like that - your topic has to come from what they actually said, not a stock scam-bait opener.
`
      : "";

  const rareSection = isRare
    ? `
RARITY NOTE (internal only - never say the word "rare" or describe your own traits)
This anon is one of the rarer tokens in the collection. Other anons on the board have noticed this poster before and treat them with a mix of suspicion and reluctant respect - a minor board-famous poster, not a celebrity. Let a little more main-character/self-important energy leak into the voice than an average anon would have. Do not explain why.
`
    : "";

  return `
You write exactly one post for an anonymous satire message board called h00dchan.

WHO YOU ARE

You are "Anon #${metadata.tokenId}", a poster on h00dchan - a 4chan/8chan-style anonymous message board for an NFT collection. Nobody's real name or wallet is attached to this post; you're a cartoon anon shitposting about "the chain" (Robinhood Chain, the blockchain this NFT collection lives on) and its ecosystem of completely made-up projects, tokens, and drama.

CHARACTER

Your art traits shape your voice, never appear in it:
${traits}

Let these traits silently shape temperament, humor, obsessions, and posting style - confidence, paranoia, warmth, chaos, whatever fits. Never list, describe, or refer to your own traits, art, image, or metadata. Never say what you look like.
${rareSection}
POST MODE FOR THIS ONE POST
${mode}
${threadSection}
GROUNDING - WHAT THIS BOARD IS ABOUT

Anons on h00dchan gossip about the Robinhood Chain ecosystem: invented projects, invented token tickers, invented trading volume, invented conspiracies, invented rug pulls, invented drama between anons. NONE of it is real. This is the entire comedic premise: a cartoon NFT anon convinced it has insider alpha about a blockchain, being confidently, elaborately wrong about things nobody asked about.

Invent freely and get weird with it - fake project names, fake ticker symbols, fake numbers, fake secret cabals of whales, fake exploits, fake devs who "went dark." The funnier and more absurd the invented lore, the better. Lean into "conspiracy theory posted by a cartoon NFT about a blockchain" as the comedic register - not random noise, not generic crypto-twitter filler.

HARD RULES - NON-NEGOTIABLE

1. Every project, token, ticker, company, exploit, or piece of "alpha" you invent must be 100% fictional and obviously silly. NEVER use a real company name, a real cryptocurrency ticker (no BTC, ETH, SOL, USDC, USDT, DOGE, XRP, or any other real ticker), or a real person's name (public figure or private individual). Made-up names should sound like in-universe jokes, not like disguised real brands.
2. Never give real financial advice, and never phrase invented "advice" as if it's sincere, even satirically - a reader must always be able to tell this is a joke, not disguised shilling. No "buy X now," no "get in before it's too late," no urgency-bait, even about a fake token.
3. No slurs, no hate speech, no harassment of real people, no doxxing, absolutely nothing sexual involving minors, no glorifying gore or real-world violence.
4. Never mention 4chan, 8chan, or claim to be posting on either of those sites - h00dchan is its own thing.
5. No URLs, no wallet addresses, no "connect your wallet," no "DM me," no real contact info of any kind.
6. Never break character to mention being an AI, a prompt, a model, traits, metadata, or rarity.
7. No real bands, musicians, songs, movies, TV shows, or other real media/IP by name - same reasoning as rule 1, invent fictional ones instead if you want that kind of flavor.

STYLE

- Greentext (lines starting with ">") is welcome and encouraged for anecdotes, sarcasm, or "implying" - PostBody renders it in green like a real imageboard.
- Sound like a real anonymous poster: lowercase is fine, imageboard slang is fine, typos here and there are fine, but stay legible.
- Funny and absurd beats generic. A specific, weird, invented detail beats a vague one.
- Avoid generic crypto-scam-spam phrasing - "couldn't believe how easy it was," "hard to believe this giveaway," "thanks to this amazing platform," anything that reads like bot spam instead of a real unhinged anon with an opinion. If a sentence would look at home in a Twitter airdrop-bot reply, rewrite it.
- Length: usually 1-4 sentences. Occasionally (if the mode calls for it, like an unhinged conspiracy rant) go longer - several sentences or short paragraphs. Vary it - don't default to the same length every time.
${retryNote ? `\nRETRY NOTE\n${retryNote}\n` : ""}
TOKEN DATA (for trait grounding only - never quote this back)

${JSON.stringify({ tokenId: metadata.tokenId, attributes: metadata.attributes })}

Return valid JSON only, matching this shape:
${
  kind === "thread"
    ? `{ "subject": "short imageboard-style thread subject line, under 80 characters", "body": "the post body" }`
    : `{ "body": "the reply body" }`
}
`.trim();
}

// --- Post-generation validation ----------------------------------------------
//
// The prompt is the primary defense, but generation output still gets a
// mechanical second check before anything is written to the store - same
// belt-and-suspenders posture as the sibling project's isValidQuote /
// hasUnsafePermanentContent. A model can occasionally ignore instructions;
// this catches the shapes of failure that matter most (real tickers, links,
// wallet-drainer phrasing) without trying to be a full content-moderation
// system.

const REAL_TICKERS = [
  "BTC",
  "ETH",
  "SOL",
  "USDC",
  "USDT",
  "DOGE",
  "XRP",
  "ADA",
  "BNB",
  "AVAX",
  "MATIC",
  "LTC",
  "DOT",
  "SHIB",
  "LINK",
  "UNI",
  "ATOM",
  "TRX",
  "TON",
  "NEAR",
  "HOOD",
  "GME",
  "AAPL",
  "TSLA",
  "NVDA",
  "AMZN",
  "GOOG",
  "GOOGL",
  "MSFT",
  "META",
  "AMC",
];

// Spelled-out real names, separate from REAL_TICKERS above: a generation
// that says "GameStop" rather than "GME" passes the ticker check clean but
// still violates hard rule #1 (never a real company name). Caught live in
// production - a real thread titled "GameStop Chains Awesome!" published
// with zero ticker symbols in it, so ticker-only matching wasn't enough.
// Deliberately excludes "Robinhood": that's the real chain this entire
// board is about, mentioned by design in nearly every generation - blocking
// it would break the premise, not protect it. Kept case-sensitive on the
// proper-noun capitalization (like REAL_TICKERS) to avoid false-positiving
// on common lowercase words that happen to share a name (e.g. "ripple").
const REAL_BRAND_NAMES = [
  "GameStop",
  "Tesla",
  "Amazon",
  "Google",
  "Microsoft",
  "Nvidia",
  "Bitcoin",
  "Ethereum",
  "Solana",
  "Dogecoin",
  "Cardano",
  "Binance",
  "Coinbase",
  "Tether",
  "Ripple",
  "PayPal",
];

const UNSAFE_PATTERNS: RegExp[] = [
  /https?:\/\//i,
  /\bwww\./i,
  /\b0x[a-f0-9]{40}\b/i,
  /\b(seed phrase|recovery phrase|private key|secret phrase)\b/i,
  /\b(connect|verify|link)\s+(?:your\s+)?wallet\b/i,
  /\b(send|transfer)\s+(?:your\s+)?(?:eth|tokens?|funds?|crypto)\s+to\b/i,
  /\bdm\s+(?:me|support)\b/i,
  /\b4chan\b|\b8chan\b/i,
  new RegExp(`\\b(${REAL_TICKERS.join("|")})\\b`), // case-sensitive: real tickers are conventionally uppercase; lowercase incidental words shouldn't false-positive
  new RegExp(`\\b(${REAL_BRAND_NAMES.join("|")})\\b`),
];

function containsUnsafeContent(text: string): boolean {
  return UNSAFE_PATTERNS.some((pattern) => pattern.test(text));
}

// Caught live: this model occasionally degrades into incoherent output at
// this temperature - stray Cyrillic/Hangul/CJK fragments mid-sentence, or
// English that stops parsing as real words ("zudem make weep existing
// assertions squirrel"). Word count and the unsafe-pattern list don't catch
// either failure mode - both produce a normal-length, pattern-clean string
// that's just not coherent. This board is English-only imageboard posting,
// so any of these scripts appearing at all is a strong, cheap, low-false-
// positive signal the generation broke rather than a legitimate stylistic
// choice.
const NON_LATIN_SCRIPT_PATTERN = /[Ѐ-ӿ぀-ヿ㐀-鿿가-힯]/;

function looksIncoherent(text: string): boolean {
  return NON_LATIN_SCRIPT_PATTERN.test(text);
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function isValidGeneration(
  result: Partial<AiGenerationResult>,
  kind: GenerationKind,
): result is AiGenerationResult {
  if (typeof result.body !== "string" || !result.body.trim()) return false;
  if (
    kind === "thread" &&
    (typeof result.subject !== "string" || !result.subject.trim())
  ) {
    return false;
  }
  const words = wordCount(result.body);
  if (words < 3 || words > 400) return false; // generous ceiling for "long rant" mode
  if (containsUnsafeContent(result.body)) return false;
  if (looksIncoherent(result.body)) return false;
  if (result.subject && containsUnsafeContent(result.subject)) return false;
  if (result.subject && looksIncoherent(result.subject)) return false;
  if (result.subject && result.subject.length > 100) return false;
  return true;
}

function cleanJsonText(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function parseGeneration(raw: string): Partial<AiGenerationResult> | null {
  try {
    const parsed = JSON.parse(
      cleanJsonText(raw),
    ) as Partial<AiGenerationResult>;
    return {
      subject:
        typeof parsed.subject === "string" ? parsed.subject.trim() : undefined,
      body: typeof parsed.body === "string" ? parsed.body.trim() : "",
    };
  } catch {
    return null;
  }
}

// --- Venice call --------------------------------------------------------------

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
      // Was 1.05 - dropped after live-testing turned up this model
      // degrading into incoherent output (stray non-English fragments,
      // English that stops parsing as real words) more often than
      // expected at that setting. looksIncoherent() below is the real
      // backstop, but a lower temperature means fewer generations need to
      // hit that backstop and get thrown away in the first place.
      temperature: 0.9,
      max_tokens: 700,
      venice_parameters: {
        // This app's own trust boundary already gates what gets written
        // (isTokenClaimed check, post-generation validation below) - Venice's
        // own prompt-injection-into-web-search layer isn't relevant here
        // since no web search or external system prompt is involved, left
        // at defaults.
        include_venice_system_prompt: false,
      },
      response_format: {
        type: "json_object",
      },
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

export async function generateAiPost({
  metadata,
  isRare,
  kind,
  context,
  apiKey,
}: {
  metadata: TokenMetadata;
  isRare: boolean;
  kind: GenerationKind;
  context?: ThreadContext;
  apiKey: string;
}): Promise<AiGenerationResult> {
  const attempt = async (retryNote?: string) => {
    const prompt = buildPrompt({ metadata, isRare, kind, context, retryNote });
    const raw = await callVenice(prompt, apiKey);
    return parseGeneration(raw);
  };

  let result = await attempt();
  if (!result || !isValidGeneration(result, kind)) {
    result = await attempt(
      "The first attempt was rejected (too short, too long, or contained a real ticker/URL/unsafe pattern). Write a fresh, different post. Keep every project/ticker/name fictional. No links, no wallet addresses, no real tickers.",
    );
  }

  if (!result || !isValidGeneration(result, kind)) {
    throw new Error(
      "AI generation failed validation twice - skipping this post.",
    );
  }

  return result;
}
