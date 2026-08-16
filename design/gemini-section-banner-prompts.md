# Gemini prompts — Home section banner images (Skyrim theme)

Home groups its cards into three sections (Main tools / Reports / Utilities). Director's ask
(2026-08-15, reviewing Phase 2 theming): a themed banner image separating each section, same
Gemini-illustrated approach as the release banners (`design/gemini-release-banner-prompts.md`) — not
a plain CSS divider.

**These are a shallow wide STRIP, not a full-bleed hero** like the release banners. Home's card grid
is capped ~1280px centered — propose **2560×440** (roughly the same wide-banner language, much
shorter), so it reads as a divider between card groups, not a dominating header. Same carved-sign
Nordic-fantasy style as the release banners for visual family consistency, just a lower, thinner
composition since it has to sit between rows of cards without shoving them down the page.

**Section names — two of three still need a real four-brain pass.** Only "Reports" was ever
drafted/reasoned (`design/theme-content-skyrim.md`'s "why these names" section). "Main tools" and
"Utilities" have no group-level theme name anywhere yet (DESIGN.md flags this as a known gap). The
names below are a first-pass proposal only, same naming principle as every tool name (pick a Skyrim
term whose in-world meaning maps to what the group actually is) — **flag before locking, don't just
run with them:**

- **The Rites** (Main tools: Restoration, The Ward, The Scribe, The Forge) — these four are the
  primary, most-practiced workings you'd actually perform in The Arcaneum, not incidental errands.
  *(the core practices)*
- **The Chronicle** (Reports) — already locked, see `theme-content-skyrim.md`. *(the record of every
  rebuild, update, and change)*
- **The Satchel** (Utilities: The Augur, The Cleansing, Clairvoyance, The Vault-Keeper) — the
  secondary instruments an adventurer carries alongside their main craft, not shelved in the library
  itself but always on hand. *(what you carry with you)*

When a banner comes back: same flow as the release banners — save full-res as
`assets/section-banner-<slug>-original.png`, run
`node scripts/compress-image.js assets/section-banner-<slug>-original.png` (emits the compressed
`assets/section-banner-<slug>.png`, ~1280px wide). Wiring these into the actual Home page (a new
`sections` map in `themes/skyrim.json`, a banner element between each `.home-section`'s heading and
its card grid) is a follow-up once real images exist — not part of this prompt-spec pass.

## The Rites (Main tools)

Tagline: **"The core workings, ready to cast."**

```
A dark, moody Skyrim-style Nordic fantasy scene, photorealistic and cinematic, wide shallow banner composition (2560x440). A stone archway opens onto a mage's workroom glimpsed from a library corridor -- within, faint overlapping glows hint at parallel workings: a warm forge-glow to one side, a cool ward-shimmer of protective magic in the middle, a soft restorative light pulsing over a workbench, a quill trailing a thin line of golden script through the air. No single subject dominates; the eye reads it as one room holding several ongoing practices at once. At the center, a modest carved wooden sign hangs from the archway's keystone by a short iron chain, reading in bold engraved fantasy-serif lettering: "THE RITES" and beneath it in smaller engraved text: "The core workings, ready to cast." Rich detail, atmospheric depth, dramatic rim lighting, low horizontal composition.
```

## The Chronicle (Reports)

Tagline: **"The record of every rebuild, update, and change."**

```
A dark, moody Skyrim-style Nordic fantasy scene, photorealistic and cinematic, wide shallow banner composition (2560x440). A long library table stretches across the frame, stacked with open ledgers, scrolls, and a leather-bound chronicle catching candlelight -- one ledger lies open mid-page, quill resting beside it, ink still wet on a fresh entry; faint ghostly afterimages of earlier entries seem to shimmer on the older pages behind it, suggesting a record that keeps itself updated. Warm candlelight pools across the table, fading to soft shadow at the frame's edges. At the center, a modest carved wooden sign hangs above the table by a short iron chain, reading in bold engraved fantasy-serif lettering: "THE CHRONICLE" and beneath it in smaller engraved text: "The record of every rebuild, update, and change." Rich detail, atmospheric depth, dramatic rim lighting, low horizontal composition.
```

## The Satchel (Utilities)

Tagline: **"The instruments you carry, always on hand."**

```
A dark, moody Skyrim-style Nordic fantasy scene, photorealistic and cinematic, wide shallow banner composition (2560x440). A worn leather satchel rests open on a stone windowsill, its contents spilling gently into view: a small seer's orb glowing faint blue, a cleansing censer trailing thin smoke, a polished lens catching lamplight, and a single ornate vault-key on a leather cord -- each item distinct but clearly belonging to the same well-used kit, the leather scuffed from travel. Soft evening light through the window behind, warm lamplight from within the room. At the center, a modest carved wooden sign hangs from the window's stone lintel by a short iron chain, reading in bold engraved fantasy-serif lettering: "THE SATCHEL" and beneath it in smaller engraved text: "The instruments you carry, always on hand." Rich detail, atmospheric depth, dramatic rim lighting, low horizontal composition.
```

## Status
- **Pending:** all three — prompts ready, no banners generated yet. "The Rites"/"The Satchel" also
  need their names confirmed (not yet run through a four-brain pass) before any banner referencing
  them gets treated as locked.
