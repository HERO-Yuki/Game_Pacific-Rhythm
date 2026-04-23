# Pacific Rhythm

**Gamedev.js Jam 2026** entry — theme **"Machines!"**

Pilot a giant combat **mech** and take down the **KAIJU (怪獣)** menace one beat at a time. Read the kaiju's incoming attack program, then counter-program your mech's response in time with the beat. Miss the rhythm and your slot defaults to IDLE — leaving you wide open.

Built with **Phaser 3 shapes and text** plus a pair of bespoke Midjourney flat-vector illustrations (player mech, zako kaiju) and a fully **procedural audio engine** built on the Web Audio API (no sample files).

## How to play

1. **Reading phase** (beats 1-4): The kaiju's 4-action attack sequence is revealed one slot per beat at BPM 60.
2. **Programming phase** (beats 5-8): Press an action button in sync with each beat to program your mech's counter-sequence.
   - **ATTACK** — deals damage; countered by GUARD
   - **GUARD** — blocks the kaiju's ATTACK; no effect otherwise
   - **COOL** — reduces Heat by 40; vulnerable to ATTACK (double damage)
   - **SPECIAL** — massive damage + pierces GUARD; adds +80 Heat
3. **Resolution**: Each of the 4 steps plays across **two beats** at BPM 120 — a _telegraph_ beat where the kaiju shows its move, then a _resolve_ beat where your response lands. 8 beats total, call-and-response.
4. **Overheat**: If your mech's Heat reaches 100, your actions are cancelled. Three consecutive overheated turns = meltdown game over.
5. **Waves**: Defeat the kaiju to advance. Every **3rd wave** sends a larger, higher-HP **BOSS**, and every **9th wave** unleashes a colossal **GIGA** kaiju with even more HP and presence. How many waves can your pilot survive?
6. **Weather**: Every **3-wave phase** (two zako + one boss/giga) is coloured by one of four weathers — `CLEAR`, `SNOW` (ATK-25% / COOL+50%), `SAND` (one kaiju slot masked as `?`), or `DROUGHT` (Heat gain +50%). The active weather is shown in the top-left HUD and stays locked for the whole phase; Phase 1 is always CLEAR so newcomers meet the core loop first.

### Input timing

Each player beat has a **±200 ms** input window. Press within the window to register your action; miss it and the slot becomes IDLE (unprotected). Timing quality is logged as PERFECT / GOOD / OK.

### Controls

You can mix and match input devices at any time — every scheme routes through the same `onActionClick()` timing gate, so touch, mouse, and keyboard feel identical.

| Action | Button | Keyboard (left hand) | Keyboard (right hand) |
| --- | --- | --- | --- |
| ATTACK  | ATTACK  | **A** | **←** |
| GUARD   | GUARD   | **S** | **↓** |
| COOL    | COOL    | **D** | **→** |
| SPECIAL | SPECIAL | **W** | **↑** |

Action buttons carry the key hint underneath their label for discoverability, and their touch hit-zones extend ~6 px horizontally / ~20 px vertically past the visible rectangle for thumb-friendly taps on mobile. Arrow keys are captured so the embedding page never scrolls while the game has focus.

## Challenge alignment

| Track | Implementation |
| --- | --- |
| **Build it with Phaser** | Phaser 3.88 + TypeScript + Vite; scenes `Boot` → `Preloader` → `MainScene` |
| **Open Source by GitHub** | MIT `LICENSE`, permissive structure for forks |
| **Deploy to Wavedash** | `wavedash.toml` + `wavedash.json`; production bundle emits `dist/game.js` |
| **YouTube Playables** | `Scale.FIT` + `CENTER_BOTH` on a 960×540 (16:9) design, `viewport-fit=cover`, safe-area padding |
| **Ethereum by OP Guild** | `src/web3/` placeholders (add viem/ethers/wagmi to activate) |

## Tech stack

- **Runtime:** Phaser 3.88
- **Language:** TypeScript (strict)
- **Bundler:** Vite 6
- **Node:** 20+ recommended

## Quick start

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
npm run preview
```

Output: `dist/` (HTML + `game.js` for Wavedash custom uploads).

## Project layout

```
src/
  main.ts                # Phaser bootstrap (no physics — shapes & text only)
  scenes/
    BootScene.ts         # Scale refresh → Preloader
    PreloaderScene.ts    # Loads images (mech sprite, future kaiju art) → MainScene
    MainScene.ts         # Core game: rhythm sequencer, combat, VFX, game feel
  audio/
    AudioManager.ts      # Procedural Web Audio SFX (heartbeat, impacts, hiss…)
  config/
    enemies.ts           # Kaiju rank stats (HP / scale / label) + wave cadence
    weather.ts           # Weather effects (ATK/COOL/HEAT mul, sand mask) + picker
  web3/                  # Ethereum integration stubs
  utils/
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

