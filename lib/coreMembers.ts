// "Core member" wallet whitelist for the CircleJerkFinance registry's
// sponsor path - a core member can list a project without the normal
// eligibility bar (>=1 nested HOODCHAN + >=1 human post), for vouching in
// community members/projects that haven't hit that bar yet themselves. See
// lib/registryEligibility.ts for where this is actually used.
//
// Same pattern as lib/adminAuth.ts's adminAddresses(): a plain comma-
// separated env var, parsed fresh on every call rather than cached, since
// this is only ever called on the (rare, human-initiated) registry
// submission path, not a hot loop. Admins are automatically core members
// too - there's no reason to require the same wallet be listed twice.
import { isAdminAddress } from "@/lib/adminAuth";
import { ADDRESS_PATTERN } from "@/lib/address";

function coreMemberAddresses(): Set<string> {
  const raw = process.env.CORE_MEMBER_WALLET_ADDRESSES ?? "";
  return new Set(
    raw
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter((a) => ADDRESS_PATTERN.test(a)),
  );
}

export function isCoreMemberAddress(address: string): boolean {
  if (!ADDRESS_PATTERN.test(address)) return false;
  const lower = address.toLowerCase();
  return isAdminAddress(lower) || coreMemberAddresses().has(lower);
}
