# hoodchan breeding-app

Separate Vercel project (root directory = `breeding-app/`) for the HOODCHAN
breeding mini-app. See
`docs/superpowers/specs/2026-08-21-hoodchan-breeding-design.md` in the
parent repo for the full design.

## Girlfriends off-chain data layer

The dummy `HOODCHAN_GIRLFRIENDS` collection (12 tokens, mother role in
breeding, swapped for the real team's contract once it ships - see
`lib/config.ts`) is entirely off-chain metadata + generated art:

- `lib/girlfriendsData.ts` - source-of-truth trait definitions for all 12
  tokens (Backgrounds, Bodies, Faces, Grills, Hats, Girl Stuff).
- `lib/girlfriendsImage.ts` / `lib/breedingImage.ts` - prompt builders +
  art generation, both on top of the shared `lib/openaiImage.ts` primitive
  (gpt-image-1, raw fetch, uploads to Vercel Blob).
- `data/girlfriends/{1..12}.json` - committed, final ERC-721 metadata for
  each token, served by `app/api/girlfriends/[tokenId]/route.ts`
  (`tokenURI(id)` target for the dummy contract's baseURI).
- `scripts/generate-girlfriends.ts` - the only thing that writes the files
  under `data/girlfriends/`.

### Regenerating Girlfriend art

**Normally: never.** All 12 tokens are already generated, uploaded to
Vercel Blob, and committed. Every OpenAI image call costs real money, so
`scripts/generate-girlfriends.ts` HEAD-checks each token's existing
`image` URL before doing anything - if it's already live (HTTP 200,
`image/*`), that token is skipped entirely, no OpenAI/Blob call made.
Running the script with no flags against the current 12 files is a safe
no-op:

```bash
npx tsx scripts/generate-girlfriends.ts
```

Only reach for the flags below if a specific blob has actually died (e.g.
the Vercel Blob store got wiped) and you need to replace it:

```bash
# See what the script *would* do without calling OpenAI/Blob or writing
# anything - always run this first.
npx tsx scripts/generate-girlfriends.ts --dry-run

# Regenerate only token #7 (needs OPENAI_API_KEY + BLOB_READ_WRITE_TOKEN
# set, e.g. via `vercel env pull .env.local`).
npx tsx scripts/generate-girlfriends.ts --only=7 --force

# Regenerate a handful of tokens at once.
npx tsx scripts/generate-girlfriends.ts --only=3,7,11 --force
```

Never run it bare with `--force` against all 12 - that re-bills every
already-paid-for token. `--only` + `--force` together is how you do a
surgical replacement of just the dead one(s).
