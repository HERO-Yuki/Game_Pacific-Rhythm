# Pacific Rhythm

**Gamedev.js Jam 2026** entry — theme **"Machines!"**

A rhythm-based sequencer battle game where you read the enemy's incoming program, then input your own counter-program in time with the beat. Miss the rhythm and your slot defaults to IDLE — leaving you wide open.

Built entirely with **Phaser 3 shapes and text** (no image assets).

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
| **YouTube Playables** | `Scale.RESIZE`, responsive layout, `viewport-fit=cover`, safe-area padding |
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
    MainScene.ts         # Core game: rhythm sequencer, combat, VFX (~1000 lines)
  web3/                  # Ethereum integration stubs
  utils/
    safeArea.ts          # Responsive scale config
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

## Wavedash

1. Create a game on [wavedash.com](https://wavedash.com/) and copy the **game id**.
2. Put it in `wavedash.toml` and `wavedash.json`.
3. `npm run build`, then `wavedash build push` (see [Quickstart](https://docs.wavedash.com/quickstart)).
4. Local sandbox: `wavedash dev`.

## License

MIT — see `LICENSE`.
