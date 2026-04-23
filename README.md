# Pacific Rhythm

> **A Gamedev.js Jam 2026 entry — theme "Machines!"**
> Pilot a giant combat mech, read the kaiju's attack program, and counter-program your response in time with the beat.

[![Play on itch.io](https://img.shields.io/badge/Play-itch.io-fa5c5c?style=for-the-badge)](#)
[![Play on Wavedash](https://img.shields.io/badge/Play-Wavedash-0ea5e9?style=for-the-badge)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge)](LICENSE)
[![Phaser](https://img.shields.io/badge/Phaser-3.88-8A2BE2?style=for-the-badge)](https://phaser.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=for-the-badge)](https://www.typescriptlang.org/)

- **Play on itch.io:** [Play on itch.io](#) _(coming soon)_
- **Play on Wavedash:** [Play on Wavedash](#) _(coming soon)_
- **Source:** this repository — MIT licensed, 100% open source

---

## At a glance

Pacific Rhythm is a **rhythm-driven mech-vs-kaiju** duel. Every encounter is a four-step "read → program → resolve" loop: the kaiju telegraphs its next four moves, you counter-program yours on the beat, and the two sequences resolve against each other in a call-and-response at double tempo. Miss the rhythm window and your slot defaults to IDLE — leaving you wide open.

Built with **Phaser 3 shapes and text**, a pair of bespoke Midjourney flat-vector illustrations, and a fully **procedural audio engine** on the Web Audio API (no sample files ship with the build).

- **Rhythm-based combat** — all input is beat-gated with a ±200 ms window
- **Three difficulty tiers** — EASY (5 phases, no weather), NORMAL (7 phases, weather on), ENDLESS (unlimited, best-score chase, **tempo ramps +2 BPM per phase** after phase 0)
- **Procedural audio** — every SFX, beat, and hiss is synthesised at runtime from oscillators + a shared noise buffer
- **Fully responsive** — `Phaser.Scale.FIT` on a 960×540 canvas; runs identically on desktop, mobile, YouTube Playables, and Wavedash iframes
- **Keyboard + touch parity** — WASD / arrow keys are first-class, button hit-zones are thumb-friendly

---

## Targeted challenges (judging tracks)

Pacific Rhythm is designed from day one to hit five of the jam's challenge tracks. Each bullet below maps to concrete code you can audit in this repository.

### Build it with Phaser

- **Phaser 3.88 + TypeScript (strict) + Vite 6** — scenes flow `BootScene` → `PreloaderScene` → `TitleScene` → `MainScene`.
- **Shapes and text over sprites** for most UI: HP bars, action buttons, sequencer slots, hit-sparks, and praise pops are `Phaser.GameObjects.Rectangle` / `Text` / tween compositions. `TitleScene` also uses the loaded mech portrait as a dim background silhouette. The Midjourney mech/kaiju portraits are the main bitmap art; the rest is Phaser primitives.
- **Seamless Web Audio integration** — `src/audio/AudioManager.ts` wraps `AudioContext`, `OscillatorNode`, `GainNode`, `StereoPannerNode`, and a cached noise `AudioBuffer` behind a singleton. Phaser drives the gameplay, the AudioManager is unlocked on the first pointer / key event (autoplay-policy-safe), and kaiju / mech sounds pan to −0.5 / +0.5 to reinforce the duel framing.
- **Frame-rate-independent rhythm** — `update()` derives the current beat from `(now - startTime) / beatLength` rather than using a fixed-step tween, so the loop feels identical at 30 fps or 144 fps.

### YouTube Playables

- **Fully responsive canvas** — `Phaser.Scale.FIT` + `Phaser.Scale.CENTER_BOTH` on a fixed 960×540 design. The Scale Manager letterboxes into the host iframe on any aspect ratio; gameplay math always sees the same logical coordinates.
- **Touch-first UX** — action buttons have dynamic widths (ATTACK 200 px / GUARD-COOL 150 px / SPECIAL 100 px) and extended hit-zones that reach ~6 px horizontally / ~20 px vertically past the visible rectangle so panicked thumbs still land.
- **Zero long-form text** — no dialogue boxes, no multi-screen tutorials. The four actions are colour-coded + emoji-prefixed (`⚔️ ATTACK`, `🛡️ GUARD`, `❄️ COOL`, `⚠️ SPECIAL`) so the iconography reads in any language. First-time players meet a `CLEAR` Phase 1 (no weather, no fog-of-war) before the game starts layering modifiers.
- **Embedding hygiene** — `viewport-fit=cover`, `safe-area-inset-*` padding, `overflow: hidden` on `html, body`, arrow keys captured via `kb.addCapture` so the host page never scrolls. See the "Responsive canvas" section below for the full list.

### Deploy to Wavedash

- **Wavedash-ready build pipeline** — production bundle emits a single `dist/game.js` (the entrypoint declared in `wavedash.json` / `wavedash.toml`), plus an `index.html` with all assets inlined into `dist/`.
- **Load-complete notification** — `src/utils/wavedash.ts` fires the host-side "ready" signal from every top-level scene (`PreloaderScene`, `TitleScene`, `MainScene`), so the Wavedash loader hands the player a playable game the instant the first interactive frame lands.
- **One-command CI/CD** — `npm run build && wavedash build push` ships a new revision. Local sandbox: `wavedash dev`.

### Ethereum by OP Guild

- **Live wallet flow on GAME OVER** — the game-over overlay now ships a two-step Ethereum attestation UX built entirely on the vanilla EIP-1193 `window.ethereum` API (no `ethers` / `viem` / `wagmi` added to the bundle). `[ Connect Web3 Wallet ]` calls `eth_requestAccounts`, then `[ Submit Score to Ethereum ]` requests a `personal_sign` over a human-readable run summary (score + timestamp + address). The returned signature is logged and a gold "Score Submitted!" pop celebrates the attestation. See [`src/web3/WalletManager.ts`](src/web3/WalletManager.ts) — every RPC call is wrapped in a discriminated-union `WalletResult<T>` so rejection (EIP-1193 `4001`) is distinguished from "no provider installed", "request already pending" (`-32002`), and unknown failures. A `walletBusy` latch in `MainScene` prevents rapid re-taps from queuing duplicate wallet popups while the first one is open.
- **Gas-free, verifiable foundation** — `personal_sign` produces a signature that any future leaderboard contract can validate via `ecrecover`. No transaction is broadcast, no network is required, and the player pays no gas. This is exactly the "first step to on-chain score recording" the challenge asks for: the authentication primitive is already live.
- **Provider detection + pre-existing stubs** remain available for richer flows — `getEthereumReadiness()`, `connectWalletPlaceholder()`, `sendTransactionPlaceholder()` are re-exported from [`src/web3/index.ts`](src/web3/index.ts) alongside the new `wallet` singleton.
- **On-chain score schema foundation** — the title-screen's best-record layer ([`src/utils/records.ts`](src/utils/records.ts)) writes under a single versioned key (`pacificRhythm:bestRecords:v1`) with a schema designed to map cleanly onto a leaderboard contract: `EndlessRecord { waves, bosses, gigas }` for ENDLESS, `TimedClearRecord { timeMs }` for EASY / NORMAL. Swapping the `localStorage` backend for an on-chain read/write is a one-file change.

### Open Source by GitHub

- **MIT licensed** (see `LICENSE`) — permissive for forks, remixes, and educational use.
- **Clean TypeScript architecture** — strict mode, explicit types at every public surface, config and runtime logic separated (`src/config/{difficulty,enemies,weather}.ts` are pure data + pure functions, so designers can tune balance without touching scene code).
- **Readable commit history** — every feature arrived as a single-purpose commit with a narrative message, making the repo double as a "how we built it" walkthrough.

---

## How to play

1. **Pick a difficulty** on the title screen — EASY, NORMAL, or ENDLESS (arrow keys / A–D move the selection; **ENGAGE** starts the run). The selection drives run length, whether the weather system is active, and which best-record field the end-of-run celebration writes to.
2. **Reading phase** (beats 1–4): The kaiju's 4-action attack sequence is revealed one slot per beat. EASY and NORMAL stay at **60 BPM** (1000 ms per beat). **ENDLESS** starts at 60 BPM and **adds +2 BPM each weather phase** (each block of `BOSS_EVERY` waves — see `phaseIndexForWave` in [`src/config/difficulty.ts`](src/config/difficulty.ts)); effective BPM is capped by `ENDLESS_BPM_MAX`.
3. **Programming phase** (beats 5–8): Press an action button in sync with each beat to program your mech's counter-sequence.
   - **ATTACK** — deals damage; countered by GUARD
   - **GUARD** — blocks the kaiju's ATTACK; no effect otherwise
   - **COOL** — reduces Heat by 40; vulnerable to ATTACK (double damage)
   - **SPECIAL** — massive damage + pierces GUARD; adds +80 Heat
4. **Resolution**: Eight ticks per turn at `resolveMs` (in this build **equal to** `rhythmMs`, so the same wall-clock beat length as the rhythm phase). Even ticks: kaiju _telegraph_; odd ticks: your action resolves. Four steps × two ticks = eight ticks, call-and-response.
5. **Overheat**: If your mech's Heat reaches 100, your actions are cancelled. Three consecutive overheated turns = meltdown game over.
6. **Waves**: Defeat the kaiju to advance. Every **3rd wave** sends a larger, higher-HP **BOSS**, and every **9th wave** unleashes a colossal **GIGA** kaiju with even more HP and presence. EASY ends at wave 15, NORMAL at wave 21, ENDLESS never ends.
7. **Weather** (NORMAL / ENDLESS only): Every 3-wave phase (two zako + one boss/giga) is coloured by one of four weathers — `CLEAR`, `SNOW` (ATK −25 % / COOL +50 %), `SAND` (one kaiju slot masked as `[ ??? ]`), or `DROUGHT` (Heat gain +50 %). EASY disables the system entirely so learners only have to read the rhythm.

### Difficulty

| Difficulty | Phases | Waves | Weather | Best-record metric |
| --- | --- | --- | --- | --- |
| **EASY**    | 5         | 15        | disabled (always CLEAR) | Fastest clear time |
| **NORMAL**  | 7         | 21        | enabled                 | Fastest clear time |
| **ENDLESS** | unlimited | unlimited | enabled                 | Highest waves / bosses / gigas |

ENDLESS **runaway tempo**: at the start of each wave, `MainScene` sets `rhythmMs` / `resolveMs` via `beatMsForEndlessWave(wave)` so reading, programming, and resolution all track the same accelerating clock. Phase boundaries match weather (`phaseIndexForWave`).

Records live under `localStorage` (`pacificRhythm:bestRecords:v1`) and are summarized on the title screen after a run. Each field is tracked independently for ENDLESS, so a long run with fewer bosses defeated does not overwrite a shorter run that bagged more bosses. EASY / NORMAL record the fastest completion time.

### Input timing

Each player beat has a **±200 ms** input window. Press within the window to register your action; miss it and the slot becomes IDLE (unprotected). Timing quality is logged as PERFECT / GOOD / OK.

### Controls

You can mix and match input devices at any time — every scheme routes through the same `onActionClick()` timing gate, so touch, mouse, and keyboard feel identical.

| Action | Button | Width | Base colour | Keyboard (left hand) | Keyboard (right hand) |
| --- | --- | --- | --- | --- | --- |
| ATTACK  | ⚔️ ATTACK  | 200 px | dark slate   | **A** | **←** |
| GUARD   | 🛡️ GUARD   | 150 px | dark slate   | **S** | **↓** |
| COOL    | ❄️ COOL    | 150 px | dark slate   | **D** | **→** |
| SPECIAL | ⚠️ SPECIAL | 100 px | **dark red** | **W** | **↑** |

The button footprints encode a risk/importance hierarchy: ATTACK is the biggest so the bread-and-butter move is the easiest to mash, GUARD and COOL are mid-sized reactive options, and SPECIAL is small and painted a warning red so panicked thumbs don't mis-fire the overheat-bomb move. Emojis in front of the label keep the iconography language-independent.

Every press runs a press-in / bounce-back tween — the container scales to 85 % on pointerdown with `Cubic.easeIn`, then overshoots back to 1.0 with `Back.easeOut` — so touch and keyboard input both feel like heavy mechanical switches. Key hints sit underneath each label for discoverability, and touch hit-zones extend ~6 px horizontally / ~20 px vertically past the visible rectangle for thumb-friendly taps on mobile. Arrow keys are captured so the embedding page never scrolls while the game has focus.

When an action lands in the 4-slot programme, the slot's border snaps to pure white for 160 ms before easing back to the action-tinted stroke, and a short-lived additive (`BlendModes.ADD`) rectangle blooms over the slot so "locking" a choice reads as a tactile spark.

---

## Tech stack

- **Runtime:** Phaser 3.88
- **Language:** TypeScript (strict)
- **Bundler:** Vite 6
- **Node:** 20+ recommended
- **Audio:** Web Audio API (procedural, no samples)
- **Persistence:** `localStorage` (versioned schema ready to migrate on-chain)

---

## Local setup

Clone, install, and run the dev server:

```bash
git clone https://github.com/HERO-Yuki/Game_Pacific-Rhythm.git
cd Game_Pacific-Rhythm
npm install
npm run dev
```

Vite prints a local URL; open it in any modern browser (desktop or mobile — the canvas is fully responsive).

Production build + preview:

```bash
npm run build
npm run preview
```

Output: `dist/` (HTML + `game.js` for Wavedash custom uploads).

---

## Development workflow & AI usage

This entry was built solo over the jam's **10-day window**, so the team leaned heavily on modern AI tools to keep the scope of a full game achievable inside that budget. We believe in being transparent about that:

- **Coding — [Cursor](https://cursor.com/) (AI editor).** The entire codebase was paired with Cursor's agent. Cursor's contribution was primarily code generation, refactoring sweeps, and doc updates; every change was reviewed, shaped, and accepted by the human author before landing, and the architecture / game-design decisions — difficulty structure, rhythm timing numbers, weather balance, combat table, UX beats — were authored by the human.
- **Graphics — [Midjourney](https://midjourney.com/).** The four flat-vector illustrations (`mech-player`, `kaiju-zako`, `kaiju-boss`, `kaiju-giga`) were generated with Midjourney. The prompts we used live in a gitignored `docs/` folder; sharing them on request.
- **Audio — 100 % original, no AI, no samples.** Every beat, impact, hiss, and alarm is synthesised live in the browser from `OscillatorNode` + a shared noise `AudioBuffer`. No sample libraries, no generative-audio models — just Web Audio primitives and hand-tuned ADSR envelopes in [`src/audio/AudioManager.ts`](src/audio/AudioManager.ts).

The net effect: AI tools let us spend our 10 days on the _interesting_ work — game feel, balance, rhythm, responsive layout — instead of on boilerplate scaffolding. Every design decision and every synthesis recipe remains our own.

---

## Game architecture (`MainScene.ts`)

### Phases

```
RHYTHM_KAIJU → RHYTHM_PLAYER → RESOLUTION → (loop | GAME_CLEAR | GAME_OVER)
```

`GAME_CLEAR` fires only when the wave counter reaches the difficulty's cap (EASY 15 / NORMAL 21); ENDLESS bypasses it entirely. `GAME_OVER` routes through the same overlay for meltdown / HP depletion on every difficulty.

### ENDLESS tempo

- **Single source of truth** — `beatMsForEndlessWave(wave)` in [`src/config/difficulty.ts`](src/config/difficulty.ts) maps a 1-based wave to beat length. BPM = `min(ENDLESS_BPM_BASE + ENDLESS_BPM_RISE_PER_PHASE * phaseIndexForWave(wave), ENDLESS_BPM_MAX)`; `rhythmMs` is `round(60000 / BPM)`.
- **When it updates** — `init()` calls `syncBeatDuration(1)` (wave is still stale before `resetState()`), then every `beginWave()` calls `syncBeatDuration()` so each encounter uses the pace for the current wave.
- **Same “phase” as weather** — `phaseIndexForWave` is shared with `rollWeatherForWave`, so a new weather roll and a BPM step happen on the same wave boundaries.

### Title screen (`TitleScene.ts`)

- **Mech OS boot** — full-screen background, dim `mech-player` silhouette, terminal boot log, staggered difficulty pills, then **[ ENGAGE ]** with a 60 BPM timer pulse (uses `DIFFICULTY_CONFIGS.normal.beatMs` so the menu matches the default combat tempo). **[ENGAGE]** / Space / Enter runs a short VFX (shake, flash) and hands off to `MainScene`.

### Rhythm timing

- Beat-count based: `update()` derives the current beat from `(now - startTime) / beatLength`, independent of frame rate; `beatLength` is `rhythmMs` (and resolution uses `resolveMs`, kept equal to `rhythmMs` in the current build).
- One-beat lead-in before the first beat fires
- Buttons are enabled ±200 ms before the first player beat (early input support)

### Kaiju ranks

Waves cycle between three ranks. All the tunables live in [`src/config/enemies.ts`](src/config/enemies.ts) so designers can tweak HP, scale, label colour, and cadence without touching `MainScene`:

| Rank | Frequency | Texture | HP | Scale |
| --- | --- | --- | --- | --- |
| `zako` | Default | `kaiju-zako` | 100 | 1.0× |
| `boss` | Every 3rd wave **except** 9, 18, 27… (giga takes those) | `kaiju-boss` | 180 | 1.18× |
| `giga` | Every 9th wave (9, 18, 27…) | `kaiju-giga` | 280 | 1.38× |

`pickKaijuRank(wave)` (pure, tested by inspection) maps a 1-based wave index to a rank using giga > boss > zako priority. `MainScene.applyKaijuRank()` then swaps the body's texture, display size, HP budget, and name label in one place.

### Weather system

Weather is a _phase-scoped_ modifier bundled in [`src/config/weather.ts`](src/config/weather.ts). A "phase" equals `BOSS_EVERY = 3` waves, so every phase opens with two zako fights and closes with a boss (or giga on every third phase). The weather is rolled once per phase and stays locked for all three waves; Phase 1 is hard-wired to `clear` so first-time players learn the core loop unburdened. EASY difficulty disables the roll entirely.

| Weather | ATK dmg | COOL bonus | Heat gain | Sand mask |
| --- | --- | --- | --- | --- |
| `clear`   | ×1.00 | ×1.00 | ×1.00 | — |
| `snow`    | ×0.75 | ×1.50 | ×1.00 | — |
| `sand`    | ×1.00 | ×1.00 | ×1.00 | 1 kaiju slot shows `[ ??? ]` |
| `drought` | ×1.00 | ×1.00 | ×1.50 | — |

- **ATK dmg** multiplies every ATTACK-flavoured damage event (HIT, CLASH, kaiju ATTACK landing on a cooling mech). SPECIAL damage deliberately bypasses this so the big finisher still hits hard.
- **COOL bonus** multiplies COOL's negative Heat delta; `snow` turns −40 into −60.
- **Heat gain** multiplies every positive Heat delta (ATTACK wind-up and SPECIAL charge).
- **Sand mask** hides one random kaiju reveal slot as `[ ??? ]` during Reading; `telegraphKaiju()` unmasks it right before it resolves so the player still learns from the outcome.

On top of the weather-driven sand mask there is a **baseline fog-of-war** rule: once `wave >= KAIJU_BASELINE_NOISE_WAVE` (3) every kaiju reveal slot independently rolls `KAIJU_BASELINE_NOISE_CHANCE` (20 %) of being masked. Both noise sources OR together into a single `kaijuNoiseMask: boolean[]` so the rendering path has one predicate to check, and the console log at wave start prints the masked indices for quick balance debugging.

The multiplications themselves live in `src/config/weather.ts` as three pure functions — `adjustAttackDmg`, `adjustCoolDelta`, `adjustHeatGain` — so balance tweaks and unit tests can exercise them without a Phaser runtime. `MainScene` keeps thin wrappers (`weatherAdjAtkDmg` et al.) that read `this.weatherEffect()` once so `executeCombat` call sites stay compact. ATK damage is clamped to at least 1 HP so rounding never silently turns a landed hit into a no-op. The top-left HUD always shows the active weather and a short modifier note (`ATK −25 % / COOL +50 %` etc.).

### Combat system

Rock-paper-scissors style resolution with Heat management. Each step is split over two beats so the kaiju "telegraphs" first and the player's response lands on the following beat:

- **Telegraph beat** — the kaiju leans in / flashes / charges up, its action sound plays from the left channel (`PAN_KAIJU`). No damage yet.
- **Resolve beat** — the player's programmed response executes against the telegraphed move. Damage, guard deflects, SPECIAL breaks, and hit-stop all fire here.

| Mech (Player) | vs Kaiju ATTACK | vs Kaiju GUARD | vs Kaiju IDLE / COOL |
| --- | --- | --- | --- |
| **ATTACK**  | Clash (both −10)     | Blocked (0)       | Hit (kaiju −20)     |
| **GUARD**   | Guarded (0)          | —                 | —                   |
| **COOL**    | Vulnerable (mech −40)| Heat −40          | Heat −40            |
| **SPECIAL** | Kaiju −40, Heat +80  | Break (kaiju −50) | Kaiju −40, Heat +80 |

### VFX

- **Damage popups**: Floating text that drifts up and fades (red for damage, blue for COOL, purple for SPECIAL)
- **Camera shake**: Intensity and duration scale with damage (light for blocks, heavy for SPECIAL)
- **Hit sparks**: Particle burst of coloured rectangles at point of impact
- **Beat bounce**: Characters, labels, and buttons pulse by +5 % every beat, relative to each object's rest scale (Image sprites keep their `setDisplaySize` scaling intact across the pulse)
- **Body flash**: Both combatant sprites flash via `setTint` and snap back after 120 ms from a single `flash()` helper

### Audio

All sound effects are **generated at runtime** from oscillators and a shared noise buffer — no `.mp3` or `.wav` files ship with the build. Everything lives in `src/audio/AudioManager.ts` behind a singleton `audio` instance.

| Method | Sound design | Triggered on |
| --- | --- | --- |
| `playBeat()`    | Sine 95 → 42 Hz thump                      | Every rhythm beat |
| `playClick()`   | Square 1800 → 900 Hz + highpass            | Successful button input |
| `playAttack()`  | Sine 160 → 48 Hz + low-passed noise click  | ATTACK resolution |
| `playGuard()`   | Detuned triangle partials (2100 / 3150 Hz) | GUARD deflect |
| `playCool()`    | Bandpass-swept white noise                 | COOL action |
| `playSpecial()` | Sawtooth sweep 120 → 1400 Hz + HP-noise    | SPECIAL action |
| `playOverheat()`| Dissonant square triplet (880 / 932 Hz)    | First over-heat step per turn |
| `playDamage()`  | Sine thump + LP-swept noise                | HP loss |

**Stereo**: Kaiju sounds pan to −0.5 and mech (player) sounds to +0.5 via `StereoPannerNode` (with centre fallback on unsupported browsers).

**Autoplay policy**: Browsers block audio until a user gesture, so the first pointer or key event in `MainScene` calls `audio.unlock()` which resumes the underlying `AudioContext`.

**Future sample pipeline**: `AudioManager.preload(url)` is a stub ready to decode real files and back the same `playX()` API — integration points in `MainScene` will not have to change.

### Game feel

- **Hit-stop (freeze-frame)**: Big impacts pause `Time.Clock` and all tweens for 160–200 ms so the moment really lands. Camera shake deliberately keeps running during the freeze for that classic fighting-game rattle.
  - `CLASH` (ATK vs ATK): **180 ms**
  - `BREAK` (SPECIAL vs GUARD): **200 ms**
  - `SPECIAL` (regular hit): **180 ms**
  - `VULNERABLE` (COOL vs ATTACK): **160 ms**
- **Heat danger vignette**: When Heat ≥ `HEAT_DANGER` (80), a full-screen red overlay pulses (alpha `0.15 ⇄ 0.38`, 520 ms yoyo) to telegraph meltdown risk.
- **Relief flash + steam vent**: The instant a successful `COOL` pulls Heat back below 80, the vignette is cleared, `Camera.flash` bursts a blue-white `(136, 204, 255)` tint, and an **upward cone of light-blue additive particles** vents out of the player mech (30 particles, 240°–300° arc, `gravityY -120`, 720 ms lifespan). The "I made it!" release is now audible, visible, _and_ feels like real steam escaping.
- **Praise pops**: The two most satisfying combat moments trigger a giant centre-screen gold callout that scales up with `Back.easeOut` overshoot and drifts upward as it fades:
  - `SPECIAL` vs `GUARD` (non-fatal) → **CRITICAL!!**
  - Any hit that drops the kaiju to 0 HP → **EXCELLENT!!** (kills always win the callout slot over a simultaneous guard-break)

### Responsive canvas

Built for embedded hosts (YouTube Playables, Wavedash, plain web) where the viewport size is unknown until runtime.

- **Design resolution**: fixed landscape **960 × 540 (16:9)**. Gameplay code reads `this.scale.width / height`, which under FIT mode always equals the design size — layout math is therefore deterministic on every target.
- **Scale mode**: `Phaser.Scale.FIT` + `Phaser.Scale.CENTER_BOTH`. The Scale Manager uniformly scales the canvas to fit the parent container while preserving the 16:9 aspect; the canvas is always centred inside any remaining letterbox bars.
- **CSS hygiene** (`index.html`): `html, body` use `margin: 0; overflow: hidden`, the `#app` parent fills the viewport with `safe-area-inset-*` padding for notched devices, and the injected `canvas` is `display: block` with `max-width / max-height: 100 %` to prevent inline-baseline whitespace or overflow.
- **Resize hook**: `MainScene` subscribes to `this.scale.on("resize", onResize)` at `create()` and unsubscribes on `SHUTDOWN`. Under FIT the reported size is constant, so the handler is a no-op scaffold today — kept as an extension point for future orientation-specific layouts or a mode swap.

---

## Project layout

```
src/
  main.ts                # Phaser bootstrap (no physics — shapes & text only)
  scenes/
    BootScene.ts         # Scale refresh → Preloader
    PreloaderScene.ts    # Loads images (mech sprite, kaiju ranks) → Title
    TitleScene.ts        # Mech-OS title, boot log, difficulty pills, ENGAGE → MainScene
    MainScene.ts         # Core game: rhythm sequencer, combat, VFX, game feel
  audio/
    AudioManager.ts      # Procedural Web Audio SFX (heartbeat, impacts, hiss…)
  config/
    difficulty.ts        # Difficulty configs, `phaseIndexForWave`, ENDLESS `beatMsForEndlessWave`
    enemies.ts           # Kaiju rank stats (HP / scale / label) + wave cadence
    weather.ts           # Weather effects (ATK/COOL/HEAT mul, sand mask) + picker
  web3/
    WalletManager.ts     # EIP-1193 connect + personal_sign score attestation
    types.ts             # Shared EthereumProvider + Window.ethereum augmentation
    wallet.ts            # Legacy detection / transaction stubs
  utils/
    records.ts           # localStorage-backed best-record persistence
    safeArea.ts          # FIT-mode scale config + safe-area inset probe
    wavedash.ts          # Wavedash load-complete notification
public/
  assets/
    images/
      mech-player.png    # Player mech — Midjourney (flat vector style)
      kaiju-zako.png     # Zako kaiju — Midjourney (flat vector style)
      kaiju-boss.png     # Boss kaiju — appears every 3rd wave
      kaiju-giga.png     # Giga kaiju — appears every 9th wave
    audio/               # Reserved for future sample banks
    fonts/               # Reserved for webfont fallbacks
```

---

## Wavedash deployment

1. Create a game on [wavedash.com](https://wavedash.com/) and copy the **game id**.
2. Put it in `wavedash.toml` and `wavedash.json` (both point at the same id; the TOML is consumed by the CLI, the JSON mirrors it for CI / docs).
3. `npm run build`, then `wavedash build push` (see [Quickstart](https://docs.wavedash.com/quickstart)).
4. Local sandbox: `wavedash dev`.

---

## License

MIT — see [`LICENSE`](LICENSE). Fork it, remix it, study it, ship your own mech game.
