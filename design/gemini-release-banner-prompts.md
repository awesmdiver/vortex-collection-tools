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

## Status
- **Done 2026-07-29:** v0.5.0 The Forge, v0.4.0 The Augur, v0.3.0 The Scribe — titles, themed banners
  (Gemini-generated, swapped + compressed to 1280px/~1.5 MB), and alt captions all live. Prior banners
  archived as `-v1` (+ `-v1-original`).
- v0.2.0 / v0.1.0: left as-is (per user).
