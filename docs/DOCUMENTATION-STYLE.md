# Documentation style — README & release notes

How the user-facing docs for this project should look and read, so the `README.md` and every
GitHub release feel like the same product as the app itself. This is the doc equivalent of
`DESIGN.md` (which governs the UI). Read it before writing or refreshing the README or drafting
release notes.

## Shared voice & theme (matches the app)

- **Voice:** the same as the app UI — the **`plain-language-writer`** skill, casual register.
  Warm, encouraging, plain language, natural contractions, benefit-first. **Load the skill before
  writing or editing any of this copy.** Switch to the serious register only for genuinely
  consequential notes (writing to Vortex's live database, backups, "close Vortex first"), exactly
  like in the app.
- **Emoji-led headings.** Every top-level section gets a contextual emoji that maps to its meaning
  (⚡ Overview, ✨ Key Features, 📦 Getting Started, ⚠️ Important Notes, ❓ FAQ, 🛠️ Technical,
  🤝 Credits) — the same "pick an emoji that fits the specific thing" rule as the app's
  `.tool-hero` titles. Sentence-case or short Title-case headings; don't shout.
- **Bold lead-ins on bullets.** Each feature/change bullet starts with a bold phrase naming the
  benefit, then a plain-language sentence or two: `- **Keeps your Ignored/Disabled choices:** …`.
- **GitHub-native alert blocks** for anything cautionary, mapped to the app's four severities:
  `> [!NOTE]` (info), `> [!TIP]` (helpful), `> [!WARNING]` (needs attention), `> [!CAUTION]`
  (data-safety / hard warning). Use these instead of inventing bold "Warning:" lines.
- **Em dashes:** use a real `—` (like the README), not `--`. GitHub doesn't convert `--`, so it
  renders as two hyphens. Keep README and release notes consistent on this. *(The older release
  notes used `--`; standardize new ones on `—`.)*
- **Technical detail stays out.** The README and release notes are user-facing. Build-from-source,
  CLI, internals, and "why this approach" all live in `TECHNICAL.md`; link to it, don't inline it.
- **Reassurance is a feature.** Lead with what's safe (never touches your saves; a full backup is
  taken first) — it's the same trust-building tone the app uses.

## README structure (the template)

Keep this order; it's the established shape. Fill each section, drop one only if it truly has no
content.

1. `# Vortex Collection Tools` — the title.
2. **Banner image** — `![Vortex Collection Tools](assets/readme-banner.png)`. The README may use a
   **relative** `assets/…` path (GitHub resolves it in-repo).
3. **One-line value blockquote** — `> **<the single most compelling promise>.**` One sentence, the
   whole point of the tool.
4. `---`
5. `## ⚡ Overview` — one paragraph: the problem at real scale, then what this does about it.
6. `### 📋 At a Glance` — a two-column table (**Requirements**, **Performance Impact**, **Safety**,
   **Compatibility**). Short value cells.
7. `## ✨ Key Features` — bulleted, bold lead-ins, benefit-first, one tool/idea per bullet.
8. `## 📦 Getting Started` — numbered steps (download → close Vortex → run `start-server.bat` →
   set paths), then how to stop it. A `> [!TIP]` for the bundled-runtime / `START HERE.txt` note.
9. `## ⚠️ Important Notes` — the alert blocks: what needs Vortex closed, the "External Changes"
   heads-up, the database-write caution.
10. `## ❓ Frequently Asked Questions` — `* **Q: …?**` then a `> **<bold answer lead>.** …`
    blockquote answer; separate each Q with a `---`.
11. `## 🛠️ Technical Details & Contributions` — one line pointing to `TECHNICAL.md`.
12. `## 🤝 Credits` — Vortex, Nexus API, anything else relied on.

Consider a **screenshot of the Home page** in the Overview now that there's a real landing page —
a single image sells the "your whole toolkit in one place" pitch fast.

## Release notes structure (the template)

One file per version at `github-releases/release-notes-vX.Y.Z.md`; its body is pasted into the
GitHub release. Keep these sections in order:

