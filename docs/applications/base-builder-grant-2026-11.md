# Base Builder Grant Program — application draft (2026-11-01)

Form: https://forms.gle/xeXWvAfpKuCQFDLg7 (Google sign-in required; submit it yourself). Up to $5,000 plus
go-to-market and product support for teams building exclusively on Base with a live product. Everything below is
written to paste into the form; `[...]` marks what only you can fill in. Answers are in English, the notes in Turkish.

> **Not:** form "live product that's getting used" ve "key usage numbers" istiyor. Bugün rakamlarımız sıfır: $BOOT
> henüz launch edilmedi, RWAGMI üzerinde canlı coin yok. Başvuruyu $BOOT ve ilk birkaç creator launch'ından sonra
> göndermek, "all-time users / volume" satırını boş bırakmaktan çok daha güçlü olur. Formu şimdi doldurup bir hafta
> bekletmek de mümkün; rakam satırını son anda güncellersin.

---

**Full name** — `[adın soyadın]`

**Email** — `[başvuru e-postan]`

**X (Twitter) handle** — `[kişisel hesabın]` (project: @bootrfun)

**Telegram username** — `[@kullanıcı adın]`

**Project name + one-line description of what it does**

> Bootr (bootr.fun): a token launchpad on Base where every coin gets an autonomous agent with its own X account. The
> agent earns a locked, on-chain share of the coin's swap fees and uses it to pay for its own inference (USDC over x402)
> and its own gas, so a coin keeps a voice for as long as it trades.

**Tell us about the founding team** (prior companies/exits, funding raised, relevant domain expertise)

> Bootr is built by siya (@siyabaldacc), a solo founder and musician who ships onchain products end to end:
> contracts, indexer, agents and front end. Before Bootr I founded Coattail Brokers (coattail.cash, August 2026): a
> sold-out collection of 1,776 NFTs on Robinhood Chain where every NFT has its own wallet that buys tokenized stocks
> mirroring US Congress members' disclosed trades, activated by burning $COAT, a fixed-supply token airdropped to
> 1,700+ wallets. Coattail taught me programmable ownership and per-asset wallets in production, which is exactly the
> primitive Bootr runs on: every coin gets a smart-account treasury with a scoped session key.
> Bootr itself went from first commit to Base mainnet in the same week (first commit 2026-10-27, mainnet launch
> 2026-10-27, RWAGMI v3 relaunch 2026-10-29): launcher and guardian contracts, a Ponder indexer, an ERC-4337 agent
> supervisor, an x402-paid inference relay and the web app, with contract fork tests, a session-key security review
> and a documented fee model. No outside capital raised; self-funded and bootstrapped. No exits to date.
> `[Doğrula/düzelt: "solo founder" doğru mu, Coattail'de ortağın var mı; yatırım aldıysan yaz; gerçek adını eklemek
> istersen başa koy.]`

**Link to your live product** — https://bootr.fun (docs: https://bootr.fun/docs, public data API: https://indexer.bootr.fun/graphql)

**Link to a Product Demo (Loom)** — https://www.youtube.com/watch?v=xSNGkVUJx0M (YouTube, unlisted; submitted 2026-11-01): video hazır, `docs/applications/bootr-demo.mp4` (2:46, 1080p, İngilizce seslendirme ve altyazı, git'e girmez). YouTube'a "Unlisted" olarak yükle, linki buraya yapıştır. Loom şart değil; form Loom dese de herkese açık bir video linki kabul edilir.

**Contract address on Base**

> BootrLauncher (RWAGMI v3 backend): 0xD3CE024ddC37465510E6c9a1D7942f003338B1F3 (deployed at block 53219209, Sourcify
> verified). Agent guardian: 0x799Ab875294E37839883D12084aB4BE3f7633630. Every agent treasury is a ZeroDev Kernel v3.1
> smart account on Base with our BootrCallPolicy session-key allow-list (0x8586BdE0339b85bb9c0f0612954CCdF7fDCF9cE8).

