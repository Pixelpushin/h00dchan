import { NextResponse } from "next/server";
import { getContractStatus } from "@/lib/config";
import {
  fetchOwnedGirlfriendIds,
  requireGirlfriendsContract,
} from "@/lib/girlfriends";
import { fetchTokenMetadata } from "@/lib/chain";

// The connected wallet's own Girlfriends, with metadata - the mother picker
// on app/breed/[hoodchanId]/page.tsx.
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params;
  const status = getContractStatus();
  if (!status.girlfriends) {
    return NextResponse.json({ pending: true, girlfriends: [] });
  }

  try {
    const ids = await fetchOwnedGirlfriendIds(address);
    const girlfriendsContract = requireGirlfriendsContract();
    const girlfriends = await Promise.all(
      ids.map(async (tokenId) => {
        try {
          return await fetchTokenMetadata(
            girlfriendsContract,
            tokenId,
            "Girlfriend",
          );
        } catch {
          return null;
        }
      }),
    );
    return NextResponse.json({
      pending: false,
      girlfriends: girlfriends.filter((g) => g !== null),
    });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to load your Girlfriends.",
      },
      { status: 502 },
    );
  }
}
