# First game theme — Skyrim / "The Arcaneum"

The content for the first game theme, captured for **Phase 2 (theming framework)**. This is the source
`themes/skyrim.json` gets built from. See `DESIGN.md` "Brand theming framework" for how themes work
(data keyed by stable tool ID; behavior never changes).

**Names are locked** — confirmed by a four-brain pass (the user, this design side, terminal, and a
Gemini round that *independently* landed on the same top picks; its full option list is saved in
`design/gemini-skyrim-tool-names-taglines.md`). **Taglines are a strong draft** (best-of-both from
that pass) — give them a final `plain-language-writer` polish at build time. Every tool keeps its
**constant functional label** — *name for flavor, label for function*.

**Updated 2026-08-15** for three tools shipped since the original four-brain pass — `missing-files`,
`report-workshop`, `report-exceptions`. `missing-files` reuses **The Vault-Keeper**, already locked
and Gemini-illustrated for the v0.6.0 release banner — not a fresh draft. The other two
(**The Artisan's Log**, **The Sanctuary**) are first-pass names only, same naming principle applied
(a Skyrim term whose in-world meaning maps to the tool's real function) but **not yet run through
the same four-brain confirmation** the original 13 got — treat as draft until that happens.

App title (themed): **The Arcaneum** · accent: TBD at build (Skyrim gold/parchment; `palette` empty in v1.0).

| Stable ID | Functional label (constant) | Skyrim name | Emoji | Tagline (draft) |
| :-- | :-- | :-- | :-- | :-- |
| `home` | Home | **The Arcaneum** | 📖 | Every tool in the collection, shelved and waiting. |
| `rebuild` | Rebuild Collection | **Restoration** | ✨ | Mends broken and corrupted files in seconds — skip the slow journey of a full reinstall. |
| `update` | Update Collection | **The Ward** | 🛡️ | Shields your Ignored and Disabled choices so an update can't wipe out your setup. |
| `rules` | Rules Generator | **The Scribe** | ✒️ | Transcribes your proven load-order rules into the updated collection, so you never resolve the same conflicts twice. |
| `merge` | Merge Plugins | **The Forge** | 🔨 | Forge many plugins into one — reclaim load-order slots and stay clear of the 254-plugin limit. |
| `missing-masters` | Missing Masters | **The Augur** | 🔮 | Reveals a missing master before you launch — no more sudden crash to desktop. |
| `scrub` | Vortex Scrub | **The Cleansing** | 🔥 | Cleanse the orphaned downloads and abandoned staging folders Vortex left behind, and reclaim the disk space. |
| `archive-finder` | Archive Finder | **Clairvoyance** | 👁️ | Sees straight through any archive to the exact file you need — without unpacking a single byte. |
| `missing-files` | Rebuild Missing Files | **The Vault-Keeper** | 🗝️ | Only what's missing, restored — no need to empty the whole vault to replace one relic. |
| `reports` | Reports | **The Chronicle** | 📜 | The chronicle of every rebuild, update, and change. |
| ↳ `report-stats` | Stats | **The Ledger** | 📊 | Every rebuild's numbers, tallied over time. |
| ↳ `report-workthrough` | Work Through | **The Quest Log** | ✅ | Every problem mod left to knock out, in one checklist. |
| ↳ `report-compare` | Update Compare | **Scroll of Retrospection** | 🔍 | Holds your previous setup beside the new one — exactly what was kept, added, or removed. |
| ↳ `report-rules` | Rules Generator Report | **The Scribe's Ledger** | 📋 | Which rules copied over cleanly, and which still need a look. |
| ↳ `report-workshop` | Workshop Report | **The Artisan's Log** | 📓 | The real date you last set hand to an unfinished work — not Nexus's frozen one. |
| ↳ `report-exceptions` | Mod Exceptions | **The Sanctuary** | 🕊️ | Marks the mods you handle yourself — left untouched, wherever they turn up. |
| `settings` | Settings | **The Standing Stones** | 🗿 | Choose your paths and preferences once; every tool draws on them. |

## Why these names (Skyrim lore → tool function)

The naming principle — and the rule for naming any *future* tool: **pick a Skyrim term whose in-world
meaning maps to what the tool actually does.** That's why they land as right rather than decorative.

- **The Arcaneum** — the College of Winterhold's great library, where every tome is collected. Home is
  the library where all your tools live. *(a launcher = a library)*
- **Restoration** — the school of *healing/mending* magic. Rebuild mends a broken collection back to
  full health. *(heal the broken)*
- **The Ward** — a Restoration spell that *shields/protects*. Update protects the Ignored/Disabled
  choices you set (your "wards") through the update. *(protect what you set)*
- **The Scribe** — one who *copies/transcribes*. Rules Generator copies your conflict rules to the new
  collection. *(transcribe the rules across)*
- **The Forge** — where raw materials are *fused into one* item. Merge forges many plugins into a
  single file. *(many into one)*
- **The Augur** — the Augur of Dunlain *foresees/divines*. Missing Masters foresees a missing-master
  crash before it happens. *(see the problem coming)*
- **The Cleansing** — purging corruption/clutter from a place (cf. "The Cleansing of the Stones").
  Vortex Scrub clears the dead leftovers Vortex left behind. *(purge the clutter)*
- **Clairvoyance** — the Illusion spell that *reveals what's hidden* / lights the path. Archive Finder
  reveals what's inside any archive without opening it. *(see the hidden)*
- **The Chronicle** — a *record of events over time*. Reports are the history of every rebuild, update,
  and change. Its sub-reports are entries in the Chronicle:
  - **The Ledger** (Stats) — a ledger *tallies numbers over time*. *(record the tallies)*
  - **The Quest Log** (Work Through) — *lists what's left to do*. *(your to-do list)*
  - **Scroll of Retrospection** (Update Compare) — an **Elder Scroll** reveals past, present, and
    future at once; a compare report literally holds what-was beside what-is. The franchise's namesake
    artifact doing exactly this tool's job — and "retrospection" reads as *looking back* with zero lore
    needed. *(see across time)*
  - **The Scribe's Ledger** (Rules Generator Report) — the Scribe's own record of which rules copied
    and which need a look. *(the Scribe's record)*
- **The Standing Stones** — in Skyrim you pick a Standing Stone's blessing *once* and it shapes your
  whole playthrough. Settings: set your paths and preferences once; every tool draws on them.
  *(set once, affects everything)*
- **The Vault-Keeper** — a Nordic vault's keeper retrieves exactly the one missing relic, not the
  whole hoard. Rebuild Missing Files restores only what's actually gone, no full rebuild needed.
  *(only the missing piece)* — already locked and illustrated (v0.6.0 release banner,
  `design/gemini-release-banner-prompts.md`); carried over here as-is, not re-drafted.
- **The Artisan's Log** — a workshop's own real record of when work was last done, not a stale
  public notice. Workshop Report surfaces the genuine last-touched date from a collection's own
  revision history, not Nexus's frozen listing date. *(the real date, not the posted one)*
- **The Sanctuary** — a place explicitly set apart, left undisturbed. Mod Exceptions marks mods
  that need a human hand, not an automated fix — protected from auto-rebuild wherever they show up.
  *(set apart, left alone)*

## Notes
- **Emoji:** `merge` is **🔨** here (The Forge) but **🧬** in the Plain theme (Merge Plugins) — the
  theme carries the emoji, so this is expected.
- These themed names + taglines override the Plain theme's hero copy per tool; the Plain functional
  lines stay as the fallback/default theme.
- **Fun runner-up names worth remembering** (from the Gemini pass, if any pick ever needs a swap):
  Rebuild → *Fast Travel*; Update → *Unrelenting Force*; Scrub → *Banish*; Work Through → *Bounty
  Board*; Update Compare → *Mirror of Galathil*. All strong; the locked picks just edged them.
