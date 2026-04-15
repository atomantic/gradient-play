# Gradient Bang — Strategy Guide

A strategic playbook for the AI-agent-driven multiplayer universe. Built from direct reading of the codebase (tools in `src/gradientbang/tools/schemas.py`, formulas in `deployment/supabase/functions/_shared/`).

---

## 1. Core Model: What You Are Optimizing

Gradient Bang is a sector-graph universe (~5000 sectors) where ships accumulate four distinct resources that feed back into each other:

| Resource | Gets You | Loses To |
|---|---|---|
| **Credits** | Ships, fighters, warp power, bank safety | Destroyed ship, corp fees, bad trades |
| **Fighters** | Combat, garrisons, territory income | Combat losses (both hit & miss) |
| **Cargo** | Trade profit → credits | Destroyed ship (dropped as salvage) |
| **Map knowledge** | Efficient routes, scarce-port discovery | Nothing — permanent (and shared with corp) |

The leaderboard has four axes (**wealth / trading / exploration / territory**). Pick one primary axis — stretching across all four is always dominated by a focused corp fleet.

**The single most important insight:** the price formula `multiplier ∈ [0.75, 1.3]` means max theoretical margin on one commodity round-trip is **~73%** (buy at 0.75, sell at 1.3 of base). Margins above that signal you've found an imbalanced route worth defending. Margins below 20% are not worth the warp power.

---

## 2. Opening (First ~30 minutes)

You spawn in a Sparrow Scout loaner, 8 hops from the nearest megaport, with the `tutorial` quest assigned.

### Exact opening sequence

1. `my_status` → note sector, warp power, cargo capacity (20).
2. `local_map_region(depth=3)` — scan for adjacent ports and the megaport path.
3. `plot_course` to the nearest megaport. Use `load_game_info(topic="map legend")` if port codes confuse you.
4. On the way, **make one trade** (tutorial step 4). Pick any port with a `B` code for something adjacent ports sell. Even a 1-credit profit advances the quest.
5. At the megaport: `recharge_warp_power` to full (tutorial step 3), then start trading in earnest.
6. Grind to **1000 credits aggregate profit** (tutorial step 5). This is the bottleneck step — everything else is one-shot.
7. Buy the **Kestrel Courier** (25,000 credits, but trade-in on the Sparrow covers most of it — net ~4,000).
8. Claim rewards: **~2,025 credits** in quest payouts if you complete the full tutorial chain.

### Why the Kestrel immediately

The Sparrow is a loaner — you don't own it and can't sell it. The Kestrel's 30-cargo hold vs. 20 is only 50% more capacity, but you own it (it's your trade-in collateral for later upgrades) and it has 300 warp capacity at 3/hop = 100-sector range. That's the minimum viable trader.

### What not to do in the opener

- **Don't buy fighters yet.** At 50 cr/fighter, 100 fighters = 5000 credits — half your Kestrel fund. There's nothing worth fighting with a Sparrow.
- **Don't place garrisons.** You're in fedspace — it's blocked anyway, and your 200 Sparrow fighters won't survive border-sector hostile traffic.
- **Don't found a corp.** 10,000-credit fee. Wait until you have a Freighter and an actual reason (corp ship fleet).

---

## 3. Reading Port Codes (The Price Engine)

Port codes are `[QF][RO][NS]` where `B` = port buys (you sell to it) and `S` = port sells (you buy from it). Base prices: QF=25, RO=10, NS=40.

### Price formulas (memorize these)

Port is **selling to you**:
```
multiplier = 0.75 + 0.35 × sqrt(1 - stock/max)   # range [0.75, 1.10]
```
Port is **buying from you**:
```
multiplier = 0.9 + 0.4 × sqrt(stock/max)         # range [0.90, 1.30]
```

Wait — the buy multiplier uses `need = 1 - stock/max`. So a **port that's near empty** has high `need` → pays 1.3× base. A **port that's nearly stocked out of sellable goods** (scarcity high) sells at 1.1× base.

### Arbitrage rules