## Game architecture (MainScene.ts)

### Phases

```
RHYTHM_KAIJU → RHYTHM_PLAYER → RESOLUTION → (loop or GAME_OVER)
```

### Rhythm timing

- Beat-count based: `update()` derives the current beat from `(now - startTime) / beatLength`, independent of frame rate
- One-beat lead-in before the first beat fires
- Buttons are enabled ±200 ms before the first player beat (early input support)

### Kaiju ranks

Waves cycle between three ranks. All the tunables live in [`src/config/enemies.ts`](src/config/enemies.ts) so designers can tweak HP, scale, label colour, and cadence without touching `MainScene`:

| Rank | Frequency | Texture | HP | Scale |
| --- | --- | --- | --- | --- |
| `zako` | Default | `kaiju-zako` | 100 | 1.0× |
| `boss` | Every `BOSS_EVERY = 3` waves (3, 6, 12, 15…) | `kaiju-boss` | 180 | 1.18× |
| `giga` | Every `GIGA_EVERY = 9` waves (9, 18, 27…) — overrides boss | `kaiju-giga` | 280 | 1.38× |

`pickKaijuRank(wave)` (pure, tested by inspection) maps a 1-based wave index to a rank using giga > boss > zako priority. `MainScene.applyKaijuRank()` then swaps the body's texture, display size, HP budget, and name label in one place.

### Weather system

Weather is a *phase-scoped* modifier bundled in [`src/config/weather.ts`](src/config/weather.ts). A "phase" equals `BOSS_EVERY = 3` waves, so every phase opens with two zako fights and closes with a boss (or giga on every third phase). The weather is rolled once per phase and stays locked for all three waves; Phase 1 is hard-wired to `clear` so first-time players learn the core loop unburdened.

| Weather | ATK dmg | COOL bonus | Heat gain | Sand mask |
| --- | --- | --- | --- | --- |
| `clear`   | ×1.00 | ×1.00 | ×1.00 | — |
| `snow`    | ×0.75 | ×1.50 | ×1.00 | — |
| `sand`    | ×1.00 | ×1.00 | ×1.00 | 1 kaiju slot shows `?` |
| `drought` | ×1.00 | ×1.00 | ×1.50 | — |

- **ATK dmg** multiplies every ATTACK-flavoured damage event (HIT, CLASH, kaiju ATTACK landing on a cooling mech). SPECIAL damage deliberately bypasses this so the big finisher still hits hard.
- **COOL bonus** multiplies COOL's negative Heat delta; `snow` turns `-40` into `-60`.
- **Heat gain** multiplies every positive Heat delta (ATTACK wind-up and SPECIAL charge).
- **Sand mask** hides one random kaiju reveal slot as `?` during Reading; `telegraphKaiju()` unmasks it right before it resolves so the player still learns from the outcome.

Three helper methods on `MainScene` — `weatherAdjAtkDmg`, `weatherAdjCoolDelta`, `weatherAdjHeatGain` — wrap the multiplications and clamp ATK damage to at least 1 so rounding never turns a landed hit into a no-op. The top-left HUD always shows the active weather and a short modifier note (`ATK -25% / COOL +50%` etc.).

### Combat system

Rock-paper-scissors style resolution with Heat management. Each step is split over two beats so the kaiju "telegraphs" first and the player's response lands on the following beat:

- **Telegraph beat** — the kaiju leans in / flashes / charges up, its action sound plays from the left channel (`PAN_KAIJU`). No damage yet.
- **Resolve beat** — the player's programmed response executes against the telegraphed move. Damage, guard deflects, SPECIAL breaks, and hit-stop all fire here.

| Mech (Player) | vs Kaiju ATTACK | vs Kaiju GUARD | vs Kaiju IDLE / COOL |
| --- | --- | --- | --- |
| **ATTACK** | Clash (both -10) | Blocked (0) | Hit (kaiju -20) |
| **GUARD** | Guarded (0) | — | — |
| **COOL** | Vulnerable (mech -40) | Heat -40 | Heat -40 |
| **SPECIAL** | Kaiju -40, Heat +80 | Break (kaiju -50) | Kaiju -40, Heat +80 |

### VFX

