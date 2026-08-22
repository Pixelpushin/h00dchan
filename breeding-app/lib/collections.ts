// Cross-collection helpers shared by the app/ UI wave - the single place
// that branches "which of the three allowlisted collections is this
// (collection, tokenId) from" so that logic doesn't get re-forked in every
// page/route (app/baby/[tokenId]/page.tsx's readParentGenes/
// readParentDisplayName started this pattern; this module generalizes it so
// the breed page's matron/sire pickers, the listings route, and the
// family-tree page all share one implementation instead of three drifting
// copies). See the design spec's "Collections and the breedable allowlist"
// section: any of HOODCHAN, Girlfriends, or Babies can fill EITHER parent
// role, so every consumer needs the same three-way dispatch.
import {
  HOODCHAN_CONTRACT,
  GIRLFRIENDS_CONTRACT,
  BABIES_CONTRACT,
  cooldownSecondsForBreedCount,
} from "@/lib/config";
import { fetchWalletTokensOnChain, fetchTokenMetadata } from "@/lib/chain";
import { fetchHoodchanMetadata } from "@/lib/hoodchan";
import { readGirlfriendGenesOf } from "@/lib/girlfriends";
import {
  readGenesOf as readBabyGenesOf,
  readSexOf as readBabySexOf,
} from "@/lib/babies";
import {
  readHoodchanGenes,
  readHoodchanGenesSet,
  readBreedState,
  type TokenBreedState,
} from "@/lib/breedingController";
import { getBreedingRecordUnbound } from "@/lib/breedingStore";

export type CollectionKind = "hoodchan" | "girlfriend" | "baby";

export interface CollectionInfo {
  address: string;
  kind: CollectionKind;
  label: string;
}

// Every collection that is EVER deployed, in a fixed display order
// (HOODCHAN, Girlfriends, Babies) - filters out Girlfriends/Babies while
// their addresses are still unset (see lib/config.ts's getContractStatus,
// same "pending deployment" convention).
export function getAllowlistedCollections(): CollectionInfo[] {
  const list: CollectionInfo[] = [
    { address: HOODCHAN_CONTRACT, kind: "hoodchan", label: "HOODCHAN" },
  ];
  if (GIRLFRIENDS_CONTRACT) {
    list.push({
      address: GIRLFRIENDS_CONTRACT,
      kind: "girlfriend",
      label: "Girlfriend",
    });
  }
  if (BABIES_CONTRACT) {
    list.push({ address: BABIES_CONTRACT, kind: "baby", label: "Baby" });
  }
  return list;
}

export function collectionKindOf(collection: string): CollectionKind | null {
  const lower = collection.toLowerCase();
  if (lower === HOODCHAN_CONTRACT.toLowerCase()) return "hoodchan";
  if (GIRLFRIENDS_CONTRACT && lower === GIRLFRIENDS_CONTRACT.toLowerCase()) {
    return "girlfriend";
  }
  if (BABIES_CONTRACT && lower === BABIES_CONTRACT.toLowerCase()) {
    return "baby";
  }
  return null;
}

export function collectionLabel(collection: string): string {
  const kind = collectionKindOf(collection);
  if (kind === "hoodchan") return "HOODCHAN";
  if (kind === "girlfriend") return "Girlfriend";
  if (kind === "baby") return "Baby";
  return `${collection.slice(0, 6)}…`;
}

// genesOf(tokenId) dispatch - HOODCHAN's genes are fronted by the
// controller's synced adapter mapping (see lib/breedingController.ts's
// readHoodchanGenes doc comment on the sync trust point); Girlfriends and
// Babies read their own genesOf directly off-contract.
export async function readGenesFor(
  collection: string,
  tokenId: string,
): Promise<number[]> {
  const kind = collectionKindOf(collection);
  if (kind === "hoodchan") return readHoodchanGenes(tokenId);
  if (kind === "girlfriend") return readGirlfriendGenesOf(tokenId);
  if (kind === "baby") return readBabyGenesOf(tokenId);
  throw new Error(`Unrecognized breedable collection: ${collection}`);
}

// Whether this token's genes are actually usable in a breed call right
// now. Only HOODCHAN has an off-chain gene-sync trust point (see
// lib/breedingController.ts's HOODCHAN ADAPTER note) - `breed()` reverts
// `GenesNotSet` for ANY HOODCHAN parent (matron OR sire, not just sire)
// whose genes were never synced. Girlfriends/Babies genes are always set
// at mint, so this is always true for them.
export async function readGenesReadyFor(
  collection: string,
  tokenId: string,
): Promise<boolean> {
  const kind = collectionKindOf(collection);
  if (kind === "hoodchan") return readHoodchanGenesSet(tokenId);
  return true;
}

