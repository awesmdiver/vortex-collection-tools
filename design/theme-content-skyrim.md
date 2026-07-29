# First game theme — Skyrim / "The Arcaneum"

The content for the first game theme, captured for **Phase 2 (theming framework)**. This is the source
the eventual `themes/skyrim.json` gets built from. See `DESIGN.md` "Brand theming framework" for how
themes work (data keyed by stable tool ID; behavior never changes).

**The flavor names below are the keepers** — the ones we landed on and liked. The **themed taglines are
a first draft** (they didn't exist before; polish them at build time with `plain-language-writer`).
Every tool keeps its **constant functional label** so a newcomer always knows what it does — *name for
flavor, label for function*.

App title (themed): **The Arcaneum** · accent: TBD at build (a Skyrim gold/parchment, `palette` left
empty in v1.0).

| Stable ID | Functional label (constant) | Skyrim name | Emoji | Draft themed tagline |
| :-- | :-- | :-- | :-- | :-- |
| `home` | Home | **The Arcaneum** | 📖 | Every tool in the collection, shelved and waiting. |
| `rebuild` | Rebuild Collection | **Restoration** | ✨ | Restore a broken collection to full health — fast, no repair-by-hand. |
| `update` | Update Collection | **The Ward** | 🛡️ | Update the collection without dropping the wards you set. |
| `rules` | Rules Generator | **The Scribe** | ✒️ | The Scribe copies your conflict rules across to the new collection, so you never resolve them twice. |
| `merge` | Merge Plugins | **The Forge** | 🔨 | Forge many plugins into one — reclaim the slots, keep the load order. |
| `missing-masters` | Missing Masters | **The Augur** | 🔮 | The Augur spots a missing master before it crashes your game. |
| `scrub` | Vortex Scrub | **The Cleansing** | 🔥 | Cleanse the staging clutter Vortex quietly left behind. |
| `archive-finder` | Archive Finder | **Clairvoyance** | 👁️ | See any file inside any archive — no unpacking, no digging. |
| `reports` | Reports | **The Chronicle** | 📜 | The Chronicle of every rebuild, update, and change. |
| `settings` | Settings | **The Standing Stones** *(new — proposal)* | 🗿 | Choose your paths and preferences once; every tool draws on them. |

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
  and change. *(record the history)*
- **The Standing Stones** *(settings proposal)* — you pick a passive blessing *once* and it shapes your
  whole playthrough. Settings: set your paths and preferences once; every tool draws on them.
  *(set once, affects everything)*

## Notes / open bits
- **The keepers** (from the original draft, the ones you liked): The Arcaneum, Restoration, The Ward,
  The Scribe, The Forge, The Augur, The Cleansing, Clairvoyance, The Chronicle.
- **New proposals to accept or swap:** `settings` → **The Standing Stones** (you set a passive once,
  like picking a Stone) — alternatives if you don't love it: *The Enchanter*, *Attunement*, *The
  Sanctum*. `reports` sub-tabs currently all live under **The Chronicle**; they can each get a flavor
  name later (e.g. Stats → *The Ledger*, Work Through → *The Quest Log*, Update Compare → *The
  Before-and-After*, Rules Report → *The Scribe's Ledger*) or just keep their functional names.
- **Emoji note:** `merge` is **🔨** in the Skyrim theme (The Forge) but **🧬** in the Plain theme
  (Merge Plugins) — the theme carries the emoji, so this is expected, not a conflict.
- Taglines above replace the Plain theme's hero copy per tool; the Plain functional lines stay as the
  fallback/default theme.
