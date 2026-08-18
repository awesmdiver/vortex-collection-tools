# Vortex Collection Tools

![Vortex Collection Tools](assets/readme-banner.png)

> **Rebuild a broken Vortex collection at full speed, and stop losing your Ignored/Disabled mods every time you update one — all from a simple local web page.**

[![Donate PayPal](https://img.shields.io/badge/Donate-PayPal-00457C?logo=paypal&logoColor=white)](https://paypal.me/awesmdiver)
[![Donate Venmo](https://img.shields.io/badge/Donate-Venmo-3D95CE?logo=venmo&logoColor=white)](https://www.venmo.com/u/awesmdiver)

---

## ⚡ Overview

Vortex works fine for a small mod list, but at real scale (1,000+ mods) it freezes, forgets your
settings, and burns hours on installs and updates. Vortex Collection Tools runs alongside Vortex to
fix its biggest pain points: rebuilding a collection when files go missing or corrupted, updating a
collection without losing track of every mod you'd marked Ignored or Disabled, and keeping your
custom mod-order rules intact when a collection gets updated, and merging plugins together to reclaim
load-order slots. A set of smaller Utilities rounds it
out — clearing away leftover mod clutter, catching missing master files before they crash your
game, and finding any file inside any archive without unpacking it. Every tool lives behind one
Home page, so you're never more than a click away from the one you need. Want to have some fun with
it? Switch on the Skyrim theme and every tool gets a lore name to match — see **🎨 Make It Yours**
below.

![The Arcaneum — the Skyrim-themed Home page, one click away from every tool](assets/readme-home-screenshot.png)

### 📋 At a Glance

| Feature | Details |
| :--- | :--- |
| **Requirements** | A local web page you run yourself — nothing is sent anywhere else. Release zip bundles its own Node.js and 7-Zip, nothing else to install |
| **Nexus Account** | Free works for most tools. A few features — like automatically downloading a missing archive — need Nexus Premium, the same rule Nexus itself applies to free accounts. Everywhere that's the case, you'll get a clear note and a way to grab the file yourself instead |
| **Performance Impact** | Rebuilds run 2-3x faster with parallel extraction (up to 8 mods at once) |
| **Safety** | Every live database write takes a full backup automatically first; never touches your Skyrim save files |
| **Compatibility** | Vortex-managed Skyrim SE mod collections |

---

## ✨ Key Features

* **Puts every tool in one place:** The app opens to a Home page with every tool as its own card,
  grouped by what it does. Pin the ones you use most so they're always the first thing you see, and
  every page shows you exactly where you are, with one click back to Home.
* **Settings, all in one easy-to-scan place:** Pick a category on the left, see just its settings
  on the right — instead of one long scrolling page. Pin the ones you touch most, same as the Home
  page.

### 🧰 Main Tools

* **Rebuild Collection** *(✨ Restoration)*: Extracting a big collection inside
  Vortex takes hours and can even run your PC out of memory. This rebuilds the same files —
  including FOMOD installer choices — outside of Vortex, at full speed. ⚡ Turn on parallel
  extraction (up to 8 mods at once) under Settings to cut that time down further, typically 2-3x
  faster depending on your drive. Pause partway through and pick it up right where you left off
  whenever you're ready — nothing already finished gets redone. If you have Nexus Premium, it can
  even download missing archives for you automatically. And it leaves your `.ghost` files (Vortex's
  own marker for a disabled file) untouched, so custom file tweaks survive a reinstall.
* **Update Collection** *(🛡️ The Ward)*: Updating a collection in Vortex normally forgets which
  mods you'd marked Ignored or Disabled, leaving you to dig through a list of 1,900+ mods to turn
  off the same 35 again. This snapshots those choices before the update and restores them
  automatically once it's done — no manual cleanup. The whole update walks you through it one clear
  step at a time, previewing what's about to happen before it touches anything real.
* **Rules Generator** *(✒️ The Scribe)*: Updating a collection can leave the "load after"-style
  rules you'd set up pointing at nothing. This matches your old rules to their counterparts in the
  updated collection automatically — even auto-updating a rule that used to point at an older
  version of a mod — so you're not manually re-linking hundreds of mods by hand.
* **Merge Plugins** *(🔨 The Forge)*: Skyrim's plugin limit fills up fast, especially with lots of
  small mods. This bundles new-content plugins from your collections into a single file — review
  exactly what's going in first — and flags the result ESL automatically when it qualifies, so it
  costs you 0 slots and the originals are safe to disable afterward.

### 🧩 Utilities

* **Missing Masters** *(🔮 The Augur)*: Shows you every active plugin whose master file isn't
  actually there — the classic Skyrim "missing master" crash — the moment it happens, with no
  manual rescan needed. Use **Create Dummy Master** to patch it instantly, or **Rebuild This Mod**
  to re-extract the real files if the install just came up empty.
* **Mod Scrub** *(🔥 The Cleansing)*: Finds staging folders and downloaded archives Vortex no
  longer has any connection to — leftovers from a mod you uninstalled, or an old duplicate download
  — and lets you review and remove them, with a permanent exclude list for anything you want to
  keep around on purpose.
* **Archive Finder** *(👁️ Clairvoyance)*: Indexes every archive in your downloads folder up front
  — no unpacking required — so you can search across all of them by file or mod name and pull out
  exactly the file you need, whenever you need it.
* **Rebuild Missing Files** *(🗝️ The Vault-Keeper)*: Something not working in-game usually means a
  few files quietly went missing from staging — not your whole collection. This checks one or more
  collections, shows you exactly what's gone mod by mod, and restores just those files straight
  from the archive.
* **Cycle Helper** *(🕸️ The Webweaver)*: When Vortex says your load-order rules have a cycle, it
  dumps every mod caught in the tangle at once and leaves you to guess which rule is actually
  wrong. Snapshot your rules before you go edit them in Vortex, then scan here to find the specific
  rule responsible, fix it right there — remove it or flip its direction — and confirm the cycle's
  really gone before you move on.
* **Skip mods that need a human, not a rebuild:** Some mods are hand-pick-only installers where you
  deliberately chose just a few of the files inside — auto-restoring "everything" would install
  content you never wanted, risking missing masters or crashes. Add a mod to the Mod Exceptions
  list once, and both Rebuild Collection and Rebuild Missing Files leave it alone from then on,
  wherever it shows up.

> [!TIP]
> Every Report (Stats, Work Through, Update Compare, Workshop Report, Mod Exceptions) lives behind
> the **Reports** tab and is covered as it ships, in each release's own notes — see the
> [Releases page](../../releases).

### 🎨 Make It Yours

* **A Skyrim theme for the whole app:** Flip a switch in Settings and every tool gets its own lore
  name and icon — Rebuild Collection becomes Restoration, Merge Plugins becomes The Forge, and so
  on — with a matching color accent throughout. Switch back to the plain theme any time; nothing
  about how the tools work changes either way.
* **Pick your own accent and background tint:** Not a fan of the theme's default color? Override
  just the accent, just the background tint, or both, right from Settings — your pick sticks
  per theme.
* **Six Skyrim-style fonts to choose from:** Cinzel by default, or pick from five other
  Skyrim-flavored fonts for the Skyrim theme's own headings and lore text.
* **The Arcaneum — a Get Started book:** A story-flavored tour of what every tool actually does,
  one chapter per tool, reachable from the book icon in the header or right from the Home page.
  Includes a quick name-reference page too, if you just want to look up a tool's plain name next
  to its themed one.

---

## 📦 Getting Started

1. **Download the zip** from the [Releases page](../../releases) and unzip it anywhere.
2. **Optional: install the Vortex Collection Helper.** A small companion extension (bundled in the
   zip, under `vortex-collection-helper/`) that lets several tools read and write Vortex's data live
   while Vortex stays open, instead of you closing it first. See **Install the Helper** below — it
   takes under a minute, and you can always add it later.
3. **Double-click `start-server.bat`.** A console window stays open while it runs — that window
   staying open **is** how you know the server's running; don't close it while you're using the
   app.
4. **Set your paths.** Your browser opens to the app automatically — first time through, it'll ask
   for your staging/downloads folders under **Settings**. Do that once and you're set.

When you're done, stop the server with `stop.bat` (from anywhere), Ctrl+C in the console window, or
just clicking that window's **X** button — all three shut it down the same clean way.

> [!TIP]
> The release zip bundles its own Node.js and 7-Zip — there's no command line and nothing else to
> install. Full instructions are also in `START HERE.txt` inside the zip.

---

## 🧩 Install the Helper (optional, but recommended)

Skip this if you'd rather just close Vortex when a tool asks — everything still works exactly as
before without it. With the Helper installed, though, **Cycle Helper's Scan and fix-and-apply
steps** and **Rules Generator's Find Matching Rules and Apply/Clear/Switch steps** all work with
Vortex left open. We're extending this to more tools over time.

1. Copy the `vortex-collection-helper` folder from the release zip into
   `%APPDATA%\Vortex\plugins\`.
2. Restart Vortex.
3. That's it — the affected tools pick it up automatically the next time you use them, no
   restart of this app needed.

> [!NOTE]
> The Helper only ever reads Vortex's own live data, and its one write path dispatches through
> Vortex's own real rule-change actions — the same thing Vortex's own Conflict Editor does for a
> hand-made rule edit. It's not a separate, riskier way of changing things.

---

## ⚠️ Important Notes

> [!WARNING]
> Without the Helper installed (see **Install the Helper** above), Vortex needs to be fully closed
> for anything that reads or writes its live database: starting an actual rebuild or update, Mod
> Scrub's scan, and Missing Masters' **Rebuild This Mod**. If Vortex is still open when you try one
> of these, the app tells you right there and won't let you continue until you close it — you don't
> need to remember this list yourself.
>
> Everything else works fine with Vortex open regardless: browsing Reports, Missing Masters' scan,
> editing Mod Scrub's exclude list, all of Archive Finder — plus, with the Helper installed, Cycle
> Helper and Rules Generator as well.

> [!NOTE]
> After you rebuild a collection, Vortex will likely show an **"External Changes"** prompt the next
> time you open it, for anything that got rebuilt. That's expected — go ahead and click through it
> ("Use newer file" / "Save all changes").

> [!CAUTION]
> Update Collection and Rules Generator's **Apply to Vortex** step both write directly to Vortex's
> live database. Each takes a full backup automatically before every write, but keeping a second,
> independent backup of your own never hurts.

---

## ❓ Frequently Asked Questions

* **Q: Does this touch my Skyrim save files?**
  > **No.** This tool only works with Vortex's mod staging folder and its own database — it never
  > reads or writes your Skyrim saves.

---

* **Q: What happens if something crashes mid-run?**
  > **It's isolated, so nothing else goes down with it.** Every database read/write runs in its own
  > short-lived worker process. If that worker crashes, it only affects that one operation — not
  > the rest of the app.

---

* **Q: Does Rebuild Collection write to Vortex's database?**
  > **No.** Rebuild Collection only ever touches your mod staging folder, using a crash-safe
  > swap so an interruption never leaves a half-extracted mod in place. A few other tools (Update
  > Collection, Rules Generator's **Apply to Vortex** step, Cycle Helper's own fix-and-apply step)
  > do write to Vortex's database, and all of them always back it up in full first.

---

* **Q: What if I don't have Nexus Premium?**
  > **Everything still works** — you'll just need to download any missing archive manually from
  > the Nexus website and let Vortex install it, the same as you would without this tool.
  > Automatic downloads are a Nexus API restriction for free accounts, not a limitation of this
  > tool.

---

* **Q: I found a bug, or have feedback — what do I do?**
  > **Open an issue on GitHub.** Include what you were doing, what you expected, and what actually
  > happened — a screenshot helps a lot.

---

## 🛠️ Technical Details & Contributions

Building from source, command-line usage, how things work under the hood, and the project's
internals all live in [`TECHNICAL.md`](TECHNICAL.md).

---

## 🤝 Credits

* **Vortex** ([Nexus Mods](https://www.nexusmods.com/about/vortex/)) — the mod manager this tool
  reads and writes alongside.
* **Nexus Mods API** — used for automatic missing-archive downloads (Premium accounts only).
* **[xEdit](https://github.com/TES5Edit/TES5Edit)** and **[xedit-lib](https://github.com/matortheeternal/xedit-lib)**
  (Mator) — the plugin-editing engine behind Merge Plugins, via the bundled `XEditLib.dll`.
* **[xeditlib](https://github.com/WingedGuardian/xeditlib)** and **[koffi](https://koffi.dev/)** —
  the Node.js bindings that let this tool call `XEditLib.dll` directly, no C++ build step required.
* **[pex-parser](https://github.com/matortheeternal/pex-parser)** (Mator) — reads and rewrites
  compiled Papyrus scripts for Merge Plugins' Relink Scripts feature.
* **[BSA Browser](https://github.com/AlexxEG/BSA_Browser)** (AlexxEG) — the CLI this tool uses for
  Bethesda archive (BSA/BA2) extraction. Credited here regardless of how much local modernization
  sits on top (see `skyrim-modding/bsa-browser-revised`) — the original author and project stay the
  credit.
* **[7-Zip](https://www.7-zip.org/)** — bundled for archive extraction.
* **[Node.js](https://nodejs.org/)** — the runtime this whole app (and its bundled release package)
  runs on.

Full license text and attribution detail for everything above lives in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
