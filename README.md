# Pacific Rhythm

**Gamedev.js Jam 2026** entry — theme **"Machines!"**

A rhythm-based sequencer battle game where you read the enemy's incoming program, then input your own counter-program in time with the beat. Miss the rhythm and your slot defaults to IDLE — leaving you wide open.

Built entirely with **Phaser 3 shapes and text** (no image assets) and a fully **procedural audio engine** built on the Web Audio API (no sample files).

## How to play

1. **Reading phase** (beats 1-4): The enemy's 4-action sequence is revealed one slot per beat at BPM 60.
2. **Programming phase** (beats 5-8): Press an action button in sync with each beat to fill your counter-sequence.
   - **ATTACK** — deals damage; countered by GUARD
   - **GUARD** — blocks enemy ATTACK; no effect otherwise
   - **COOL** — reduces Heat by 40; vulnerable to ATTACK (double damage)
   - **SPECIAL** — massive damage + pierces GUARD; adds +80 Heat
3. **Resolution**: Actions are resolved step-by-step at BPM 120 with hit sparks, damage popups, and camera shake.
4. **Overheat**: If your Heat reaches 100, your actions are cancelled. Three consecutive overheated turns = meltdown game over.
5. **Waves**: Defeat the enemy to advance. How many waves can you survive?

### Input timing

Each player beat has a **±200 ms** input window. Press within the window to register your action; miss it and the slot becomes IDLE (unprotected). Timing quality is logged as PERFECT / GOOD / OK.

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
    PreloaderScene.ts    # Asset loading (currently pass-through) → MainScene
    MainScene.ts         # Core game: rhythm sequencer, combat, VFX, game feel
  audio/
    AudioManager.ts      # Procedural Web Audio SFX (heartbeat, impacts, hiss…)
  web3/                  # Ethereum integration stubs
  utils/
    safeArea.ts          # FIT-mode scale config + safe-area inset probe
    wavedash.ts          # Wavedash load-complete notification
public/
  assets/                # Drop real art/audio here when ready
```

## Game architecture (MainScene.ts)

### Phases

```
RHYTHM_ENEMY → RHYTHM_PLAYER → RESOLUTION → (loop or GAME_OVER)
```

### Rhythm timing

- Beat-count based: `update()` derives the current beat from `(now - startTime) / beatLength`, independent of frame rate
- One-beat lead-in before the first beat fires
- Buttons are enabled ±200 ms before the first player beat (early input support)

### Combat system

Rock-paper-scissors style resolution with Heat management:

| Player | vs ATTACK | vs GUARD | vs IDLE / COOL |
| --- | --- | --- | --- |
| **ATTACK** | Clash (both -10) | Blocked (0) | Hit (enemy -20) |
| **GUARD** | Guarded (0) | — | — |
| **COOL** | Vulnerable (player -40) | Heat -40 | Heat -40 |
| **SPECIAL** | Enemy -40, Heat +80 | Break (enemy -50) | Enemy -40, Heat +80 |

### VFX (all Phaser built-in, no assets)

- **Damage popups**: Floating text that drifts up and fades (red for damage, blue for COOL, purple for SPECIAL)
- **Camera shake**: Intensity and duration scale with damage (light for blocks, heavy for SPECIAL)
- **Hit sparks**: Particle burst of coloured rectangles at point of impact
- **Beat bounce**: Characters, labels, and buttons pulse scale 1.0 → 1.05 → 1.0 every beat

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

**Stereo**: Enemy sounds pan to `-0.5` and player sounds to `+0.5` via `StereoPannerNode` (with centre fallback on unsupported browsers).

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
