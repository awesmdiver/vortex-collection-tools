# Gemini prompts — Get Started book, per-tool banners

Same style/size as the release banners (`design/gemini-release-banner-prompts.md`) — full-bleed
**2816×1536**, dark Nordic fantasy, carved wooden sign on iron chains, warm/cold dramatic light,
photorealistic-cinematic. This is the book page's own top image (see the mockup's The Forge sample,
`design/vortex-visual-flourishes-mockup.html`), not the shallow Home-divider strip
(`gemini-section-banner-prompts.md` uses that smaller size instead — different purpose).

## Already covered — reuse, don't regenerate

| Tool | Source |
| :-- | :-- |
| 📖 The Arcaneum (Home) | `assets/home-banner-arcaneum.png` (already the right size/style) |
| 🔨 The Forge (Merge Plugins) | `assets/release-v0.5.0-banner.png` |
| 🔮 The Augur (Missing Masters) | `assets/release-v0.4.0-banner.png` |
| ✒️ The Scribe (Rules Generator) | `assets/release-v0.3.0-banner.png` |
| 🗝️ The Vault-Keeper (Rebuild Missing Files) | `assets/release-v0.6.0-banner.png` |

## Still needed — 11 tools

Save each as `assets/book-banner-<slug>-original.png`, then
`node scripts/compress-image.js assets/book-banner-<slug>-original.png` (same flow as every other
banner in this project).

### Restoration (Rebuild Collection)
Tagline: **"Mends broken and corrupted files in seconds."**
```
A dark, moody Skyrim-style Nordic fantasy scene, photorealistic and cinematic, wide banner composition (2816x1536). A priest of Arkay kneels over a fallen traveler in a candlelit shrine, one hand raised, a warm golden light spilling from their palm and knitting the traveler's wounds closed in real time -- torn cloth and skin visibly mending under the glow. The traveler stirs, already rising. Soft warm light dominates near the priest, fading to cool shadow at the shrine's edges. At the top, a large carved weathered wooden sign hangs by iron chains, with ornate Nordic knotwork carving, reading in bold engraved fantasy-serif lettering: "RESTORATION" and beneath it in smaller engraved text: "Mends broken and corrupted files in seconds." Rich detail, atmospheric depth, dramatic rim lighting.
```

### The Ward (Update Collection)
Tagline: **"Shields your choices so an update can't wipe them out."**
```
A dark, moody Skyrim-style Nordic fantasy scene, photorealistic and cinematic, wide banner composition (2816x1536). A translucent blue-white magical barrier arcs protectively over a small stone alcove holding a few carefully arranged personal effects -- a folded cloak, a sealed letter, a single candle still burning -- while outside the ward's edge, wind-driven snow and debris streak past violently, visibly deflected around the dome. The protected items inside sit perfectly undisturbed, lit warm and steady against the chaos outside. At the top, a large carved weathered wooden sign hangs by iron chains, with ornate Nordic knotwork carving, reading in bold engraved fantasy-serif lettering: "THE WARD" and beneath it in smaller engraved text: "Shields your choices so an update can't wipe them out." Rich detail, atmospheric depth, dramatic rim lighting.
```

### The Ledger (Stats)
Tagline: **"Every rebuild's numbers, tallied over time."**
```
A dark, moody Skyrim-style Nordic fantasy scene, photorealistic and cinematic, wide banner composition (2816x1536). A merchant's heavy account book lies open on a cluttered trading-post desk, its pages dense with neat ink columns and tallied rows, a brass abacus and stacked coin-purses nearby; a quill rests mid-entry, the newest row still glistening wet. Warm lamplight pools directly on the open ledger, the rest of the cramped shop receding into soft shadow. At the top, a large carved weathered wooden sign hangs by iron chains, with ornate Nordic knotwork carving, reading in bold engraved fantasy-serif lettering: "THE LEDGER" and beneath it in smaller engraved text: "Every rebuild's numbers, tallied over time." Rich detail, atmospheric depth, dramatic rim lighting.
```

