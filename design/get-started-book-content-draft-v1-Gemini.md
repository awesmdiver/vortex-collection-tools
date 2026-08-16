# **Get Started Book — Content Draft v2 (Final Lore & Tools)**

This document integrates the finalized lore takes alongside the approved "What it actually does" functional descriptions for all 16 tools in the Skyrim-themed Vortex Collection Tools suite.

## **📖 The Arcaneum (Home)**

**Lore:** Urag gro-Shub’s grand library does not cast spells or weave enchantments of its own; it simply holds the accumulated knowledge of the entire realm under one roof. Whether an apprentice seeks the delicate touch of Restoration or the violent fire of the Forge, the shelves stand ready and cataloged. You do not need to master every craft at once—you only need to step inside the threshold to reach any tool you require.  
**What it actually does:** Your home base — pick a tool, jump right in. Every card here is one click from whatever you actually came to do: rebuild a collection, keep your Ignored/Disabled mods safe through an update, copy conflict rules across, or check in on a report. Nothing happens on this page itself; it's the map, not the destination.

## **🔨 The Forge (Merge Plugins)**

**Lore:** A master smith never conjures steel from thin air; they take disparate ingots, heat them over white coals, and hammer them into a single, cohesive blade. The metal retains its original temper and strength, but occupies far less space on an adventurer's belt. In the same manner, multiple working works are brought together on the anvil, tempered into a single master craft that preserves your carrying capacity.  
**What it actually does:** Pick plugins from one or more collections, review exactly what's going into the merge (which records, whether anything needs a master, whether it overrides another mod's own changes), then merge them into a single new .esp. If the result stays under Skyrim's 4,096-record light-plugin limit and doesn't touch any cell/worldspace records, it gets flagged as an ESL automatically — zero load-order cost. Nothing about your original plugins changes; the merge is a new file, backed by the xelib engine Wrye Bash/xEdit both use under the hood.

## **✨ Restoration (Rebuild Collection)**

**Lore:** Restoration is a perfectly valid school of magic because it wastes no time re-inventing the body it tends to; it simply closes wounds and returns weary flesh to full vigor. When a traveler collapses, a priest of Arkay does not demand they be born anew from infancy. The spell simply reaches down, knits the torn fibers back together in a burst of light, and sets you back on the road in moments.  
**What it actually does:** Skips Vortex's slow archive-install process entirely. Re-extracts an already-installed collection's mods directly into your staging folder — same result as installing it fresh, dramatically faster. Review exactly what would change before anything actually happens, then let it run in the background while you do something else.

## **🛡️ The Ward (Update Collection)**

**Lore:** A properly cast Ward does not try to halt the storm raging outside; it erects an unyielding barrier around what matters most while the gale passes by. The winds of change may sweep across the realm and reshape the surrounding landscape, but whatever rests behind the shield remains unblemished. Your deliberate choices stand firm, completely untouched by the incoming tide.  
**What it actually does:** Updating a collection in Vortex often resets your carefully-set Ignored and Disabled mods back to their defaults. This tool remembers exactly how you had things set and restores it right after the update, so that cleanup work never has to happen twice. Walks you through the steps in order — you'll hop over to Vortex between some of them, and your place here is saved while you do.

## **✒️ The Scribe (Rules Generator)**

**Lore:** When an ancient parchment crumbles, the Court Scribe does not rewrite history from memory—they meticulously copy each glyph and margin note onto fresh vellum with exact fidelity. Every hard-won truth and hard-fought boundary recorded in the old text is preserved without change. The ink may be fresh, but the wisdom guiding the words remains unbroken.  
**What it actually does:** Matches mods between your old and new collections, then copies the conflict rules you already set up straight across — so you're never stuck resolving the exact same load-order conflict twice. Review every match before anything gets written to Vortex; nothing applies until you say so.

## **📊 The Ledger (Stats)**

**Lore:** A master merchant does not rely on fireside tales to measure the health of a trading company; they consult the cold, ink-stained pages of the tally book. Every transaction, weight, and turn of speed is set down in orderly rows. A single glance across the columns reveals the true history of your efforts, cutting through the noise with absolute clarity.  
**What it actually does:** Tracks how every collection you've rebuilt has performed over time, and instantly spots which mods still need attention right now. No more digging through individual run logs one at a time to piece together the full picture.

## **✅ The Quest Log (Work Through)**

**Lore:** An adventurer’s journal does not dwell on long-vanquished dragons; it tracks the open bounties, the missing artifacts, and the contracts still demanding blood and coin. When the path ahead grows tangled, you do not wander the wilderness hoping to remember your purpose. You consult the log, address each lingering trouble one by one, and strike them from the parchment as they fall.  
**What it actually does:** Gathers every problem mod across every collection into one checklist. Fix resolvable mismatches and missing archives right here; check off anything else as you handle it in Vortex yourself. Your progress sticks around until a fresh rerun clears it.

## **🔍 Scroll of Retrospection (Update Compare)**

