# Gemini prompts — release banner images

Release headers follow one pattern: a **themed banner image** (full-bleed header) whose carved sign
shows the highlighted tool's **Skyrim name + tagline**, plus a matching release **title** (same name +
tagline, or a size-appropriate shorter version). Images are **Gemini's job** (four-brain: Gemini owns
creative/imagery); these are the paste-ready prompts. Style reference: the v0.5.0 **Forge** banner —
dark Nordic fantasy, carved wooden sign on iron chains, warm dramatic light, photorealistic-cinematic,
wide **2816×1536**.

When a banner comes back: archive the prior one as `-v1` (+ `-v1-original`), save the new full-res as
`assets/release-vX.Y.Z-banner-original.png`, then run:

```
node scripts/compress-image.js assets/release-vX.Y.Z-banner-original.png
```

That auto-emits the canonical `assets/release-vX.Y.Z-banner.png` (drops the `-original` suffix),
resized to **1280px** wide and losslessly compressed to ~1.5–1.8 MB — matching every other banner.
(`--width N` overrides; an explicit second arg overrides the output path.) Commit those asset paths,
push. Title via `gh release edit`.

## v0.4.0 — The Augur (Missing Masters) 🔮

Sign tagline (matches title): **"A missing master, caught before launch."**
Fuller theme tagline (if a subtitle is wanted): *Reveals a missing master before you launch — no more
sudden crash to desktop.*

```
A dark, moody Skyrim-style Nordic fantasy scene, photorealistic and cinematic, wide banner composition (2816x1536). A hooded seer stands before a glowing arcane orb in a shadowy stone chamber of an ancient mage's college; ethereal blue-white light rises from the orb revealing faint floating runes and a ghostly premonition. Warm candlelight and cold arcane glow mix dramatically. At the top, a large carved weathered wooden sign hangs by iron chains, with ornate Nordic knotwork carving, reading in bold engraved fantasy-serif lettering: "THE AUGUR" and beneath it in smaller engraved text: "A missing master, caught before launch." Rich detail, atmospheric depth, dramatic rim lighting.
```

## v0.3.0 — The Scribe (Rules Generator) ✒️

Sign tagline (matches title): **"Your load-order rules, carried across."**
Fuller theme tagline: *Transcribes your proven load-order rules into the updated collection, so you
never resolve the same conflicts twice.*

```
A dark, moody Skyrim-style Nordic fantasy scene, photorealistic and cinematic, wide banner composition (2816x1536). An old robed scholar sits at a heavy wooden desk in a candlelit ancient library, carefully copying glowing golden runes from a worn open scroll into a fresh leather-bound tome with a quill; shelves of tomes recede into warm shadow behind him. Faint magical light trails from the old scroll to the new book, suggesting knowledge carried across. At the top, a large carved weathered wooden sign hangs by iron chains, with ornate Nordic knotwork carving, reading in bold engraved fantasy-serif lettering: "THE SCRIBE" and beneath it in smaller engraved text: "Your load-order rules, carried across." Rich detail, atmospheric depth, dramatic rim lighting.
```

## v0.6.0 — The Vault-Keeper (Rebuild Missing Files) 🗝️

Flagship of the two features in this release (Workshop Report is the other — goes in the "What's
new" body only, per convention; no banner of its own).

Sign tagline (matches title): **"Only what's missing, restored."**
Fuller theme tagline (if a subtitle is wanted): *Checks a collection against what it's supposed to
have, then restores only the pieces that are actually gone — no need to empty the whole vault to
replace one relic.*

```
A dark, moody Skyrim-style Nordic fantasy scene, photorealistic and cinematic, wide banner composition (2816x1536). Deep inside a torch-lit ancient Nordic vault, rows of stone alcoves line a curved stone wall, each holding a weathered relic on its own pedestal -- urns, carved idols, an enchanted blade -- all catalogued and complete except for one alcove near the center, where a faint golden outline glows on an empty pedestal, marking exactly what belongs there. An old armored vault-keeper in worn leather and fur reaches into a satchel and carefully sets a single glowing relic onto that one empty pedestal, completing the row; dust motes drift through shafts of warm torchlight, deep shadow everywhere else. At the top, a large carved weathered wooden sign hangs by iron chains, with ornate Nordic knotwork carving, reading in bold engraved fantasy-serif lettering: "THE VAULT-KEEPER" and beneath it in smaller engraved text: "Only what's missing, restored." Rich detail, atmospheric depth, dramatic rim lighting.
```

## v1.0.0 — The first great work, complete 🐉

Not a single-tool flagship like every release before it -- v1.0.0 covers the whole milestone (all 8
main/utility tools, the Skyrim theming system, the color/font pickers, The Arcaneum's own Get Started
book). Director's own ask for this one: something that reads as "we did something big" -- a
dragon-slain, victory-at-dawn scene instead of the usual moody workshop-in-progress framing every
other banner uses. Still the same carved-sign format and 2816x1536 composition for consistency, but
warmer/triumphant lighting instead of the series' usual dim workshop mood -- a deliberate one-off for
this milestone, not a new standing style.

Sign tagline (matches title): **"The first great work, complete."**
Fuller theme tagline (if a subtitle is wanted): *Every tool in The Arcaneum, forged, warded, and
catalogued -- v1.0.0 is here.*

```
A dramatic Skyrim-style Nordic fantasy scene, photorealistic and cinematic, wide banner composition (2816x1536). Dawn breaks over a windswept mountain ridge above an ancient stone college -- warm golden sunrise light instead of the usual deep shadow. A lone armored dragonborn stands triumphant, breathing steady, longsword still raised, before the fallen form of a massive dragon sprawled across broken stone at their feet, wisps of pale dragon-soul essence rising into the dawn sky and dissolving into light. Behind them, the many carved towers and stained-glass windows of an ancient mage's college (matching The Arcaneum's own library) catch the first sunlight. At the top, a large carved weathered wooden sign hangs by iron chains, with ornate Nordic knotwork carving, reading in bold engraved fantasy-serif lettering: "V1.0.0" and beneath it in smaller engraved text: "The first great work, complete." Rich detail, atmospheric depth, dramatic golden-hour rim lighting.
```

## Status
- **Done 2026-07-29:** v0.5.0 The Forge, v0.4.0 The Augur, v0.3.0 The Scribe — titles, themed banners
  (Gemini-generated, swapped + compressed to 1280px/~1.5 MB), and alt captions all live. Prior banners
  archived as `-v1` (+ `-v1-original`).
- **Pending:** v0.6.0 The Vault-Keeper (Rebuild Missing Files) — prompt above ready, banner not yet
  generated.
- **Done 2026-08-15:** v1.0.0 dragon-slain milestone banner — generated, compressed, and live at
  `assets/release-v1.0.0-banner.png`.
- v0.2.0 / v0.1.0: left as-is (per user).