### The Quest Log (Work Through)
Tagline: **"Every problem left to knock out, in one checklist."**
```
A dark, moody Skyrim-style Nordic fantasy scene, photorealistic and cinematic, wide banner composition (2816x1536). A worn leather adventurer's journal lies open on a camp bedroll beside a low fire, its pages hand-annotated with a running list of tasks -- several lines struck through with a rough ink dash, one line circled and freshly underlined, a few still blank and waiting. A dagger pins one page flat against the wind. Warm firelight flickers across the journal, tent canvas and gear fading into cool blue shadow behind it. At the top, a large carved weathered wooden sign hangs by iron chains, with ornate Nordic knotwork carving, reading in bold engraved fantasy-serif lettering: "THE QUEST LOG" and beneath it in smaller engraved text: "Every problem left to knock out, in one checklist." Rich detail, atmospheric depth, dramatic rim lighting.
```

### Scroll of Retrospection (Update Compare)
Tagline: **"Holds what was beside what is."**
```
A dark, moody Skyrim-style Nordic fantasy scene, photorealistic and cinematic, wide banner composition (2816x1536). An ancient scroll unrolls across a stone table, glowing faintly gold -- its surface shows two overlapping translucent images at once, like a double-exposure: on one half a room as it once was, on the other the same room as it is now, subtly different (a missing tapestry, a moved chair), the two states bleeding into each other at the scroll's center crease. Soft ethereal light rises from the parchment itself, the surrounding stone chamber dim and reverent. At the top, a large carved weathered wooden sign hangs by iron chains, with ornate Nordic knotwork carving, reading in bold engraved fantasy-serif lettering: "SCROLL OF RETROSPECTION" and beneath it in smaller engraved text: "Holds what was beside what is." Rich detail, atmospheric depth, dramatic rim lighting.
```

### The Scribe's Ledger (Rules Generator Report)
Tagline: **"Which rules copied cleanly, and which still need a look."**
```
A dark, moody Skyrim-style Nordic fantasy scene, photorealistic and cinematic, wide banner composition (2816x1536). An elderly scholar in scribe's robes sits at a reading desk, one hand resting on a neat stack of completed, bound manuscripts glowing with a faint golden checkmark-like seal, the other hand hovering over a smaller separate pile of loose, unbound pages marked with a soft amber query-mark seal instead -- clearly two distinct piles, finished versus still-needing-review. Warm candlelight from an oil lamp, tall bookshelves fading into shadow behind. At the top, a large carved weathered wooden sign hangs by iron chains, with ornate Nordic knotwork carving, reading in bold engraved fantasy-serif lettering: "THE SCRIBE'S LEDGER" and beneath it in smaller engraved text: "Which rules copied cleanly, and which still need a look." Rich detail, atmospheric depth, dramatic rim lighting.
```

### The Anvil's Mark (Workshop Report)
Tagline: **"The real date you last set hand to your work."**
```
A dark, moody Skyrim-style Nordic fantasy scene, photorealistic and cinematic, wide banner composition (2816x1536). A blacksmith's anvil sits center-frame in a glowing forge, its scarred face catching the orange light -- a fresh maker's-mark has just been stamped into one corner, still faintly smoking, while a half-finished blade rests cooling nearby. Outside the forge's open doorway, a weathered wooden trade sign hangs untouched and dusty, clearly older and less relevant than the fresh mark on the anvil itself. Warm forge-glow dominates, the shop's edges fading to cool blue dusk. At the top, a large carved weathered wooden sign hangs by iron chains, with ornate Nordic knotwork carving, reading in bold engraved fantasy-serif lettering: "THE ANVIL'S MARK" and beneath it in smaller engraved text: "The real date you last set hand to your work." Rich detail, atmospheric depth, dramatic rim lighting.
```

