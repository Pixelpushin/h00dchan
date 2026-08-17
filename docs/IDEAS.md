# Ideas / design notes

Not a roadmap, not commitments - a place to park real design ideas that
came up mid-conversation so they don't get lost before there's time to
build them. Delete an entry once it's actually built (the code is the
real source of truth at that point) or once it's explicitly decided
against.

## Token-bound wallet features (in progress)

Current state: every anon has a real, computed ERC-6551 wallet address
(`lib/tba.ts`) that can already receive real assets today. The shared
account implementation contract isn't deployed on Robinhood Chain yet, so
nothing can be *spent* from any wallet yet - only received.

Two deployment steps once we're ready:
- **Step A (one-time, whole collection):** deploy Tokenbound's official
  implementation contract at the address every wallet already computes
  against (`IMPLEMENTATION_ADDRESS` in `lib/tba.ts`). One transaction, our
  gas, doesn't turn on any individual wallet by itself.
- **Step B (per-holder, optional, ongoing):** each holder calls
  `createAccount()` for their own token to actually deploy their wallet's
  proxy (`lib/tba.ts`'s `buildCreateAccountTx`, already written, not wired
  to any UI yet). Their gas, their choice, only needed once they want to
  send/spend, not to receive.

### Step A prep, confirmed live 2026-08-17

Checked directly against Robinhood Chain via raw `eth_getCode`, not
assumed:
- The standard CREATE2 singleton factory ("Nick's Method",
  `0x4e59b44847b379578588920cA78FbF26c0B4956C`) is **already live** on
  Robinhood Chain with the exact expected bytecode - the prerequisite for
  any contract to land at the same deterministic address as it does on
  every other chain.
- `REGISTRY_ADDRESS` (`0x000000006551c19487814612e58FE06813775758`) already
  has real deployed code on Robinhood Chain.
- `IMPLEMENTATION_ADDRESS` (`0x41C8f39463A868d3A88af00cd0fe7102F30E44eC`)
  is still empty (`eth_getCode` -> `"0x"`), confirming Step A genuinely
  hasn't happened yet.

Tokenbound has an official self-serve tool for exactly this:
**https://tokenbound-v3-deployer.vercel.app/** - inspected live (no wallet
connected, nothing deployed by this session). It lists 7 contracts
(Create2 Factory, ERC-6551 Registry, V3 Account Proxy, V3 Account
Implementation, V3 Account Guardian, Authenticated Multicall, LayerZero V2
Executor), each with its own address and a one-click "Deploy" button once
a wallet is connected on the target chain. The addresses it lists for
"ERC-6551 Registry" and "V3 Account Implementation" match `lib/tba.ts`'s
`REGISTRY_ADDRESS`/`IMPLEMENTATION_ADDRESS` exactly - independent
confirmation the hardcoded values are correct.

**What Brady needs to actually do (real gas, real signature - not
something to automate):**
1. Have a wallet funded with a small amount of Robinhood Chain ETH for gas.
2. On the deployer tool, click "Add a chain" -> Name `Robinhood Chain`,
   Chain ID `4663`, RPC URL `https://rpc.mainnet.chain.robinhood.com` ->
   switch the connected wallet to it.
3. Connect wallet. Factory and Registry rows should already read
   "Deployed" once the right chain is selected (both confirmed live
   above) - skip those.
4. Click "Deploy" on **V3 Account Proxy**, then **V3 Account
   Implementation**, then **V3 Account Guardian**, then **Authenticated
   Multicall**, in that order (top to bottom as listed) - 4 separate
   signed transactions, real gas each. Skip **LayerZero V2 Executor**
   unless cross-chain messaging is ever wanted - not needed for basic
   same-chain send/spend.
5. **Verification gate:** after "V3 Account Implementation" shows
   deployed, the resulting address must read exactly
   `0x41C8f39463A868d3A88af00cd0fe7102F30E44eC`. If it doesn't match, stop
   and don't deploy anything else - that would mean the wrong chain was
   selected or something else is off.
