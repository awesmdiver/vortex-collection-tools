# Get Started book — content draft v1 (lore + "what it actually does", all 16 tools)

First-pass writing for the Skyrim-themed "Get Started" book (`design/vortex-visual-flourishes-mockup.html`'s
approved sample page, The Forge, is the calibration point for both voice and length — everything
below matches its shape).

**Two different passes, per the director's own split (2026-08-15):**
- **Lore** paragraphs are what go to Gemini next, as a third brain — same real four-brain process the
  original 13 tool names went through (`design/gemini-skyrim-tool-names-taglines.md`). Treat every
  lore paragraph below as a first draft to hand over, not a final. The seed reasoning for each is
  already locked in `design/theme-content-skyrim.md`'s own "why these names" section — these expand
  that one-liner into a full paragraph, same shape as The Forge's own sample.
- **"What it actually does"** boxes are plain-language-writer voice already (casual register, per the
  skill) — no Gemini pass needed, these are considered a real first draft ready for review/use as-is.

Two tools (**The Artisan's Log**, **The Sanctuary**) still have first-pass *names* too, not just
lore — flagged again below, in case Gemini's own read suggests a different name entirely, not just
better lore for the current one.

---

## 📖 The Arcaneum (Home)

**Lore:** The College of Winterhold keeps one room where every tome, no matter the school of magic it
belongs to, sits on the same shelves — restoration beside destruction, illusion beside conjuration.
You don't need to know which section you want; you just need to know the room exists, and that
whatever you're looking for is already in it. That's The Arcaneum's whole job: it doesn't do anything
itself, it just holds everything else and points you toward it.

**What it actually does:** Your home base — pick a tool, jump right in. Every card here is one click
from whatever you actually came to do: rebuild a collection, keep your Ignored/Disabled mods safe
through an update, copy conflict rules across, or check in on a report. Nothing happens on this page
itself; it's the map, not the destination.

---

## 🔨 The Forge (Merge Plugins)

**Lore:** Where raw materials are fused into one — a forge doesn't create from nothing, it takes what
already exists and combines it into something stronger. That's the whole idea behind this tool: your
plugins already exist, already work, already have their own records. The Forge doesn't rewrite any of
that — it just fuses several of them into a single file, so they take up one load-order slot instead
of many.

**What it actually does:** Pick plugins from one or more collections, review exactly what's going into
the merge (which records, whether anything needs a master, whether it overrides another mod's own
changes), then merge them into a single new .esp. If the result stays under Skyrim's 4,096-record
light-plugin limit and doesn't touch any cell/worldspace records, it gets flagged as an ESL
automatically — zero load-order cost. Nothing about your original plugins changes; the merge is a new
file, backed by the xelib engine Wrye Bash/xEdit both use under the hood.

---

## ✨ Restoration (Rebuild Collection)

**Lore:** Restoration magic doesn't summon anything new or fight anything off — it mends what's
already there back to full health, and it does it fast. A healer doesn't rebuild a body from nothing;
they close the wound and let what was already whole be whole again. That's exactly what this tool
does to a collection: nothing about it was fundamentally broken, it just needs its files back in place,
and Restoration puts them there in minutes instead of the long road of a full reinstall.

**What it actually does:** Skips Vortex's slow archive-install process entirely. Re-extracts an
already-installed collection's mods directly into your staging folder — same result as installing it
fresh, dramatically faster. Review exactly what would change before anything actually happens, then
let it run in the background while you do something else.

---

## 🛡️ The Ward (Update Collection)

**Lore:** A Ward doesn't stop the world from moving — it holds the line around one specific thing you
care about, so whatever comes through doesn't touch it. You can update a collection and let everything
else about it change; The Ward's whole purpose is making sure the one thing you deliberately set —
which mods you Ignored, which you Disabled — survives that update completely untouched.

**What it actually does:** Updating a collection in Vortex often resets your carefully-set Ignored and
Disabled mods back to their defaults. This tool remembers exactly how you had things set and restores
it right after the update, so that cleanup work never has to happen twice. Walks you through the steps
in order — you'll hop over to Vortex between some of them, and your place here is saved while you do.

---

## ✒️ The Scribe (Rules Generator)

**Lore:** A Scribe's whole trade is copying a text faithfully, word for word, so nothing is lost in the
retelling — not summarizing, not improving, just carrying it across exactly as it was. That's the
promise here: the load-order rules you already spent real time getting right in your old collection
aren't gone just because you updated. The Scribe transcribes them into the new copy, so the work you
already did stays done.

**What it actually does:** Matches mods between your old and new collections, then copies the conflict
rules you already set up straight across — so you're never stuck resolving the exact same load-order
conflict twice. Review every match before anything gets written to Vortex; nothing applies until you
say so.

---

## 📊 The Ledger (Stats)

**Lore:** A Ledger doesn't tell a story — it tallies. Every entry, every number, kept in one place over
time, so a glance tells you the whole trend without re-reading every page. This report is that ledger
for your rebuilds: not a play-by-play of any one run, just the running tally of how every collection
you've rebuilt has actually performed.

**What it actually does:** Tracks how every collection you've rebuilt has performed over time, and
instantly spots which mods still need attention right now. No more digging through individual run logs
one at a time to piece together the full picture.

---

## ✅ The Quest Log (Work Through)

**Lore:** A quest log doesn't care what school of magic solved the last quest — it just keeps every
open thread in one list, so nothing gets forgotten between one adventure and the next. This report is
exactly that: every problem mod across every collection, gathered into one place, so you're working
down a real list instead of hunting through scattered logs trying to remember what still needs doing.

**What it actually does:** Gathers every problem mod across every collection into one checklist. Fix
resolvable mismatches and missing archives right here; check off anything else as you handle it in
Vortex yourself. Your progress sticks around until a fresh rerun clears it.

---

## 🔍 Scroll of Retrospection (Update Compare)

**Lore:** An Elder Scroll is said to hold past, present, and future all at once — read it, and you see
what was alongside what is. That's precisely what this report does with an update: it holds your
collection's before and after side by side, so you're not left guessing what actually changed. No lore
needed to understand it either way — "retrospection" already means looking back.

**What it actually does:** After running an update with The Ward, get a clear before-and-after
comparison of your mods — what stayed, what got added, what got removed — so you're never left
guessing what an update actually did.

---

## 📋 The Scribe's Ledger (Rules Generator Report)

**Lore:** Even a Scribe keeps their own record of the work — which texts have been copied clean, and
which ones still need a second look before they're truly done. This report is that record for The
Scribe's own transcribing work: at a glance, what's finished and what's still waiting on a decision.

**What it actually does:** See at a glance which mods already have their conflict rules copied over
correctly, and which ones still need a decision or a second look in Vortex — all without re-running the
matching process itself.

---

## 📓 The Artisan's Log (Workshop Report) — draft name

**Lore:** A workshop's own log tells the truth about when the bench was last actually touched — not a
shopfront sign that hasn't been updated in months. Nexus shows a fixed date for a collection you're
authoring, one that doesn't move even as you keep working on it. This pulls the real one, straight from
the collection's own history — the artisan's own record, not the storefront's.

**What it actually does:** Nexus's own collection page shows a date that never moves for a private
collection — this pulls the real "last touched" timestamp from the collection's own revision history
instead, sortable newest-to-oldest, so you can spot at a glance which ones are overdue for an update.
Fetch a never-downloaded Workshop collection straight from here too.

---

## 🕊️ The Sanctuary (Mod Exceptions) — draft name

**Lore:** A Sanctuary is set apart on purpose — left undisturbed by design, not by accident or
oversight. Some mods need a human hand every time, not an automated fix; marking one for The Sanctuary
means exactly that: this one is different, leave it be, wherever it shows up.

**What it actually does:** Some mods are hand-pick-only installers where you deliberately chose a
subset of what the archive contains. Auto-extracting or auto-rebuilding the full archive for one of
these doesn't restore what's "missing" — it installs content you never chose, which can cause missing
masters or crashes. Add a mod here once, and both Restoration and The Vault-Keeper leave it alone from
then on, wherever it shows up.

---

## 🔮 The Augur (Missing Masters)

**Lore:** The Augur of Dunlain foresees what's coming before it happens — not after the crash, before
it. That's the whole value of this tool: it catches a missing master while you can still do something
about it, instead of finding out the hard way when the game refuses to launch.

**What it actually does:** Pinpoints missing master files and instantly shows every mod relying on
them, all in one clear view. Instead of a sudden crash to desktop, you see the problem coming and can
jump straight into Vortex to fix it with confidence.

---

## 🔥 The Cleansing (Vortex Scrub)

**Lore:** A cleansing purges what's been left to rot — the abandoned, the orphaned, the stuff nobody's
using anymore but that's still taking up space. Vortex quietly stops tracking staging folders and
archives sometimes, and they just sit there afterward. The Cleansing finds them and clears them out.

**What it actually does:** Spots staging folders and archives that Vortex has quietly stopped
tracking — no digging through anything by hand. Shows you exactly what's safe to remove, so you can
reclaim disk space with confidence.

---

## 👁️ Clairvoyance (Archive Finder)

**Lore:** The Illusion school's Clairvoyance spell lights the path ahead without you having to walk it
first — you see where you're going before you get there. This tool does the same thing for an
archive's own contents: it shows you what's inside without you ever having to unpack a single byte to
look.

**What it actually does:** Indexes every zipped mod archive's contents up front, no unpacking needed —
so you can instantly search across all of them by file or mod name, and pull out exactly the file or
patch you actually need.

---

## 🗝️ The Vault-Keeper (Rebuild Missing Files)

**Lore:** A Nordic vault's own keeper doesn't empty the whole hoard to replace one missing relic — they
know exactly which pedestal is bare, and they set exactly that one piece back in its place. This tool
works the same way on a collection: it doesn't rebuild everything just because a few files went
missing, it finds precisely what's gone and restores just that.

**What it actually does:** Sometimes a mod's files quietly go missing from your staging folder, and
mending the whole collection to fix it feels like overkill. Checks the collections you pick and shows
you exactly which files are gone, then restores just those, straight from the archive.

---

## 🗿 The Standing Stones (Settings)

**Lore:** In Skyrim you choose a Standing Stone's blessing once, and it quietly shapes your entire
playthrough from that point on — you don't re-choose it before every quest. Set your paths and
preferences here the same way: once, and every tool in The Arcaneum draws on that same choice from
then on.

**What it actually does:** Set your Vortex paths and preferences here just once, and every other tool
in The Arcaneum picks them up automatically — so you can spend your time on the actual work, not
re-entering the same folders over and over.

---

## Status
- **16 tools total, 14 with locked names** — lore drafted for all 16, ready for Gemini's own pass:
  Home, The Forge, Restoration, The Ward, The Scribe, The Ledger, The Quest Log, Scroll of
  Retrospection, The Scribe's Ledger, The Augur, The Cleansing, Clairvoyance, The Vault-Keeper, The
  Standing Stones.
- **2 tools with draft names AND draft lore** — The Artisan's Log (Workshop Report), The Sanctuary (Mod
  Exceptions). If Gemini's own read suggests a stronger *name* for either (not just better lore for
  the current one), that's worth weighing before locking — these two never went through the original
  four-brain naming pass the other 14 got.
- **"What it actually does" boxes** — considered a real first draft, plain-language-writer voice
  throughout, ready to use once the book itself is built (not blocked on Gemini).
