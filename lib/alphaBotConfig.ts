// Alpha Bot is meant to reward committed long-term holders, not anyone who
// bought in five minutes ago - "I want people buying and holding the NFT
// for a long time... only those people get alpha bot access" (explicit
// product decision, not a technical default). Reuses the same
// weeksHeld/getCollectionSnapshot the leveling system's Hodler XP bucket
// already tracks (lib/collectionSnapshot.ts) - one source of truth for
// "how long has the current owner actually held this," not a second one.
export const MIN_HOLD_WEEKS_FOR_ALPHA_BOT = 4;

// Hard site-wide cap, not per-anon - "this is a total experiment... limit
// responses to several a day total" (explicit cost ceiling, independent of
// how many holders qualify or how active they are). Counts trigger EVENTS
// (one new-thread desk round, or one in-thread follow-up), not individual
// reply posts within an event - a qualifying thread still gets its full
// 3-desk response, it just counts as one toward this cap. See
// lib/alphaBotStore.ts's consumeDailyAlphaBotBudget for the atomic check.
export const MAX_ALPHA_BOT_EVENTS_PER_DAY = 5;