**Which track best fits what you're building?** — **Agents / Agentic Commerce**
(formun kategori listesinde "Token Launchpads" da var; track seçeneklerinde yok. Agents en doğru kutu: x402 ile
ödeme yapan, kendi gas'ını ve inference'ını kendi fee payından karşılayan otonom agent'lar. İstersen "Diğer: Token
launchpad + autonomous agents" da yazabilirsin.)

**Share your key usage numbers** (all-time users onboarded, current DAU, current WAU, all-time volume, last-30-day volume)

> `[Bu satırı göndermeden hemen önce doldur.]` Öneri format:
> All-time wallets connected: `[n]` · Coins launched: `[n]` · Agents live: `[n]` · DAU `[n]` / WAU `[n]` · All-time
> swap volume on Bootr coins: `$[n]` · Last 30 days: `$[n]` · Agent posts published: `[n]`.
> Mainnet since 2026-10-27; relaunched on the RWAGMI v3 launch stack on 2026-10-29 (one-sided Uniswap v4 pools, LP
> locked for good, 1% swap fee split on-chain at launch). Platform token $BOOT launches `[tarih]`.

**How does your product make money today?**

> Two on-chain revenue lines, both locked into every coin at launch and claimable only by the platform wallet:
> 1. 30% of each coin's reward share of the 1% swap fee (0.27% of all swap volume on every Bootr coin, in WETH,
>    forever; the split is immutable per coin and visible on bootr.fun/docs/fees).
> 2. A flat 0.0005 ETH launch fee per coin.
> A third line is the inference relay: agents pay per request in USDC over x402 (Coinbase facilitator) at a published
> price table above our provider cost. We hold no user funds; creators and agents claim their own fees from the RWAGMI
> locker.

**What's your GTM plan for the next 3 months?**

> Month 1 — Launch the platform token $BOOT with the platform's own agent (@bootrfun) as the reference agent: every
> post, fee claim and buyback is public, so the product demos itself. Onboard the first 10–20 creators from the
> RWAGMI and Base builder communities with hands-on launch support (we fund nothing: creators bring 20 USDC of agent
> fuel and 0.001 ETH of gas).
> Month 2 — Distribution through the agents themselves: each coin's agent posts, replies and reads mentions on X on
> its own schedule, so every launch adds a new account talking about Base. Builder Codes on every agent transaction
> for attribution. Weekly "fees paid to agents / creators" numbers published from the public indexer.
> Month 3 — Partnerships that bring launchers: integrations with Base-native communities and launch-tooling teams,
> DexScreener and Base ecosystem listings, and the buyback-and-burn preset as the default for community coins. Product
> work in the same window: creator dashboard, agent tool expansion (trading within policy limits), audited session-key
> policy.
> What we need from Base more than capital: GTM help reaching creators, and introductions on the Agents track.

**What's your Base Builder Code?** — bc_g3czfbd3 (platform wallet; each agent kernel also registers its own code and
appends it to every session userOp)

**What is the primary challenge or bottleneck you are currently facing?** — **User acquisition** (ikinci tercih:
Liquidity bootstrapping)

**Which credits would be most useful for you as you build?**

> 1. X API (the single biggest running cost: every agent posts and reads mentions through the X API).
> 2. Coinbase Developer Platform: Base RPC, ERC-4337 bundler, x402 facilitator settlements.
> 3. Inference: OpenRouter / Anthropic / OpenAI credits for agent reasoning.
> 4. Pinata (IPFS pinning for coin images and metadata) and server credits (Hetzner/AWS) for the self-hosted stack.

**If you're applying for the second time, what changed from the last application?** — First application. (Formda
zorunlu alan: "First application" ya da "N/A" yaz.)

---

## Loom demo plan (3–4 dakika)

1. **0:00** bootr.fun ana sayfa: coin listesi, $BOOT kutusu, bir coin sayfasında agent paneli (treasury, gas, fuel, son
   postlar). Tek cümle: "every coin here is run by its own agent on its own X account".
2. **0:40** Launch formu: coin, agent identity, X hesabı bağlama, fuel + gas. Launch tx + gas depozitosu (iki cüzdan
   onayı). Zincirde ne oluyor: kernel treasury, RWAGMI pool, kilitli fee split.
3. **1:40** Coin sayfasında agent'ın ilk postu ve X hesabı; fee split kutusu ("locked at launch"); Add gas / Fuel.
4. **2:20** Docs → Fee math ve Who pays the agent's gas: agent kendi kazancından ödüyor, platform gas ödemiyor,
   session key allow-list'i (ne yapabilir, ne yapamaz).
5. **3:00** Analytics sayfası ve indexer GraphQL'den canlı veri; kapanış: Base'de neden (ucuz tx, x402, Builder Codes).

Kayıttan önce: $BOOT launch edilmiş ve en az bir agent post atmış olsun; mock modda değil, mainnet'te çek.
