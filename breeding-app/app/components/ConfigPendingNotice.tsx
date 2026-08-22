// Shared "contracts pending deployment" state - every page checks
// lib/config.ts's getContractStatus() before attempting any read/write, and
// renders this instead of crashing when an address is still unset. Real
// pre-launch state, not an error: none of the three breeding contracts are
// deployed yet.
export function ConfigPendingNotice({ what }: { what: string }) {
  return (
    <div className="hc-pending-box">
      <p className="font-bold mb-1">🚧 {what} isn&apos;t deployed yet.</p>
      <p>
        The breeding contracts (HOODCHAN_GIRLFRIENDS, HOODCHAN_BABIES,
        BreedingController) haven&apos;t shipped yet - this page will come alive
        the moment their addresses are set in the environment. Nothing is
        broken; this is the expected pre-launch state.
      </p>
    </div>
  );
}