// Sex-tag dispatch - mirrors BreedingController's `CollectionSex` enum
// (Male/Female fixed per-collection for HOODCHAN/Girlfriends, PerToken for
// Babies via IPerTokenSex.sexOf). true = Male, false = Female - the same
// boolean convention `previewBreedFee`'s matronSex/sireSex params and
// `resolveBabyIsMale`'s return value already use.
export async function readSexFor(
  collection: string,
  tokenId: string,
): Promise<boolean> {
  const kind = collectionKindOf(collection);
  if (kind === "hoodchan") return true;
  if (kind === "girlfriend") return false;
  if (kind === "baby") return readBabySexOf(tokenId);
  throw new Error(`Unrecognized breedable collection: ${collection}`);
}

export interface TokenDisplay {
  name: string;
  image: string;
}

// name/image dispatch - HOODCHAN resolves off its real ipfs:// tokenURI,
// Girlfriends off its own tokenURI (served by
// app/api/girlfriends/[tokenId]/route.ts), Babies off the persisted
// breeding record (lib/breedingStore.ts - a Baby's tokenURI is only set
// once its art finishes generating, so the store is the fast/authoritative
// path even after that point).
export async function fetchTokenDisplay(
  collection: string,
  tokenId: string,
): Promise<TokenDisplay> {
  const kind = collectionKindOf(collection);
  if (kind === "hoodchan") {
    const meta = await fetchHoodchanMetadata(tokenId).catch(() => null);
    return { name: meta?.name ?? `Anon #${tokenId}`, image: meta?.image ?? "" };
  }
  if (kind === "girlfriend") {
    const meta = await fetchTokenMetadata(
      collection,
      tokenId,
      "Girlfriend",
    ).catch(() => null);
    return {
      name: meta?.name ?? `Girlfriend #${tokenId}`,
      image: meta?.image ?? "",
    };
  }
  if (kind === "baby") {
    const record = await getBreedingRecordUnbound(tokenId).catch(() => null);
    return { name: `Offspring #${tokenId}`, image: record?.imageUrl ?? "" };
  }
  return { name: `${collection.slice(0, 6)}…#${tokenId}`, image: "" };
}

export interface CooldownStatus {
  breedCount: number;
  cooldownEnd: number;
  onCooldown: boolean;
  secondsRemaining: number;
  /** The cooldown length (seconds) this token's NEXT breed will apply,
   * given its current breedCount - mirrors
   * `cooldownSecondsForBreedCount` (lib/config.ts). */
  nextCooldownSeconds: number;
}

// Turns a raw TokenBreedState (breedCount + cooldownEnd, see
// lib/breedingController.ts:readBreedState) into the shape every
// cooldown-status UI needs (this REPLACES the superseded v1 Xof5
// nested-cap display everywhere, per the design spec's escalating-cooldown
// section - there is no cap, only an escalating throttle).
export function computeCooldownStatus(
  state: TokenBreedState,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): CooldownStatus {
  const cooldownEnd = Number(state.cooldownEnd);
  const onCooldown = cooldownEnd > nowSeconds;
  return {
    breedCount: state.breedCount,
    cooldownEnd,
    onCooldown,
    secondsRemaining: onCooldown ? cooldownEnd - nowSeconds : 0,
    nextCooldownSeconds: cooldownSecondsForBreedCount(state.breedCount),
  };
}

export interface OwnedBreedableToken {
  collection: string;
  kind: CollectionKind;
  tokenId: string;
  name: string;
  image: string;
  isMale: boolean;
  genesReady: boolean;
  cooldown: CooldownStatus;
}

// The wallet's own tokens across ALL allowlisted collections, each with
// live cooldown + sex-tag + gene-readiness state - the matron picker's full
// candidate pool (matron ownership is the only mandatory check, per the
// design spec's "Ownership rule"), and the "mine" half of the sire picker.
export async function fetchOwnedBreedableTokens(
  address: string,
): Promise<OwnedBreedableToken[]> {
  const collections = getAllowlistedCollections();
  const perCollection = await Promise.all(
    collections.map(async (c) => {
      const ids = await fetchWalletTokensOnChain(c.address, address).catch(
        () => [] as string[],
      );
      return Promise.all(
        ids.map(async (tokenId) => {
          const [display, breedState, isMale, genesReady] = await Promise.all([
            fetchTokenDisplay(c.address, tokenId).catch(() => ({
              name: `${c.label} #${tokenId}`,
              image: "",
            })),
            readBreedState(c.address, tokenId).catch(
              () =>
                ({
                  collection: c.address,
                  tokenId,
                  breedCount: 0,
                  cooldownEnd: 0n,
                }) as TokenBreedState,
            ),
            readSexFor(c.address, tokenId).catch(() => true),
            readGenesReadyFor(c.address, tokenId).catch(() => false),
          ]);
          const token: OwnedBreedableToken = {
            collection: c.address,
            kind: c.kind,
            tokenId,
            name: display.name,
            image: display.image,
            isMale,
            genesReady,
            cooldown: computeCooldownStatus(breedState),
          };
          return token;
        }),
      );
    }),
  );
  return perCollection.flat();
}
