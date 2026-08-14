// Live "how much ETH is $25 right now" quote for the rent-ad modal -
// pricing is USD-denominated (see lib/adConfig.ts's AD_PRICE_USD), so the
// actual token amount has to be computed at request time, not hardcoded.
import { NextRequest, NextResponse } from "next/server";
import { AD_PRICE_USD, findAdPrice } from "@/lib/adConfig";
import { usdToTokenAmount } from "@/lib/priceFeed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get("token") ?? "";
  const price = findAdPrice(symbol);
  if (!price) {
    return NextResponse.json(
      { error: `${symbol} is not an accepted token.` },
      { status: 400 },
    );
  }

  try {
    const amount = await usdToTokenAmount(AD_PRICE_USD, price.coingeckoId);
    return NextResponse.json({
      symbol: price.symbol,
      usdPrice: AD_PRICE_USD,
      amount,
    });
  } catch {
    return NextResponse.json(
      { error: "Unable to fetch the current price right now." },
      { status: 502 },
    );
  }
}
