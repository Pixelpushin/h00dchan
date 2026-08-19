// Anon leveling system - deliberately stateless. XP is computed live from
// state that already exists elsewhere (claimed status, thread/post counts)
// rather than a separate counter that would need
// writing at every action and backfilling for every anon that already did
// these things before this shipped. Every one of the ~1198 existing anons
// gets a correct level immediately, no migration needed.
//
// Extensible on purpose: MILESTONE_QUESTS is a plain array. Adding a new
// one-time quest later (e.g. "sent your first transaction" once execute()
// UI exists) is just adding an entry here - the profile page's checklist
// and the XP total both pick it up automatically.
// threadsStarted/totalPosts must be HUMAN-authored counts only (see
// lib/store.ts's human-posts-by-token / human-threads-by-token) - an
// unclaimed anon's AI ghost-posts must never earn it XP. Callers must use
// countHumanPostsByToken/countHumanThreadsByToken, not the plain
// countPostsByToken/listThreads-derived counts used for display
// elsewhere (e.g. the profile page's "N posts" badge, which
// intentionally still counts everything as real activity history).
export interface QuestInput {
  claimed: boolean;
  threadsStarted: number;
  totalPosts: number;
  // "Used your powers" milestone - the TBA's own on-chain tx count > 0.
  hasSentTransaction: boolean;
  // Full weeks the CURRENT owner has held this specific token (see
  // lib/collectionSnapshot.ts's weeksHeld) - resets to 0 the instant the
  // token changes hands, which is what makes a flipper naturally earn
  // ~nothing from this category without needing a separate penalty.
  hodlerWeeks: number;
  // Other live HOODCHAN tokens the SAME wallet also holds right now
  // (lib/collectionSnapshot.ts's extraCollectionTokens).
  extraCollectionTokens: number;
  // True if this token's owner is currently the single largest HOODCHAN
  // holder collection-wide (lib/collectionSnapshot.ts's isTopHolder) -
  // live, can be lost the moment someone else overtakes #1.
  isTopHolder: boolean;
  // Other live HOODCHAN tokens sitting inside THIS token's own
  // token-bound wallet (lib/collectionSnapshot.ts's nestedHoldingCount) -
  // the "hold hoodchans in a hoodchan" recursive mechanic.
  nestedHoldingCount: number;
  // True once this token's owner has proven they control a real X account
  // whose bio names hoodchan.org (lib/bioVerifyStore.ts's status ===
  // "verified") - unlike the holding-based metrics above, this isn't
  // wealth-gated (any holder can do it regardless of how much they own),
  // so it's weighted higher than the other one-time milestones on purpose:
  // it's a real, unbought traffic/marketing signal, not a flex.
  bioVerified: boolean;
}

export interface QuestStatus {
  id: string;
  label: string;
  xp: number;
  done: boolean;
}

interface MilestoneQuest {
  id: string;
  label: string;
  xp: number;
  isDone: (input: QuestInput) => boolean;
}

const MILESTONE_QUESTS: MilestoneQuest[] = [
  {
    id: "activate-anon",
    label: "Activate this anon (claim it, silence its AI)",
    xp: 50,
    isDone: (i) => i.claimed,
  },
  {
    id: "first-thread",
    label: "Post your first thread as this anon",
    xp: 100,
    isDone: (i) => i.threadsStarted >= 1,
  },
  {
    id: "first-reply",
    label: "Reply to a thread as this anon",
    xp: 100,
    isDone: (i) => i.totalPosts - i.threadsStarted >= 1,
  },
  {
    id: "sent-transaction",
    label: "Send your first transaction from this anon's wallet",
    xp: 75,
    isDone: (i) => i.hasSentTransaction,
  },
  {
    id: "bio-verified",
    label: "Verify a real X account with hoodchan.org in the bio",
    xp: 200,
    isDone: (i) => i.bioVerified,
  },
];