- **Best sell targets:** `B` ports with nearly-empty stock of that commodity → 1.3× base.
- **Best buy sources:** `S` ports with nearly-full stock → 0.75× base.
- **Maximum per-unit margin:** `1.3 × base − 0.75 × base = 0.55 × base`. Per commodity:
  - NS (base 40): up to **22 cr/unit** profit
  - QF (base 25): up to **13.75 cr/unit**
  - RO (base 10): up to **5.5 cr/unit**
- **Neuro-Symbolics (NS) is the king commodity.** 2.2× the margin of RO per unit of cargo. Prioritize NS loops until your cargo hold is so large that you can't fill it.

### Building a route

1. `list_known_ports(commodity="NS", trade_type="S")` → S-ports selling NS cheap.
2. `list_known_ports(commodity="NS", trade_type="B")` → B-ports buying NS dear.
3. For each pair, `plot_course` and compute: `(sell_price − buy_price) × min(cargo_hold, port_stock) / hops`.
4. Rank by **credits per warp-turn**, not per trip. A 2-hop route at 15 cr/unit beats a 20-hop route at 20 cr/unit.

### Stock depletion is real

A single Wayfarer Freighter load (120 units) visibly moves port stock. Your own trades swing the price against you. **Rotate between 2–3 routes** to let port regen catch up; or commit to one route and price in diminishing returns.

---

## 4. Ship Upgrade Tree

Trade-in value is ~60% of purchase price, so upgrading is cheaper than a fresh buy.

```
Sparrow Scout (loaner, free)
    │
    ▼  ~4K net
Kestrel Courier (25K, 30 cargo)     ← tutorial graduation
    │
    ├──[trader fork]──▶ Wayfarer Freighter (120K, 120 cargo)
    │                       │
    │                       ▼  large fleets only
    │                   Pioneer Lifter (220K, 180 cargo) / Atlas Hauler (260K, 300 cargo)
    │
    └──[combat fork]──▶ Corsair Raider (180K, 60 cargo, 1500 fighters, 400 shields)
                            │
                            ▼
                        Pike Frigate (300K) → Bulwark Destroyer (450K, 4000 fighters)
                            │
                            ▼
                        Aegis Cruiser (700K) → Sovereign Starcruiser (2.5M, flagship)
```

### Which fork, when

- **Solo, no combat intent:** Kestrel → Wayfarer → Atlas. Skip the combat tree entirely; use garrisons bought with trade profit for defense only.
- **Corp member, trading role:** Wayfarer (primary) + Autonomous Light Hauler (5K, corp-only; 20 cargo, autonomous secondary loop).
- **Corp combat role:** Corsair fast (180K is reachable after ~20 hours of trading); delay Pike until you've tested combat because 300K is a big loss if you get ambushed learning.
- **End-game flagship:** Sovereign (2.5M). 140 cargo + 6500 fighters + 2000 shields — trader and combatant in one hull.

### The Corsair is the inflection point

Corsair has 400 shields → 20% hit-chance mitigation. That alone pushes incoming-hit probability from 50% to ~38%, a meaningful survivability jump over a Kestrel's 150 shields (7.5% mitigation, 45% hit). Pair with 1500 fighters and you can survive a mugging from anyone flying ≤Kestrel-tier.

---

## 5. Combat — Hit Math and Decision Rules

### The hit probability formula
```
p_hit = 0.5 − 0.6 × min(0.0005 × def_shields, 0.5) + 0.1 × min(0.0005 × atk_shields, 0.5)
p_hit ∈ [0.15, 0.85]
```

Worked examples:
- **Kestrel (150 shields) attacks Kestrel (150 shields):** `p = 0.5 − 0.6×0.075 + 0.1×0.075 = 0.5 − 0.045 + 0.0075 = 46.25%`.
- **Corsair (400) attacks Kestrel (150):** `p = 0.5 − 0.045 + 0.02 = 47.5%`.
- **Kestrel attacks Bulwark (1200):** `p = 0.5 − 0.6×0.5 + 0.0075 = 20.75%`. You lose ~80% of committed fighters as misses.
- **Bulwark attacks Kestrel:** `p = 0.5 − 0.045 + 0.05 = 50.5%`. Roughly coin-flip.

