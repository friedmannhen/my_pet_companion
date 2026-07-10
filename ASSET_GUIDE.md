# My Pet Companion — Asset & Canvas Guide (for the designer)

This is the authoritative size sheet for all sprites and UI art. Every number
here comes from the live game code, so if art is delivered at these sizes it
drops in with **zero stretching**. Keep this doc and the code in sync — if a
size changes in code, update it here in the same commit.

## 1. The golden rule: logical pixels × 2

The game is an Electron desktop overlay. It renders in **logical (CSS)
pixels**, and Windows display scaling (125%–200% is common on 2K/4K
monitors) multiplies those into more physical pixels. So:

- **Author every asset at 2× its logical size** (the "@2x" convention).
  The game displays it at logical size; on high-DPI screens the extra
  pixels keep it crisp, on 1080p it downscales cleanly.
- Never upscale. Downscaling is safe; stretching up is what makes art mushy.
- Work in whole even numbers so the 2× → 1× halving never lands on half pixels.

**Target monitors:** 24″–35″, from 1920×1080 up to 3440×1440 ultrawide and
4K. The design-safe canvas is **1920×1080 logical** — if a layout fits
there, it fits everywhere we ship.

## 2. Pets (sprite sheets)

| Property | Value |
|---|---|
| In-game pet cell (logical) | **128 × 128 px** |
| Author each frame at | **512 × 512 px** (4×) |
| Sheet layout | one row per animation, frames left→right, grid-aligned |
| Padding inside each cell | keep ~8% empty margin on all sides (no part of the pet may touch the cell edge — effects/squash need headroom) |
| Anchor | **bottom-center** = the pet's feet. Every frame of every animation must share this anchor or the pet will "swim" between frames |
| Facing | author facing **RIGHT** only — the game mirrors horizontally for left |
| Format | PNG-32 (transparent background), no baked drop shadows |

Why 4× for pets when everything else is 2×: pets get scaled UP briefly
during effects (evolution charge pulses to ~1.06×, the ball zooms to 16× as
a screen-throw flourish uses the ball art, and future zoom cinematics), so
extra headroom is cheap insurance on our most-looked-at asset.

### Animations needed per pet, per stage (baby / adult / final)

Matching what the code drives today (frame counts are suggestions — any
count is fine as long as the row loops cleanly):

| Animation | Suggested frames | Loops? | Notes |
|---|---|---|---|
| idle | 2–4 | yes | includes the blink frame(s) we currently swap by hand |
| walk | 4–6 | yes | code also adds bounce/tilt, so subtle is fine |
| eat | 2–4 | yes (short) | plays ~1.4s while chewing |
| happy | 2–4 | no | one wiggle burst |
| sleep | 1–2 | yes (slow) | |
| wash/soapy | 2–4 | yes | played during scrubbing (optional v1) |
| overfed/sick | 1–2 | no | queasy face |
| dead | 1 | — | currently an emoji placeholder |

**Egg** (one per pet type): 128×128 cell like the pet. Needs: idle, wobble
(warming), overheat (reddened — the game also adds a red glow, so a tinted
variant is enough), hatch-crack sequence 3–5 frames.

## 3. UI chrome (the dock/drawer system)

All logical px — **author at 2×** (e.g. the 340-wide drawer skin is a
680-wide PNG).

| Element | Logical size | Notes |
|---|---|---|
| Drawer panel | **340 wide × full-screen-height** | Height varies per monitor (≈1032 on 1080p, ≈1416 on 2K). **Must be a 9-slice**: fixed 16 px rounded corners, stretchable middle. Don't paint one fixed-height picture |
| Dock tab (house button) | **46 × 46**, rounded 14 px on the outer side | Fused to drawer edge with 12 px concave fillets — if you draw a custom tab, include the fillet curves |
| Icon inside tab | 26 × 26 | |
| Drawer header nav buttons | 26 × 26 | home/quests/achievements/ranks/settings/close |
| Radial menu buttons (on pet) | **40 × 40 circles** | pet / sleep / evolve etc. |
| Cooldown ring (around radial button) | 50 × 50 (ring radius 22, 3 px stroke) | drawn by code today; skinnable later |
| Stat bars | 304 wide × 9 tall, radius 5 | 9-slice or code-drawn; icons beside them are text-size (~13 px) |
| Buttons/chips in drawer | height 26–30, radius 7 | 9-slice |
| Item boxes (kitchen slots) | ~96 × 78, radius 10 | food pile / ball / sponge slots |

## 4. Interactive items (currently emoji placeholders — all need art)

| Item | Logical size | Author at |
|---|---|---|
| Food piece (in pile & thrown) | 40 × 40 | 80–160 |
| Ball | 34 × 34 | 68–136 (gets zoomed 16× in the throw-back flourish → author this one at **512** if possible) |
| Sponge (cursor during wash) | 32 × 32 | 64–128 |
| Bubbles (wash particles) | 10–28 (random) | one 56 px bubble, code scales it |
| Warmth flame (egg hold) | 26 | 52–104 |
| Status blips (❗ etc.) | 18 | 36–72 |
| Stat-popup icons (+40 🍖 row) | 14 | 28–56 |

## 5. Existing reference assets

`apps/desktop/src/assets/widget/` already holds the QA-hub MVP set (house,
settings, sync icons) in the chunky wood/leather game-icon style — treat
those as the interim style reference until the new art direction lands.
Concept direction from the Miro board: chibi blob pets, 3 stages, accessory
hats (phoenix "Blaze", black cat "Midnight").

## 6. Delivery checklist

- [ ] PNG-32, transparent, no color profile weirdness (sRGB)
- [ ] Sprite sheets grid-aligned, consistent cell size per sheet, no bleed
      between cells
- [ ] One file per pet per stage (e.g. `cat_baby_sheet.png`), plus a tiny
      `*.json` or text note with: cell size, rows→animation mapping, frame
      counts, FPS suggestion
- [ ] UI pieces as individual files named by element
      (`drawer_9slice.png`, `tab_house.png`, `btn_radial.png`, …)
- [ ] Everything at 2× logical size (pets & ball at 4×), even dimensions