1. **Banner image** — `![<playful alt>](https://raw.githubusercontent.com/awesmdiver/vortex-collection-tools/master/assets/release-vX.Y.Z-banner.png)`.
   **Must be an absolute `raw.githubusercontent.com` URL** — a relative `assets/…` path does NOT
   render on the GitHub release page. The alt text doubles as the banner's caption/joke.
   **Banner prep — always two files, following the `readme-banner` / `release-v0.3.0-banner`
   convention:**
   - `assets/release-vX.Y.Z-banner-original.png` — the full-res source, kept as-is (exact bytes,
     never overwrite).
   - `assets/release-vX.Y.Z-banner.png` — the compressed copy that the release notes link to.
   - **Compression recipe:** resize to **1280 px wide** (preserve aspect), convert to RGB, save as
     an optimized PNG. Lands ~1.5–2.5 MB. Pillow one-liner:
     `Image.open(src).convert('RGB').resize((1280, round(h*1280/w)), Image.LANCZOS).save(dst, 'PNG', optimize=True)`.
   - **Who does it:** the design side handles banner prep (it has Python/Pillow and does the visual
     work) — see the one-owner-per-file / who-does-what note in the workflow guide. Don't hand a
     raw multi-MB original to the release; always ship the 1280px compressed one.
2. `## Vortex Collection Tools — vX.Y.Z` — title with the version.
3. **Intro paragraph** — a warm thanks + one or two sentences naming the release's headline
   ("adds a whole new area — **Utilities** — plus …"). Bold the marquee feature names.
4. `### Download and run — no installs needed` — the **standing** 4-step block (unzip → close
   Vortex → `start-server.bat` → set paths under Settings) + the `START HERE.txt` line. Keep this
   near-verbatim across releases; users rely on it being the same.
5. `### A couple of things worth knowing` — the standing safety bullets: Vortex must be closed;
   Update Collection / Rules Generator write to Vortex's database (backup taken first); the
   "External Changes" prompt is expected.
6. `### What's new since vX.Y.(Z-1)` — bulleted, bold lead-ins. **Order:** brand-new features first
   (prefix `**New: …**`), then improvements, then fixes. End with **"Confirmed working with Vortex
   <version>."** Describe each change by what it does *for the user*, not the implementation.
7. `### What we'd love feedback on` — while the app is in testing, targeted questions, ideally one
   per new feature ("does Vortex Scrub leave your real mods alone?").
8. **Closing** — "Open an issue with what you were doing, what you expected, and what actually
   happened (screenshots help a lot)." + a short thanks.

Tone check: it should read like a friendly changelog from someone who built it and wants your
feedback — never a dry corporate release note.

## Prompts

**Draft release notes for a new version** — paste into Claude Code from the repo root, filling the
blanks:

```
Write github-releases/release-notes-v<X.Y.Z>.md for the new release. Follow
docs/DOCUMENTATION-STYLE.md ("Release notes structure") and load the plain-language-writer
skill first. Base "What's new since v<PREV>" on the actual commits/changes since v<PREV>
(git log v<PREV>..HEAD) — describe each by what it does for the user, new features first
(prefix "New:"), then improvements, then fixes, ending with "Confirmed working with Vortex
<version>." Keep the standing "Download and run" and "A couple of things worth knowing" blocks
consistent with the previous release notes. Use a real — em dash, not --. Banner line: absolute
raw.githubusercontent.com URL to assets/release-v<X.Y.Z>-banner.png. Headline of this release:
<one line>.
```

**Review / refresh the README** — paste into Claude Code from the repo root:

```
Review and refresh README.md against docs/DOCUMENTATION-STYLE.md ("README structure") and load
the plain-language-writer skill first. Keep the established section order and voice. Make sure
Key Features, the At a Glance table, and the FAQ reflect the current app (including the new Home
landing page and the reorganized Settings). Flag — don't silently change — anything that's a
judgment call. Keep all technical detail in TECHNICAL.md. Use real — em dashes.
```