// Every post (thread or reply) beyond the milestones above keeps earning
// XP forever - this is the "level all the way up by posting" driver Brady
// asked for, uncapped rather than a one-time bonus. This is the "Builder"
// category on the profile/leaderboard breakdown.
const XP_PER_POST = 10;

// Hodler streak - rewards NOT selling. Resets to 0 the instant the token
// changes hands (see QuestInput.hodlerWeeks), which is what makes a
// flipper naturally earn ~nothing here without a separate penalty metric.
// Capped at a year's worth so an early buyer who never touches the site
// again can't permanently out-level someone actually building the
// community - dedicated hodling stays a strong, real strategy, just not
// an unbeatable one.
const HODLER_XP_PER_WEEK = 100;
const HODLER_MAX_WEEKS = 52;

// Collector bonus - other HOODCHAN tokens the same wallet also holds.
// Deliberately capped low: a big personal holding should nudge a token up
// the board, but should never outrun what patient long-term hodling alone
// can earn (Brady's own explicit ask - his top-holder wallet shouldn't be
// unbeatable just by holding count).
const COLLECTOR_XP_PER_EXTRA_TOKEN = 20;
const COLLECTOR_MAX_EXTRA_TOKENS = 5;

// Top Holder crown - flat and modest for the same reason as the collector
// cap above. Live: can change hands the moment someone else overtakes #1.
const TOP_HOLDER_XP = 50;

// Nested holding - a HOODCHAN token's own token-bound wallet holding
// OTHER HOODCHAN tokens inside it. A recursive flex unique to this
// project's own TBA infra - naturally self-limiting (bounded by the
// collection's own size), so no cap needed.
const NESTED_HOLDING_XP_PER_TOKEN = 30;

// Flat 100 XP per level - simple to reason about, easy to re-tune later
// without touching anything else (every level number is derived from this
// one constant, nothing hardcodes level thresholds elsewhere).
const LEVEL_XP_STEP = 100;

// Labeled XP breakdown for the profile/leaderboard UI - lets a page show
// "Builder 340 / Hodler 1200 / Collector 60 / Nested 30" instead of just a
// single opaque total.
export interface XpBreakdown {
  milestoneXp: number;
  builderXp: number;
  hodlerXp: number;
  collectorXp: number;
  topHolderXp: number;
  nestedXp: number;
}

export interface LevelProgress {
  quests: QuestStatus[];
  breakdown: XpBreakdown;
  totalXp: number;
  level: number;
  xpIntoLevel: number;
  xpForNextLevel: number;
}

export function computeLevelProgress(input: QuestInput): LevelProgress {
  const quests = MILESTONE_QUESTS.map((q) => ({
    id: q.id,
    label: q.label,
    xp: q.xp,
    done: q.isDone(input),
  }));

  const milestoneXp = quests
    .filter((q) => q.done)
    .reduce((sum, q) => sum + q.xp, 0);
  const builderXp = input.totalPosts * XP_PER_POST;
  const hodlerXp =
    Math.min(input.hodlerWeeks, HODLER_MAX_WEEKS) * HODLER_XP_PER_WEEK;
  const collectorXp =
    Math.min(input.extraCollectionTokens, COLLECTOR_MAX_EXTRA_TOKENS) *
    COLLECTOR_XP_PER_EXTRA_TOKEN;
  const topHolderXp = input.isTopHolder ? TOP_HOLDER_XP : 0;
  const nestedXp = input.nestedHoldingCount * NESTED_HOLDING_XP_PER_TOKEN;

  const breakdown: XpBreakdown = {
    milestoneXp,
    builderXp,
    hodlerXp,
    collectorXp,
    topHolderXp,
    nestedXp,
  };
  const totalXp =
    milestoneXp + builderXp + hodlerXp + collectorXp + topHolderXp + nestedXp;

  const level = Math.floor(totalXp / LEVEL_XP_STEP) + 1;
  const xpIntoLevel = totalXp % LEVEL_XP_STEP;

  return {
    quests,
    breakdown,
    totalXp,
    level,
    xpIntoLevel,
    xpForNextLevel: LEVEL_XP_STEP,
  };
}
