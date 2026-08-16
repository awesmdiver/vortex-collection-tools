# Gemini prompts — Home banner images (Skyrim theme)

Home groups its cards into three sections (Main tools / Reports / Utilities), sitting below its own
welcome banner (The Arcaneum). Director's ask (2026-08-15, reviewing Phase 2 theming): a themed
banner image at the top of Home, plus one separating each section below it — same Gemini-illustrated
approach as the release banners (`design/gemini-release-banner-prompts.md`), not a plain CSS divider.

**Two different sizes, on purpose.** The Arcaneum banner is Home's own front door — it gets the
**same full-bleed hero treatment as a release banner** (2816×1536), the most prominent image in the
app. The three section dividers below it are a **shallow wide strip** (2560×440) — Home's card grid
is capped ~1280px centered, and a second full hero per section would shove the actual tool cards
halfway down the page. Same carved-sign Nordic-fantasy style throughout for visual family
consistency; only the composition height changes.

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
`assets/home-banner-<slug>-original.png`, run
`node scripts/compress-image.js assets/home-banner-<slug>-original.png` (emits the compressed
`assets/home-banner-<slug>.png`). Wiring these into the actual Home page (an image slot above Home's
own tool-hero for The Arcaneum, plus a new `sections` map in `themes/skyrim.json` for the three
dividers) is a follow-up once real images exist — not part of this prompt-spec pass.

## The Arcaneum (Home, top-of-page hero)

Already-locked name (`theme-content-skyrim.md`) — the College of Winterhold's own great library,
where every tome (tool) is shelved and waiting.

Tagline: **"Every tool in the collection, shelved and waiting."**

```
A dark, moody Skyrim-style Nordic fantasy scene, photorealistic and cinematic, wide banner composition (2816x1536). The great arcane library of a mage's college -- towering shelves of ancient tomes curve away into shadow on either side, connected by iron-railed balconies and narrow ladders; at the center, a wide reading table sits beneath a shaft of soft light from a high stained-glass window, a handful of open books and scrolls laid out as if just set down, each glowing faintly with its own small magical light -- one with a warm forge-orange glow, one a cool ward-blue, one trailing golden script. Dust motes drift through the light; the rest of the vast room recedes into warm candlelit shadow. At the top, a large carved weathered wooden sign hangs by iron chains from the balcony above, with ornate Nordic knotwork carving, reading in bold engraved fantasy-serif lettering: "THE ARCANEUM" and beneath it in smaller engraved text: "Every tool in the collection, shelved and waiting." Rich detail, atmospheric depth, dramatic rim lighting.
```

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
- **Pending:** all four — prompts ready, no banners generated yet. "The Rites"/"The Satchel" also
  need their names confirmed (not yet run through a four-brain pass) before any banner referencing
  them gets treated as locked. The Arcaneum's own name is already locked, only the banner image
  itself is new.