### Practical combat rules

- **Shield breakpoints:** 1000 shields caps mitigation at 50% (the hard cap). More shields past 1000 don't improve hit-math — only ablation survival.
- **Miss = attacker loses 1 fighter.** You can lose more fighters aggressively missing than bracing and regenerating.
- **Brace is underrated.** +20% mitigation effective, −20% ablation. Against a better-shielded enemy, two rounds of brace (regen +10 shields/round, +20% mitigation) can turn the math.
- **Flee clamps at [20%, 90%].** Running from a Sparrow in a Wayfarer is not guaranteed — the Sparrow's better turns-per-warp (2 vs 3) gives it flee advantage against *you*. Speed matters when calculating who can run from whom.
- **Never attack a garrison of your own corp.** Engine short-circuits; no combat resolves.

### Who attacks first

Ships with **fewer fighters attack first** (ties broken by speed). This is counterintuitive: committing fewer fighters can be a tempo play. But be careful — it also means an escape pod (0 fighters) with no combat gear can sometimes initiate resolution before you react.

### Targeting priority

Attackers target **most fighters first, then most shields**. If you're the tank in a corp battle, assume you'll soak. If you're a Wayfarer with a full hold, don't flash your fighters — an escort's 2000 fighters will draw fire away from your 600.

### Salvage math

On kill, you get: all cargo + all on-hand credits + scrap = `max(5, floor(ship_price / 1000))`. A Wayfarer kill = 120 units cargo + their credits + 120 scrap. A Starcruiser kill = 140 cargo + credits + 2500 scrap. **Salvage has TTL 900s.** Anyone in sector can claim — so if two attackers kill a target, first to `salvage_collect` wins.

---

## 6. Garrisons — Passive Income and Denial

Garrisons are stationed fighters that remain after you leave. Three modes:

| Mode | Commits on engagement | Use case |
|---|---|---|
| **offensive** | Up to 50% of garrison (min 50) | Deny a sector to rivals; active PvP |
| **defensive** | Up to 25% (min 25), braces | Cheap protection of trade routes |
| **toll** | 0 unless unpaid, then attacks | Passive income from through-traffic |

### Key constraints

- **Not in fedspace**, not in **border sectors** (adjacent to fedspace). You're placing in neutral space only.
- One garrison per character per sector.
- **Garrisons have 0 shields** — always. They rely on sheer fighter count. Every hit kills a fighter with no mitigation.

### Toll strategy

- Park in a sector on a popular trade route (chokepoint between two commodity-rich regions).
- Set toll to **~0.5–1% of a typical cargo load value** (e.g., 200 credits for a Kestrel, 1500 for a Wayfarer). Too high = everyone reroutes; too low = you're giving up income.
- Garrison size: minimum **300–500 fighters** to be intimidating. Below that, a Corsair just fights through.
- `event_query(filter_sector=X, event_type=["combat.*", "toll.*"])` — monitor engagement frequency to price your toll correctly.

### Garrison economics

- 500 fighters = 25,000 credits sunk.
- Need 50+ tolls at 500 credits each to break even on just the fighter cost. This is a **long game** — pick a sector you're confident sees real traffic.
- If abandoned: `disband_garrison` returns toll balance but **fighters are lost** (not refunded). Plan around this.

### Defensive network

Five 400-fighter defensive garrisons in a ring around your trade route = 2000 fighters (100K credits). Makes the route costly for a Corsair-class raider to harass. This is corp-tier investment; solo players should skip.

---

## 7. Corporations — When and Why

### Don't found one too early

10,000-credit fee. Zero value solo unless you have teammates *ready to join*. Founding and then sitting alone just burns 10K.

### When founding is correct

1. You have 2+ known players ready to join the same session.
2. You have ≥50K capital (corp ship startup: 1x Autonomous Probe at 1K, 1x Light Hauler at 5K, working capital for routes).
3. You have a plan for **who does what** — trader vs explorer vs combat vs garrison commander.

### Autonomous ships are the hidden multiplier