- **Damage popups**: Floating text that drifts up and fades (red for damage, blue for COOL, purple for SPECIAL)
- **Camera shake**: Intensity and duration scale with damage (light for blocks, heavy for SPECIAL)
- **Hit sparks**: Particle burst of coloured rectangles at point of impact
- **Beat bounce**: Characters, labels, and buttons pulse by +5 % every beat, relative to each object's rest scale (Image sprites keep their `setDisplaySize` scaling intact across the pulse)
- **Body flash**: Both combatant sprites flash via `setTint` and snap back after 120 ms from a single `flash()` helper

### Audio (Phase 2)

All sound effects are **generated at runtime** from oscillators and a shared noise buffer — no `.mp3` or `.wav` files ship with the build. Everything lives in `src/audio/AudioManager.ts` behind a singleton `audio` instance.

| Method | Sound design | Triggered on |
| --- | --- | --- |
| `playBeat()`   | Sine 95 → 42 Hz thump                      | Every rhythm beat |
| `playClick()`  | Square 1800 → 900 Hz + highpass            | Successful button input |
| `playAttack()` | Sine 160 → 48 Hz + low-passed noise click  | ATTACK resolution |
| `playGuard()`  | Detuned triangle partials (2100 / 3150 Hz) | GUARD deflect |
| `playCool()`   | Bandpass-swept white noise                 | COOL action |
| `playSpecial()`| Sawtooth sweep 120 → 1400 Hz + HP-noise    | SPECIAL action |
| `playOverheat()`| Dissonant square triplet (880 / 932 Hz)   | First over-heat step per turn |
| `playDamage()` | Sine thump + LP-swept noise                | HP loss |

**Stereo**: Kaiju sounds pan to `-0.5` and mech (player) sounds to `+0.5` via `StereoPannerNode` (with centre fallback on unsupported browsers).

**Autoplay policy**: Browsers block audio until a user gesture, so the first pointer or key event in `MainScene` calls `audio.unlock()` which resumes the underlying `AudioContext`.

**Future sample pipeline**: `AudioManager.preload(url)` is a stub ready to decode real files and back the same `playX()` API — integration points in `MainScene` will not have to change.

### Game feel (Phase 3)

- **Hit-stop (freeze-frame)**: Big impacts pause `Time.Clock` and all tweens for 160–200 ms so the moment really lands. Camera shake deliberately keeps running during the freeze for that classic fighting-game rattle.
  - `CLASH` (ATK vs ATK): **180 ms**
  - `BREAK` (SPECIAL vs GUARD): **200 ms**
  - `SPECIAL` (regular hit): **180 ms**
  - `VULNERABLE` (COOL vs ATTACK): **160 ms**
- **Heat danger vignette**: When Heat ≥ 70, a full-screen red overlay pulses (alpha `0.15 ⇄ 0.38`, 520 ms yoyo) to telegraph meltdown risk.
- **Relief flash**: The instant a successful `COOL` pulls Heat back below 70, the vignette is cleared and `Camera.flash` bursts a blue-white `(136, 204, 255)` tint — the "I made it!" release.

### Responsive canvas (Phase 4)

Built for embedded hosts (YouTube Playables, Wavedash, plain web) where the viewport size is unknown until runtime.

- **Design resolution**: fixed landscape **960 × 540 (16:9)**. Gameplay code reads `this.scale.width / height`, which under FIT mode always equals the design size — layout math is therefore deterministic on every target.
- **Scale mode**: `Phaser.Scale.FIT` + `Phaser.Scale.CENTER_BOTH`. The Scale Manager uniformly scales the canvas to fit the parent container while preserving the 16:9 aspect; the canvas is always centred inside any remaining letterbox bars.
- **CSS hygiene** (`index.html`): `html, body` use `margin: 0; overflow: hidden`, the `#app` parent fills the viewport with `safe-area-inset-*` padding for notched devices, and the injected `canvas` is `display: block` with `max-width / max-height: 100%` to prevent inline-baseline whitespace or overflow.
- **Resize hook**: `MainScene` subscribes to `this.scale.on("resize", onResize)` at `create()` and unsubscribes on `SHUTDOWN`. Under FIT the reported size is constant, so the handler is a no-op scaffold today — kept as an extension point for future orientation-specific layouts or a mode swap.

## Wavedash

1. Create a game on [wavedash.com](https://wavedash.com/) and copy the **game id**.
2. Put it in `wavedash.toml` and `wavedash.json`.
3. `npm run build`, then `wavedash build push` (see [Quickstart](https://docs.wavedash.com/quickstart)).
4. Local sandbox: `wavedash dev`.

## License

MIT — see `LICENSE`.
