// Anon leveling system - deliberately stateless. XP is computed live from
// state that already exists elsewhere (claimed status, TBA activation,
// thread/post counts) rather than a separate counter that would need
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
  walletActivated: boolean;
  threadsStarted: number;
  totalPosts: number;
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
    id: "activate-wallet",
    label: "Enable sending for this anon's wallet",
    xp: 50,
    isDone: (i) => i.walletActivated,
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
];

// Every post (thread or reply) beyond the milestones above keeps earning
// XP forever - this is the "level all the way up by posting" driver Brady
// asked for, uncapped rather than a one-time bonus.
const XP_PER_POST = 10;

// Flat 100 XP per level - simple to reason about, easy to re-tune later
// without touching anything else (every level number is derived from this
// one constant, nothing hardcodes level thresholds elsewhere).
const LEVEL_XP_STEP = 100;

export interface LevelProgress {
  quests: QuestStatus[];
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
  const totalXp = milestoneXp + input.totalPosts * XP_PER_POST;

  const level = Math.floor(totalXp / LEVEL_XP_STEP) + 1;
  const xpIntoLevel = totalXp % LEVEL_XP_STEP;

  return {
    quests,
    totalXp,
    level,
    xpIntoLevel,
    xpForNextLevel: LEVEL_XP_STEP,
  };
}
