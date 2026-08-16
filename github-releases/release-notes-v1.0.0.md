![V1.0.0 — The first great work, complete.](https://raw.githubusercontent.com/awesmdiver/vortex-collection-tools/master/assets/release-v1.0.0-banner.png)

## Vortex Collection Tools — v1.0.0

This is it — **v1.0.0**. Every core tool (Rebuild Collection, Update Collection, Rules Generator, Merge Plugins, and the Missing Masters / Mod Scrub / Archive Finder / Rebuild Missing Files utilities) is built, tested, and stable. And for this release, we had some fun: flip on the new **Skyrim theme** and the whole app transforms — every tool gets its own lore name, a matching color accent, and its own page in a brand-new **Get Started** book that walks you through what everything actually does. Thanks for sticking with this through six pre-releases to get here!

### Download and run — no installs needed

Grab **`VortexCollectionTools-v1.0.0-win-x64.zip`** below. It's a clean, self-contained run package — just the app itself plus its own bundled copy of Node.js and 7-Zip, nothing else to install:

1. Unzip it anywhere.
2. Close Vortex.
3. Double-click `start-server.bat`.
4. Your browser opens to the app automatically. First time through, it'll ask you to set your staging/downloads folders under **Settings** — do that once and you're good to go.

Full instructions are in `START HERE.txt` inside the zip.

### A couple of things worth knowing

- **This app is really built with Nexus Premium in mind.** Most tools work fine either way, but a few features — automatically downloading a missing archive, pulling a Workshop collection's file list from Nexus — need Premium, the same rule Nexus applies to free accounts. You'll get a clear note wherever that's the case, with a way to grab the file yourself instead.
- **Vortex needs to be fully closed** before running any tool that reads or writes its database — a rebuild or update, Rules Generator's **Apply to Vortex** step, Mod Scrub's scan, Missing Masters' **Rebuild This Mod**, and Merge Plugins. The app tells you right there if it's still open.
- **Now tested through Vortex 2.5.0.**

### 🎨 New: make it yours

- **A full Skyrim theme for the whole app.** One switch in Settings, and every tool gets a lore name and icon to match — Rebuild Collection becomes **Restoration**, Update Collection becomes **The Ward**, Merge Plugins becomes **The Forge**, and so on, with a matching purple accent throughout. Switch back to the plain theme any time — nothing about how the tools actually work changes either way.
- **Your own accent and background tint.** Not sold on the theme's default color? Override just the accent, just the background tint, or both, right from Settings. Your pick sticks per theme.
- **Six Skyrim-style fonts.** Cinzel by default, or pick from five other Skyrim-flavored fonts for the theme's own headings and lore text.
- **The Arcaneum — a real Get Started book.** A story-flavored tour of every tool, one chapter each, with its own banner art and a plain "what it actually does" section underneath the lore. Reachable from the book icon in the header, or right from the Home page.

### 🐛 Fixed / polished since v0.6.0

- **Renamed Vortex Scrub → Mod Scrub** — it's the mods themselves getting scrubbed, not Vortex.
- **Cleaned up the release package.** The downloadable zip now ships only what's actually needed to run the app — no build scripts, no source docs, no dev-only files. Smaller, tidier, and every JSON settings file an install creates lives in its own `config/` folder instead of scattered at the top level.
- Multi-select filter badges across every results list app-wide (Missing Masters, Rebuild Missing Files, Rules Generator, Stats, Rebuild Collection), and a sticky pick-tracking cart bar on Rebuild Missing Files, matching The Forge's own.
- Stronger, clearer warnings on Rebuild Collection and Rebuild Missing Files about keeping Nexus collections up to date before restoring from them.
- Various small copy, spacing, and consistency polish throughout.

### What we'd love feedback on

- **The Skyrim theme overall** — does it feel fun without getting in the way of actually using the tools? Anything that reads oddly once themed?
- **The Get Started book** — is it actually useful for getting oriented, or just a nice-to-have?

Open an issue with what you were doing, what you expected, and what actually happened (screenshots help a lot). Thanks for helping get this to 1.0!