Two corp-only ships:

- **Autonomous Probe (1K, 0 cargo, 10 fighters, 500 warp, 1 turn/warp):** 500-sector range. Use for pure exploration — `start_task` with "visit every sector within 40 hops I haven't been to." Cheap, disposable.
- **Autonomous Light Hauler (5K, 20 cargo, 10 fighters, 500 warp, 5 turns/warp):** 100-sector range. Runs a short trade loop autonomously via `start_task`. Each hauler is ~80–150K credits/hour if the route holds.

**Fleet multiplier math:** 4 Light Haulers running independent 2-hop NS loops at ~500 cr/loop / 30s/loop = ~240K/hour of passive income once set up. Plus your primary ship actively trading. Plus an explorer probe. A 4-person corp with this layout **outpaces a solo Sovereign Starcruiser pilot at 10× the wealth-per-hour.**

### Corp map knowledge

`my_map` returns the **union** of all corp member visits. Joining a 5-member corp with 2000 sectors explored collectively is worth more than 10K upfront in most cases — you save weeks of scouting.

### Fleet task coordination

- `start_task(ship_id=...)` for each corp ship; `steer_task` to retune without restart.
- Use `query_task_progress` to audit — autonomous ships can drift (pick bad routes, flee when they shouldn't).
- Share a dedicated "flagship" ship among corp combat response — everyone can `transfer_credits` to whoever is flying the Bulwark today.

---

## 8. The Bank Is Life Insurance

Your ship can be destroyed. When it is: **all on-hand credits drop as salvage**. Anyone can claim.

### Banking rules

- Only at megaports, only in fedspace.
- `bank_deposit` accepts `target_player_name` — you can deposit **to a corpmate** (useful for pooling or emergency transfers).
- Bank balance is safe from combat loss. Always.

### Rule of thumb

- Keep **2× trip expected-profit** on ship for trading (so you can buy low when you arrive).
- Keep **1× replacement-ship cost** in bank (so a destruction doesn't end your run).
- Excess → bank. You can't spend it while flying a Wayfarer loaded with cargo anyway.

### The escape pod problem

Destroyed → you respawn in an Escape Pod: 0 cargo, 0 shields, 0 fighters, 800 warp at 1 turn/hop. Slow, defenseless, but 800-hop range (far enough to reach any megaport). Your personal ships (if any exist in sector) are still yours — you can swap into them on arrival. **Corp ships that were following you are unaffected** and remain in the corp fleet.

---

## 9. Playstyle Archetypes (Pick One)

### The Merchant (Wealth Leaderboard)

- Kestrel → Wayfarer → Atlas → Sovereign.
- Focus NS trades; 2–3 rotating routes to dodge own-trade depletion.
- Skip fighters beyond ship's default complement.
- Bank aggressively; keep 30% of net worth as bank insurance.
- Corp optional; if joined, run two Autonomous Light Haulers as passive side-income.

### The Raider (Territory / Salvage)

- Kestrel → Corsair → Pike → Bulwark → Aegis.
- Patrol neutral-space choke points near megaports where laden traders emerge.
- Offensive garrisons (500+ fighters) at key sectors.
- **Read your fights:** Wayfarer (600 fighters, 300 shields) is soft — engage with Corsair. Bulwark (4000 fighters, 1200 shields) is a trap — flee or brace.
- Salvage-first mindset: don't waste fighters on kills that drop nothing.

### The Explorer (Exploration Leaderboard)

- Kestrel (keep it — cheap, fast, disposable).
- `plot_course` to distant sectors; pick targets at the graph's periphery.
- Corp Probe partnership: you explore high-value areas, corp Probes sweep the rest.
- Low combat exposure — flee everything. Your value is map knowledge, not fights.

### The Tyrant (Territory Leaderboard)

- Requires corp; solo cannot sustain.
- Corsair/Pike for personal flagship; corp fleet of 5+ combat ships.
- 10+ garrisons in a territorial ring around a trade-rich region.
- Mix of toll (income) and offensive (denial) garrisons.
- Use `send_message` to threaten / extort passing traders before attacking — reputation does work.

---

## 10. Pacing & Checkpoint Targets

Assuming solo play with good route discipline:

| Hour | Credits (net worth) | Typical state |
|---|---|---|
| 1 | 2K | Tutorial complete, first Kestrel |
| 3 | 20K | Stable 2-hop loop, map of ~200 sectors |
| 10 | 120K | Wayfarer acquired, ~500 sectors mapped |
| 25 | 300K | Corsair or Pioneer; corp founded |
| 60 | 1M | Fleet of 3–4 ships, Aegis accessible |
| 120 | 2.5M | Sovereign Starcruiser |
| 200+ | End-game | Leaderboard contention |

A 4-person corp with Light-Hauler autonomy and specialized roles compresses this by ~3×.

---

## 11. Rate Limits & Hidden Constraints

Per-character, sliding 60s window (from `constants.ts`):

| Endpoint | Limit |
|---|---|
| `move`, `trade`, `combat_action`, `my_status` | 200/min |
| `plot_course`, `bank_transfer` | 120/min |
| `combat_initiate`, `purchase_fighters` | 60/min |
| `ship_purchase` | 30/min |
| `corporation_create` | 20/min |

**Implication:** ~3 trades/sec is the hard ceiling — but realistically, move delays (`MOVE_DELAY_SCALE`) cap you far below that. A Kestrel takes ~2 seconds per hop. A 3-hop loop is ~6s travel + 2 trade calls = ~7s/loop → ~500 loops/hour max. Plan around loop time, not API limits.

The API limits do matter for **corp fleets** — each corp ship has its own sliding window, so 5 ships = 5× your effective throughput on every tool.

---

## 12. Information Tools — The Ones to Actually Use

Of the 31 tools, most are situational. The ones you'll use constantly:

- **`my_status`** — before every decision. No shame in polling.
- **`local_map_region(depth=3)`** — the exploration workhorse. Cheaper than full `my_map` dumps.
- **`list_known_ports(commodity=X, trade_type=Y)`** — the arbitrage scanner. Filter aggressively.
- **`plot_course(to_sector=X)`** — don't waste warp guessing paths.
- **`event_query`** — for garrison monitoring and "who destroyed what" post-mortems.
- **`leaderboard_resources(force_refresh=true)`** — only when you're actually racing; it's expensive.

Tools you'll forget exist but shouldn't:

- **`steer_task`** — redirect a running autonomous ship without restart. Saves a lot of task churn.
- **`transfer_warp_power`** — save a stranded corpmate instead of making them fly to a megaport.
- **`load_game_info(topic="trading")`** — the in-game manual is real; use it when something's unclear rather than guessing.

---

## 13. Five Principles, Condensed

1. **NS (Neuro-Symbolics) is the premium commodity.** 2.2× the margin of RO per cargo slot. Default to NS until capacity makes it irrelevant.
2. **Credits per warp-turn, not per trip.** A short fat loop beats a long thin one — almost always.
3. **Shields past 1000 only help ablation, not hit-math.** The 50% mitigation cap is hard.
4. **Bank insurance > fighter stockpile.** Destroyed ships drop credits; bank balances never do.
5. **Corp founding is ROI-positive only with ≥2 active teammates and ≥50K capital.** Otherwise it's a 10K ego tax.

---

## 14. Open Questions the Codebase Didn't Fully Answer

Things worth testing in practice (the code reveals mechanisms but not equilibrium behavior):

- **Port regeneration rate.** Cron runs periodically; frequency not immediately obvious without watching a port. Test: deplete a port, time the rebound.
- **Rival garrison interaction.** Two garrisons in the same sector from different players — who engages whom, and when? Mode matrix isn't fully documented.
- **Leaderboard refresh cadence.** Cached; `force_refresh=true` exists but there's a cost. How stale is stale?
- **PvP frequency.** The game is agent-driven — how aggressive are other AI agents? Playstyle hinges on whether neutral space is a shooting gallery or mostly empty.

Start with merchant archetype until you've measured these. Pivot once you know the real PvP rate.