### The Shadowmarked (Mod Exceptions)
Tagline: **"Marks what's meant to be left alone."**
```
A dark, moody Skyrim-style Nordic fantasy scene, photorealistic and cinematic, wide banner composition (2816x1536). A weathered wooden doorpost in a quiet cobblestone alley bears a faintly glowing shadowmark carved deep into the grain -- a simple angular symbol, softly luminous violet-blue against the dark wood. The door behind it is closed, undisturbed, moss creeping at its base untouched by foot traffic. Cool moonlight washes the alley, the shadowmark itself the only warm-toned light source. At the top, a large carved weathered wooden sign hangs by iron chains, with ornate Nordic knotwork carving, reading in bold engraved fantasy-serif lettering: "THE SHADOWMARKED" and beneath it in smaller engraved text: "Marks what's meant to be left alone." Rich detail, atmospheric depth, dramatic rim lighting.
```

### The Cleansing (Vortex Scrub)
Tagline: **"Purges the clutter left behind, reclaims the space."**
```
A dark, moody Skyrim-style Nordic fantasy scene, photorealistic and cinematic, wide banner composition (2816x1536). Inside a forgotten stone barrow, shafts of pure golden sunlight break through a collapsed ceiling, burning away drifting cobwebs and a thin haze of disturbed dust -- a faint wisp of translucent spectral vapor dissipates in the light's path. Where the light has passed, the stone floor is clean and clear; where it hasn't yet reached, clutter and rubble still linger in shadow. At the top, a large carved weathered wooden sign hangs by iron chains, with ornate Nordic knotwork carving, reading in bold engraved fantasy-serif lettering: "THE CLEANSING" and beneath it in smaller engraved text: "Purges the clutter left behind, reclaims the space." Rich detail, atmospheric depth, dramatic rim lighting.
```

### Clairvoyance (Archive Finder)
Tagline: **"Sees inside without opening a single thing."**
```
A dark, moody Skyrim-style Nordic fantasy scene, photorealistic and cinematic, wide banner composition (2816x1536). A shimmering trail of pale blue light -- the Clairvoyance spell's own guiding wisp -- drifts through a dim dungeon corridor and passes directly through a sealed, iron-banded chest without disturbing its lock, the chest's interior contents faintly visible in silhouette through the wood as the light passes over it. The corridor beyond fades into darkness; the spell trail is the only real light source. At the top, a large carved weathered wooden sign hangs by iron chains, with ornate Nordic knotwork carving, reading in bold engraved fantasy-serif lettering: "CLAIRVOYANCE" and beneath it in smaller engraved text: "Sees inside without opening a single thing." Rich detail, atmospheric depth, dramatic rim lighting.
```

### The Standing Stones (Settings)
Tagline: **"Choose once; every tool draws on it after."**
```
A dark, moody Skyrim-style Nordic fantasy scene, photorealistic and cinematic, wide banner composition (2816x1536). A single ancient Standing Stone monolith rises from windswept tundra under a twilight sky streaked with faint aurora, its carved runes glowing a soft steady blue-white -- a lone figure stands before it, arms slightly raised, a thin beam of light connecting the stone to the figure's chest. The surrounding landscape is vast, quiet, and dim, all attention drawn to the stone's own glow. At the top, a large carved weathered wooden sign hangs by iron chains, with ornate Nordic knotwork carving, reading in bold engraved fantasy-serif lettering: "THE STANDING STONES" and beneath it in smaller engraved text: "Choose once; every tool draws on it after." Rich detail, atmospheric depth, dramatic rim lighting.
```

## Status
- **All 16 done, 2026-08-15.** 5 reused from existing banners (see table above); the 11 new ones
  generated, compressed, and archived under `assets/book-banner-<slug>-original.jpeg` +
  `assets/book-banner-<slug>.png`. All 16 (11 new + 5 reused) copied into
  `web/public/theme-assets/skyrim/book/book-banner-<slug>.png` for the app to actually serve, ready
  for whenever the book's own page/route gets built.