6. Once confirmed, Step A is done - I can independently re-verify via
   `eth_getCode` (no wallet needed for that check) and then build Step B's
   UI (the "activate my wallet" button, code for it already exists in
   `lib/tba.ts`'s `buildCreateAccountTx`, just never wired to anything).

### Idea: gate Step B behind burning something, instead of a free button

Explored 2026-08-17. Two different versions of this came up - worth
keeping them distinct, since one is bypassable and one isn't:

1. **Gate the wallet-activation button behind burning a future HOODCHAN-
   team token.** Doable at the app-UI level only (don't show/allow the
   button until a burn is verified) - `createAccount()` itself is
   permissionless on the standard registry, so a technically-savvy holder
   could always call it directly via a block explorer, bypassing our
   gate. Low stakes if bypassed (deploying an empty, still owner-gated
   proxy shell isn't dangerous on its own), but real: our gate only
   controls the convenient path, not the only possible one. Also fully
   dependent on an external event outside our control (does the HOODCHAN
   team ever launch a token?) - fine to wait on, but means this is
   indefinitely deferred until/unless that happens.

2. **Burn the NFT itself to redeem whatever's accumulated in its TBA
   wallet.** Different animal entirely - not a standard ERC-6551 function,
   a custom mechanic we'd design and build ourselves, so we fully control
   the logic and it genuinely cannot be bypassed the way createAccount()
   can. Sketch: a custom "redeemer" contract that receives the NFT via
   `safeTransferFrom` (or after an approval), and in the same transaction
   - now temporarily the NFT's owner, so `execute()`-authorized on that
     token's TBA - sweeps the TBA's real holdings out to the redeemer,
     then burns the NFT (send to a burn address, or a real burn() call if
     the collection contract supports one). One atomic transaction, no
     window for anyone to interfere.
   - Real tradeoff: this is new custom contract code moving real value,
     not Tokenbound's pre-audited implementation - we own the correctness/
     security risk here specifically, same as any custom ERC-6551 logic.
     Needs real scrutiny before it touches real funds.
   - Downstream of Step A (needs a deployed implementation contract so
     `execute()` actually works before this can sweep anything).

Neither built yet. Revisit once Step A is actually decided/scheduled.

### Testing status

2026-08-17: real test coin now available in a real wallet
(`0x80504428f5adcaf32443e17762a2d2f5bfe35244`, token owner has it ready)
to test receiving into a counterfactual TBA - this already works today,
no deployment needed. Good next step: confirm it shows up correctly on
`/wallet/[tokenId]` once sent.

## Idea: "log in with Bankr wallet" as a login option

Explored 2026-08-17 (docs read: `docs.bankr.bot` - LLM Gateway, Wallet API,
Agent API, Apps, Agent Profiles sections). The ask: let X users who already
trade through the @bankr bot use that same wallet to log into h00dchan,
instead of needing a separate wallet connected via WalletConnect.

**What's actually there, not what was assumed:**
- No OAuth / "Sign in with Bankr" / wallet-connect flow exists for
  third-party sites. Checked every plausible section (`/apps`,
  `/agent-profiles`, `/wallet-api`, `/agent-api`) - none of them document
  one.
- No public API to resolve "this X handle -> this wallet address" either.
- Bankr wallets are Privy-embedded wallets controlled only through Bankr's
  own API/agent - not a normal EOA a user can plug into MetaMask/
  WalletConnect the way h00dchan's existing login already works for any
  other wallet.
- The only real API surface is the **Wallet API**
  (`https://api.bankr.bot`): `GET /wallet/me` (address),
  `GET /wallet/portfolio`, `POST /wallet/sign`, `POST /wallet/submit`,
  `POST /wallet/swap`, `POST /wallet/transfer` - all gated behind one
  bearer-style key (`X-API-Key: bk_...`) a user generates themselves at
  bankr.bot/api-keys.

**The real bridge, if we ever build this:** user pastes their own Bankr
API key into h00dchan -> we call `/wallet/me` for their address -> call
`/wallet/sign` with our existing SIWE challenge message -> verify that
signature exactly like any other wallet login (`lib/auth-server.ts`
already does this verification step for every login, wallet-agnostic).
Technically works, slots into the existing auth path with no new backend
concept needed.

**Why this isn't a clean "connect wallet" button:** the same key that can
sign our login challenge can also sign `/wallet/swap` and
`/wallet/transfer` - it's not a scoped, login-only credential. A user
pasting it into h00dchan hands us something closer to an exchange API key
with withdraw permission than a wallet-connect session. Real, bounded risk
if we ever build it (never store the key, use once per session, discard
immediately, tell users to scope it to "Wallet API" only and not enable
"Agent API" on that key) - but still a materially different trust ask than
every other login method this site offers.

**Not built. Revisit if Bankr ships a real scoped login-only flow, or if
the bounded-risk version above becomes worth it later.**

**Update 2026-08-17, after reading Bankr's official example repo
(`github.com/BankrBot/bankr-api-examples`, cloned and read directly, not
just their support bot's summary):** the "API-key bridge" idea above is
more theoretical than real. Every official example - the CLI, the voice
demo (`examples/agent-api/voice/src/app/api/bankr/prompt/route.ts`), and
the Telegram trading bot (`examples/agent-api/telegram-trader/src/bankr/
client.ts`) - uses exactly **one** server-held `BANKR_API_KEY` for the
entire app, one wallet, shared across every user of that app. The
Telegram bot's "trusted users" only gate *whose messages are allowed to
trigger a trade on the operator's own wallet* - it's not each Telegram
user connecting their own separate Bankr wallet.

Bankr's own support bot described this as letting an app "interact with a
user's Bankr account and assets," which reads like per-end-user access -
but nothing in their actual reference code supports that. In Bankr's real
model, "the user" is the app operator (us), not each individual visitor.
There is no example, anywhere in their own repo, of one app juggling
multiple end users' individual Bankr wallets.

**Conclusion: the original ask - many different X/Bankr users each
logging into h00dchan with their own Bankr wallet - is not supported by
this API, even as an intended pattern, let alone a clean one.** The only
way to use Bankr's Agent/Wallet API here would be to give h00dchan itself
one shared Bankr-powered wallet (e.g. as a treasury, or an NPC-style
in-house trading agent) - a completely different feature from "wallet
login," not built, not currently planned.
