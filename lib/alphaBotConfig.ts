// Alpha Bot eligibility is a fixed SNAPSHOT, not a rolling hold-duration
// window - explicit correction after the original 4-weeks-held rule shipped
// and immediately locked out the site owner's own long-time test wallet
// (TBAs only activated collection-wide on 2026-08-18, so almost nobody
// could hit 4 weeks yet). The real rule: anyone who already held their
// anon as of this cutoff qualifies, permanently, regardless of how long
// that turns out to be - and nobody who acquires a token AFTER this
// cutoff qualifies, no matter how long THEY end up holding it, until this
// constant is deliberately moved forward. "No one else after today will
// get it until I figure out what next steps look like" - a one-time
// reward for existing believers, not an ongoing loyalty program (yet).
export const ALPHA_BOT_SNAPSHOT_CUTOFF_MS = Date.parse(
  "2026-08-19T15:24:42.000Z",
);

// Hard site-wide cap, not per-anon - "this is a total experiment... limit
// responses to several a day total" (explicit cost ceiling, independent of
// how many holders qualify or how active they are). Counts trigger EVENTS
// (one new-thread desk round, or one in-thread follow-up), not individual
// reply posts within an event - a qualifying thread still gets its full
// 3-desk response, it just counts as one toward this cap. See
// lib/alphaBotStore.ts's consumeDailyAlphaBotBudget for the atomic check.
export const MAX_ALPHA_BOT_EVENTS_PER_DAY = 5;

// Per-anon cap, independent of the site-wide budget above - closes a real
// gap: a cache-hit event (still within the 24h research cooldown) costs
// zero real Nansen/Venice spend, so it never touches
// MAX_ALPHA_BOT_EVENTS_PER_DAY at all. Without this, one qualifying holder
// could script new threads as fast as the write-path rate limiter allows
// and get an unbounded number of free desk replies (stale, identical
// research restated over and over) - a spam/board-quality problem even
// though it costs the site nothing in API spend. Deliberately well under
// the site-wide cap so no single anon can monopolize the real-spend budget
// either.
export const MAX_ALPHA_BOT_POSTS_PER_TOKEN_PER_DAY = 2;

// Alpha Bot's one narrow exception to "only humans start new threads"
// (explicit instruction) - it can headline a brand-new thread of its own,
// but only for a genuinely notable finding (judged by Venice alongside the
// normal desk research, see lib/alphaBotResearch.ts's "newsworthy" field -
// a high bar by design, most wallets should never clear it) AND at most
// once per this cooldown, site-wide, regardless of how many different
// anons' research would otherwise qualify. "Once a couple days" (explicit
// instruction) - keeps this feeling like real, occasional alpha (the
// @aixbt_agent-style bar it's modeled on), not another recurring bot
// mechanic. See lib/alphaBotStore.ts's consumeAlphaBotNewThreadCooldown.
export const ALPHA_BOT_NEW_THREAD_COOLDOWN_DAYS = 2;

// Standard warning, verbatim, everywhere Alpha Bot content shows up - the
// wallet-page panel, the public /alpha page, and every single reply it
// posts on the board (see lib/alphaBotEngagement.ts). Explicit instruction:
// "every post go hard so people know this may not be accurate and may be
// bad advice." Real data in, AI narration out is still AI narration - the
// underlying Nansen pull can itself be delayed/stale, and the write-up on
// top of it can misread or flat-out hallucinate regardless of how real the
// source data was.
export const ALPHA_BOT_DISCLAIMER =
  "⚠ NOT FINANCIAL ADVICE. Educational/experimental use only. This is AI-narrated commentary on real third-party data (Nansen) - the underlying data can be delayed or outdated, and the AI writing this can still misread it or flat-out hallucinate regardless of how real the source is. Enter at your own risk. Always DYOR.";

// Required, not optional - Nansen's API Terms of Service (nansen.ai/legal/
// api) mandate visible attribution ("Powered by Nansen" / "Data provided
// by Nansen") anywhere their data is publicly displayed, which every
// Alpha Bot surface (board posts, wallet page, /alpha page) is. Kept as
// its own constant, separate from the disclaimer above, since it's a
// contractual requirement, not a safety/legal-liability warning.
export const ALPHA_BOT_ATTRIBUTION = "Data via Nansen.";
