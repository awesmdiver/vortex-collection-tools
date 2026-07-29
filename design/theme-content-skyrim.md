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
