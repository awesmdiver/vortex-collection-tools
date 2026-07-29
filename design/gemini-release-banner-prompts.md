# Gemini prompts — release banner images

Release headers follow one pattern: a **themed banner image** (full-bleed header) whose carved sign
shows the highlighted tool's **Skyrim name + tagline**, plus a matching release **title** (same name +
tagline, or a size-appropriate shorter version). Images are **Gemini's job** (four-brain: Gemini owns
creative/imagery); these are the paste-ready prompts. Style reference: the v0.5.0 **Forge** banner —
dark Nordic fantasy, carved wooden sign on iron chains, warm dramatic light, photorealistic-cinematic,
wide **2816×1536**.

When a banner comes back: archive the prior one as `-v1` (+ `-v1-original`), set the new full-res as
`release-vX.Y.Z-banner-original.png`, compress to the canonical `release-vX.Y.Z-banner.png`
(`scripts/compress-image.js`), commit those asset paths, push. Title via `gh release edit`.

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

## Status
- Titles updated live 2026-07-29 (v0.4.0 → The Augur, v0.3.0 → The Scribe).
- Banner images: **pending Gemini generation**, then swap per the flow above.
- v0.2.0 / v0.1.0: left as-is (per user).
