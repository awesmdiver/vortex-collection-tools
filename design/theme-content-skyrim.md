# First game theme — Skyrim / "The Arcaneum"

The content for the first game theme, captured for **Phase 2 (theming framework)**. This is the source
the eventual `themes/skyrim.json` gets built from. See `DESIGN.md` "Brand theming framework" for how
themes work (data keyed by stable tool ID; behavior never changes).

**The flavor names are the keepers** — the ones we landed on and liked. The **themed taglines are a
first draft** (polish them at build time with `plain-language-writer`). Every tool keeps its **constant
functional label** so a newcomer always knows what it does — *name for flavor, label for function*.

App title (themed): **The Arcaneum** · accent: TBD at build (a Skyrim gold/parchment; `palette` left
empty in v1.0).

| Stable ID | Functional label (constant) | Skyrim name | Emoji | Draft themed tagline |
| :-- | :-- | :-- | :-- | :-- |
| `home` | Home | **The Arcaneum** | 📖 | Every tool in the collection, shelved and waiting. |
| `rebuild` | Rebuild Collection | **Restoration** | ✨ | Restore a broken collection to full health — fast, no repair-by-hand. |
| `update` | Update Collection | **The Ward** | 🛡️ | Update the collection without dropping the wards you set. |
| `rules` | Rules Generator | **The Scribe** | ✒️ | The Scribe copies your conflict rules across, so you never resolve them twice. |
| `merge` | Merge Plugins | **The Forge** | 🔨 | Forge many plugins into one — reclaim the slots, keep the load order. |
| `missing-masters` | Missing Masters | **The Augur** | 🔮 | The Augur spots a missing master before it crashes your game. |
| `scrub` | Vortex Scrub | **The Cleansing** | 🔥 | Cleanse the staging clutter Vortex quietly left behind. |
| `archive-finder` | Archive Finder | **Clairvoyance** | 👁️ | See any file inside any archive — no unpacking, no digging. |
| `reports` | Reports | **The Chronicle** | 📜 | The chronicle of every rebuild, update, and change. |
| ↳ `report-stats` | Stats | **The Ledger** | 📊 | Every rebuild's numbers, tallied over time. |
| ↳ `report-workthrough` | Work Through | **The Quest Log** | ✅ | Every problem mod left to knock out, in one checklist. |
| ↳ `report-compare` | Update Compare | **The Before-and-After** | 🔍 | Exactly what the update changed — kept, added, removed. |
| ↳ `report-rules` | Rules Generator Report | **The Scribe's Ledger** | 📋 | Which rules are copied over, and which still need a look. |
| `settings` | Settings | **The Standing Stones** | 🗿 | Choose your paths and preferences once; every tool draws on them. |

## Why these names (Skyrim lore → tool function)

The naming principle — and the rule for naming any *future* tool consistently: **pick a Skyrim term
whose in-world meaning maps to what the tool actually does.** That's why they land as right rather than
decorative.

- **The Arcaneum** — the College of Winterhold's great library, where every tome is collected. Home is
  the library where all your tools live. *(a launcher = a library)*
- **Restoration** — the school of *healing/mending* magic. Rebuild mends a broken collection back to
  full health, re-extracting missing/corrupted files. *(heal the broken)*
- **The Ward** — a Restoration spell that *shields/protects*. Update protects the Ignored/Disabled
  choices you set (your "wards") so they survive the update. *(protect what you set)*
- **The Scribe** — one who *copies/transcribes*. Rules Generator copies your conflict rules from the
  old collection to the new one. *(transcribe the rules across)*
- **The Forge** — where raw materials are *fused into one* item (smithing). Merge forges many plugins
  into a single file. *(many into one)*
- **The Augur** — the Augur of Dunlain *foresees/divines*. Missing Masters foresees a missing-master
  crash before it happens. *(see the problem coming)*
- **The Cleansing** — purging corruption/clutter from a place. Vortex Scrub clears the staging clutter
  and dead leftovers Vortex left behind. *(purge the clutter)*
- **Clairvoyance** — the Illusion spell that *reveals what's hidden* / lights the path. Archive Finder
  reveals what's inside any archive without opening it. *(see the hidden)*
- **The Chronicle** — a *record of events over time*. Reports are the history of every rebuild, update,
  and change. Its sub-reports are entries in the Chronicle:
  - **The Ledger** (Stats) — a ledger *tallies numbers over time*; Stats is the running count/history
    of every rebuild. *(record the tallies)*
  - **The Quest Log** (Work Through) — a quest log *lists what's left to do*; Work Through is the
    checklist of problem mods to knock out. *(your to-do list)*
  - **The Before-and-After** (Update Compare) — plainly *what changed* after the update (kept / added /
    removed). *(the diff)* — alt if you want more lore: *The Reckoning* (an accounting of what happened).
  - **The Scribe's Ledger** (Rules Generator Report) — the **Scribe's** own record of which rules got
    copied and which still need a look. *(the Scribe's record)*
- **The Standing Stones** — in Skyrim you pick a Standing Stone's passive blessing *once* and it shapes
  your whole playthrough. Settings: set your paths and preferences once; every tool draws on them.
  *(set once, affects everything)*

## Notes
- **Emoji:** `merge` is **🔨** here (The Forge) but **🧬** in the Plain theme (Merge Plugins) — the
  theme carries the emoji, so this is expected, not a conflict.
- These themed names + taglines override the Plain theme's hero copy per tool; the Plain functional
  lines stay as the fallback/default theme.
- Only loose end: whether Update Compare stays **The Before-and-After** or becomes **The Reckoning** —
  everything else is settled.