**Lore:** The mystical parchment unfurls to reveal the flow of time unspooled, setting the memory of what was directly beside the reality of what has become. Rather than wandering blindly into altered lands, the scroll lays both moments upon the table simultaneously. You see at once which relics were carried forward, which were left behind, and what new mysteries have taken root.  
**What it actually does:** After running an update with The Ward, get a clear before-and-after comparison of your mods — what stayed, what got added, what got removed — so you're never left guessing what an update actually did.

## **📋 The Scribe's Ledger (Rules Generator Report)**

**Lore:** Before closing their satchel, the scholar always inspects their working notes to verify every passage transferred cleanly. Some passages map line-for-line without friction, while obscure phrases require a scholar's personal discernment before they are bound into the final tome. This ledger lays out that exact tally: the work completed, and the few verses still awaiting your mark.  
**What it actually does:** See at a glance which mods already have their conflict rules copied over correctly, and which ones still need a decision or a second look in Vortex — all without re-running the matching process itself.

## **📓 The Anvil’s Mark (Workshop Report)**

**Lore:** The painted trade sign swinging out front tells the town only when the shop first opened, not when a hammer last fell upon glowing steel. A true armorer looks to the fresh indentations stamped into the anvil’s face—the maker’s mark that records the exact day and hour a blade was last tempered. This report looks past the public storefront to measure the true, unvarnished pulse of your active work.

What it actually does: Nexus's own collection page shows a date that never moves for a private collection — this pulls the real "last touched" timestamp from the collection's own revision history instead, sortable newest-to-oldest, so you can spot at a glance which ones are overdue for an update. Fetch a never-downloaded Workshop collection straight from here too.

## **🕊️ The Shadowmarked (Mod Exceptions)**

**Lore:** Carved into doorposts across the cities of Skyrim, a shadowmark conveys an unspoken law to those who know the code: do not pillage, do not interfere, leave this house completely alone. Certain works are delicate and custom-built, never intended for the heavy hand of automated repair. Marking them keeps all common machinery at bay, allowing your handcrafted choices to stand untouched.  
**What it actually does:** Some mods are hand-pick-only installers where you deliberately chose a subset of what the archive contains. Auto-extracting or auto-rebuilding the full archive for one of these doesn't restore what's "missing" — it installs content you never chose, which can cause missing masters or crashes. Add a mod here once, and both Restoration and The Vault-Keeper leave it alone from then on, wherever it shows up.

## **🔮 The Augur (Missing Masters)**

**Lore:** Deep beneath the College of Winterhold, the Augur of Dunlain perceives the catastrophic collapse of magical forces long before the careless apprentice strikes a spark. He does not offer aid after the tower has fallen; his ethereal vision pierces the veil beforehand to warn of structural foundations left missing. Heed his insight, and the impending catastrophe dissolves before it begins.  
**What it actually does:** Pinpoints missing master files and instantly shows every mod relying on them, all in one clear view. Instead of a sudden crash to desktop, you see the problem coming and can jump straight into Vortex to fix it with confidence.

## **🔥 The Cleansing (Vortex Scrub)**

**Lore:** Ancient barrows and ruined sanctuaries inevitably gather cobwebs, forgotten debris, and lingering wraiths that serve no living master. A true cleansing channels the sun's brilliance through the gloom, turning abandoned clutter and decaying detritus into harmless cinder. What is purged frees up room for fresh stone, leaving your vaults light, unburdened, and pristine.  
**What it actually does:** Spots staging folders and archives that Vortex has quietly stopped tracking — no digging through anything by hand. Shows you exactly what's safe to remove, so you can reclaim disk space with confidence.

## **👁️ Clairvoyance (Archive Finder)**

**Lore:** The shimmering blue light of Clairvoyance does not require you to tear down dungeon walls or pick heavy iron locks just to see what lies within. The mystic beacon threads effortlessly through solid stone and sealed chests, guiding your inner eye directly to the hidden artifact you seek. You perceive the exact contents of sealed parcels without ever breaking the wax.  
**What it actually does:** Indexes every zipped mod archive's contents up front, no unpacking needed — so you can instantly search across all of them by file or mod name, and pull out exactly the file or patch you actually need.

## **🗝️ The Vault-Keeper (Rebuild Missing Files)**

**Lore:** The watchful warden of an ancient Nordic burial vault never empties every chest and sarcophagus just because a single ceremonial blade was dislodged. They know every pedestal by heart, walk straight to the empty alcove in the dark, and set that specific relic back upon its stand. The integrity of the treasure hall is preserved with surgical precision, without disturbing the rest of the hoard.  
**What it actually does:** Sometimes a mod's files quietly go missing from your staging folder, and mending the whole collection to fix it feels like overkill. Checks the collections you pick and shows you exactly which files are gone, then restores just those, straight from the archive.

## **🗿 The Standing Stones (Settings)**

**Lore:** The monolithic Standing Stones carved across the tundra grant enduring blessings that govern an adventurer’s journey across thousands of leagues. You do not stop to re-align your stars before entering every dungeon; the foundation is laid once, and the power flows through every sword swing and spell cast thereafter. Align your course here at the monolith, and every tool under your command follows suit.  
**What it actually does:** Set your Vortex paths and preferences here just once, and every other tool in The Arcaneum picks them up automatically — so you can spend your time on the actual work, not re-entering the same folders over and over.