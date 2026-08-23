# Vortex Collection Tools

![Vortex Collection Tools](assets/readme-banner.png)

> **Rebuild a broken Vortex collection at full speed, and stop losing your Ignored/Disabled mods every time you update one — all from a simple local web page.**

[![Donate PayPal](https://img.shields.io/badge/Donate-PayPal-00457C?logo=paypal&logoColor=white)](https://paypal.me/awesmdiver)
[![Donate Venmo](https://img.shields.io/badge/Donate-Venmo-3D95CE?logo=venmo&logoColor=white)](https://www.venmo.com/u/awesmdiver)

---

## ⚡ Overview

Vortex works fine for smaller mod lists, but at scale (1,000+ mods) it freezes, forgets settings, and burns hours on installs and updates. Vortex Collection Tools runs alongside Vortex to solve its biggest pain points: rebuilding broken or corrupted collections, updating collections without losing track of your Ignored or Disabled mods, keeping custom mod-order rules intact during updates, and merging plugins to reclaim load-order slots. A suite of specialized Utilities rounds out the workspace — clearing leftover mod clutter, catching missing master files before they crash your game, and locating files inside archives without unpacking them. Every tool lives on a unified Home page, putting you one click away from what you need. Want to flavor your workspace? Switch on the Skyrim theme to give every tool a lore-friendly name and custom look — see **🎨 Make It Yours** below.

![The Arcaneum — the Skyrim-themed Home page, one click away from every tool](assets/readme-home-screenshot.png)

### 📋 At a Glance

| Feature | Details |
| :--- | :--- |
| **Requirements** | A local web page you run yourself — nothing is sent anywhere else. The release zip bundles its own Node.js and 7-Zip, requiring no additional dependencies. |
| **Nexus Account** | Free accounts work for most tools. Features like automatic missing-archive downloads require Nexus Premium (the same restriction Nexus enforces). Clear instructions and manual download alternatives are provided whenever this applies. |
| **Performance Impact** | Rebuilds run 2–3x faster using parallel extraction (up to 8 mods simultaneously). |
| **Safety** | Automatic full backups precede every live database write; Skyrim save files are never touched. |
| **Compatibility** | Vortex-managed Skyrim SE mod collections. |

---

## ✨ Key Features

* **Puts every tool in one place:** The app opens to a Home page featuring every tool as its own card, organized by function. Pin your most-used tools to the top, navigate easily with clear location indicators, and return to Home in a single click.
* **Settings, all in one easy-to-scan place:** Settings are grouped by category in a side navigation menu rather than a single endless page. Pin frequently accessed settings just like tool cards on the Home page.

### 🧰 Main Tools

* **Rebuild Collection** *(✨ Restoration)*: Rebuilding large collections inside Vortex takes hours and can consume all available system RAM. This tool extracts the same files — including FOMOD choices — outside of Vortex at maximum speed. Enable parallel extraction (up to 8 mods at once) under Settings to cut processing time by 2–3x. Pause and resume anytime without re-extracting completed mods. Nexus Premium users can automatically download missing archives. Leaves `.ghost` files (Vortex's marker for disabled files) intact so custom file tweaks survive reinstalls.
* **Update Collection** *(🛡️ The Ward)*: Updating a collection in Vortex normally resets your Ignored or Disabled mod settings, forcing you to manually re-disable dozens of mods across massive lists. This tool snapshots your choices before the update and restores them automatically once finished. A step-by-step wizard previews every change before applying it to your setup.
* **Rules Generator** *(✒️ The Scribe)*: Collection updates often break custom "load after" rules by pointing to missing or renamed mods. This tool automatically matches old rules to their updated equivalents — including updating rules pointing to older mod versions — eliminating manual relinking.
* **Merge Plugins** *(🔨 The Forge)*: Skyrim's plugin limit fills up fast. This tool bundles new-content plugins from your collections into a single file, automatically ESL-flagging the result when eligible (costing 0 load-order slots) while keeping original files safe to disable. Review all contents prior to merging.

### 🧩 Utilities

* **Missing Masters** *(🔮 The Augur)*: Instantly displays active plugins with missing master files — the primary cause of startup crashes — without needing a manual rescan. Fix issues immediately using **Create Dummy Master** or re-extract files via **Rebuild This Mod**.
* **Mod Scrub** *(🔥 The Cleansing)*: Scans staging folders and downloaded archives for leftover files unlinked to active Vortex mods. Review and safely delete orphaned files, backed by a permanent exclude list for items you wish to keep.
* **Archive Finder** *(👁️ Clairvoyance)*: Indexes your download archives up front without unpacking them. Search across all archives by file or mod name and extract specific files instantly.
* **Rebuild Missing Files** *(🗝️ The Vault-Keeper)*: Fixes individual missing staging files without rebuilding an entire collection. Scans one or more collections, identifies missing files per mod, and restores only those files directly from their archives.
* **Cycle Helper** *(🕸️ The Webweaver)*: When Vortex detects a load-order cycle, it lists every involved mod at once without identifying the conflicting rule. Snapshot your rules, scan to pinpoint the exact rule causing the loop, modify or delete it directly, and confirm resolution before returning to Vortex.
* **Clear Update Flags** *(💎 Cleansing Stone)*: Vortex's "Check for Updates" button often flags hundreds of mods with "Update Available" badges — even when a curated collection intentionally pins older, tested versions. This tool clears those stale badges in bulk directly from Vortex's tracked data without touching installed mod files, load orders, or collection rules. Choose specific collections or clear all at once, backed by automatic database backups.
* **PGPatcher Load Order Editor** *(👑 Order of Succession)*: PGPatcher ships with only a bare-bones plugin-ordering screen. This tool replaces it with a full drag-and-drop load-order editor, reads PGPatcher's native settings, and drives its actual command-line build behind the scenes. Real-time streaming progress (phase and percentage) replaces static waiting screens, landing on a clear summary with the output path and reminders to re-enable and deploy affected mods in Vortex. *(Needs PGPatcher installed and configured once first — see Important Notes.)*

### 📊 Reports

A tab of its own for the data views that don't fit a single-action tool — reachable from the **Reports** tab, documented with each update on the [Releases page](../../releases).

* **Stats**: See how every rebuild performed over time, and what still needs attention right now.
* **Work Through**: Every problem mod across every collection, gathered into one checklist.
* **Update Compare**: A clear before-and-after of what an update added, kept, and removed.
* **Workshop Report**: The real date you last touched each Workshop collection, straight from Nexus.
* **Mod Exceptions**: Mods that need a hand-picked, custom installation — only some of the files inside are wanted. Auto-restoring one of these would install content you never chose, risking a missing master or a crash. Add a mod here once, and both **Rebuild Collection** and **Rebuild Missing Files** leave it alone wherever it appears from then on.

### 🎨 Make It Yours

* **A Skyrim theme for the whole app:** Flip a switch in Settings to give every tool a lore-friendly name and icon (e.g., Rebuild Collection becomes *Restoration*, Merge Plugins becomes *The Forge*) with matching color accents. Switch back to the standard theme anytime without affecting tool functionality.
* **Custom accent and background colors:** Override default theme colors by adjusting accent colors, background tints, or both directly in Settings. Color preferences save independently per theme.
* **Six Skyrim-style fonts:** Choose between Cinzel (default) or five other Skyrim-themed fonts for headings and lore text when using the Skyrim theme.
* **The Arcaneum — A Get Started guide:** An in-app guide detailing what each tool does, complete with lore descriptions and a quick cross-reference table mapping plain tool names to their Skyrim equivalents. Reachable via the book icon in the header or directly from Home.

---

## 📦 Getting Started

**Installer (recommended):** grab `VortexCollectionTools-Setup.exe` from the [Releases page](../../releases) and run it. One download, no command-line tools, nothing else to install — you'll find Vortex Collection Tools in your Start Menu afterward, running from your system tray. The installer's own finish screen walks you through the one optional step below.

**Portable, no-install version:**

1. **Download the zip** from the [Releases page](../../releases) and extract it anywhere.
2. **Optional: Install the Vortex Collection Helper.** A small companion extension (bundled in the release zip under `vortex-collection-helper/`) that allows tools to read and write Vortex data live while Vortex remains open. See **Install the Helper** below — it takes less than a minute and can be added at any time.
3. **Double-click `start-server.bat`.** A console window will open and remain running. This window **must** stay open while using the app; closing it stops the server.
4. **Set your paths.** Your browser will automatically open the app. On first launch, configure your staging and download paths under **Settings**.

When finished, stop the server using `stop.bat`, pressing `Ctrl+C` in the console window, or closing the console window directly.

> [!TIP]
> The release zip bundles its own Node.js and 7-Zip binaries — no command-line tools or secondary installations are required. Step-by-step instructions are also available in `START HERE.txt` inside the zip.

---

## 🧩 Install the Helper (Optional, Recommended)

If you prefer to close Vortex when prompted by a tool, you can skip this step — all features function without it. Installing the Helper lets several tools work with Vortex left open instead — see the table under **Important Notes** for exactly which ones.

**Method 1: Through Vortex (Easiest)**

1. Open Vortex and navigate to **Settings** > **Extensions**.
2. Click **Install from File** and select `vortex-collection-helper.zip` from the release package.
3. Restart Vortex.

**Method 2: Manual Installation**

1. Extract `vortex-collection-helper.zip` from the release package into its own folder.
2. Copy the `vortex-collection-helper` folder into `%APPDATA%\Vortex\plugins\`.
3. Restart Vortex.

Once installed, supported tools automatically detect the Helper without requiring an app restart.

> [!NOTE]
> The Helper only reads Vortex's active data and executes rule modifications through Vortex's native action pipeline — identical to making manual edits within Vortex's Conflict Editor.

---

## ⚠️ Important Notes

> [!WARNING]
> **Does this need Vortex closed?** The app blocks and tells you right there if it does — you never need to memorize this table, it's here for reference.
>
> | Tool / step | Without the Helper | With the Helper installed |
> | :--- | :--- | :--- |
> | Reports, Missing Masters' scan, Mod Scrub's exclude list, Archive Finder | Works with Vortex open | Works with Vortex open |
> | Rebuild Collection, Update Collection | **Vortex must be closed** | **Vortex must be closed** |
> | Mod Scrub's scan, Missing Masters' **Rebuild This Mod** | **Vortex must be closed** | Works with Vortex open |
> | Cycle Helper, Rules Generator | **Vortex must be closed** | Works with Vortex open |

> [!NOTE]
> After rebuilding a collection, Vortex may display an **"External Changes"** prompt upon re-opening for any rebuilt files. This is normal behavior — accept the prompt by selecting **"Use newer file"** or **"Save all changes"**.

> [!CAUTION]
> Update Collection and Rules Generator's **Apply to Vortex** step write directly to Vortex's live database. Automatic full backups are created before every write operation, but maintaining an independent manual backup of your Vortex data is recommended.

> [!WARNING]
> **PGPatcher Load Order Editor requires initial PGPatcher setup.** This tool reads settings generated by the standalone PGPatcher application. You must install PGPatcher and run it at least once (configure settings and click Save or generate a patch) before using this tool. The tool will warn you prior to execution if configuration files are missing.

---

## ❓ Frequently Asked Questions

* **Q: Does this tool modify my Skyrim save files?**
  > **No.** This tool interacts exclusively with Vortex's staging folder and internal database. It never accesses or modifies your game saves.

---

* **Q: What happens if an operation crashes mid-run?**
  > **Operations are isolated.** Database reads and writes execute inside dedicated worker processes. If a process encounters an error, only that specific operation is interrupted — the rest of the application remains stable.

---

* **Q: Does Rebuild Collection modify Vortex's database?**
  > **No.** Rebuild Collection only modifies files within your mod staging directory using atomic file swaps to prevent incomplete extractions. Tools that do write to the database (Update Collection, Rules Generator's **Apply to Vortex**, and Cycle Helper's apply step) always perform full automatic database backups beforehand.

---

* **Q: What if I do not have a Nexus Premium account?**
  > **All tools remain functional.** Missing archives must be downloaded manually through the Nexus website and installed via Vortex. Automatic background downloading is restricted to Nexus Premium accounts due to Nexus API policies.

---

* **Q: How do I report bugs or submit feedback?**
  > **Open an issue on GitHub.** Please include steps to reproduce the issue, expected results, actual behavior, and relevant screenshots.

---

## 🛠️ Technical Details & Contributions

Instructions for building from source, CLI commands, architecture overviews, and internal workflows are documented in [`TECHNICAL.md`](TECHNICAL.md).

---

## 🤝 Credits

* **Vortex** ([Nexus Mods](https://www.nexusmods.com/about/vortex/)) — The mod manager integrated alongside this toolkit.
* **[PGPatcher](https://github.com/hakasapl/PGPatcher)** (hakasapl) — The PBR texture-patching utility driven by the PGPatcher Load Order Editor.
* **Nexus Mods API** — Used for automated missing-archive downloads (Premium accounts only).
* **[xEdit](https://github.com/TES5Edit/TES5Edit)** and **[xedit-lib](https://github.com/matortheeternal/xedit-lib)** (Mator) — Plugin manipulation engine powering Merge Plugins via `XEditLib.dll`.
* **[xeditlib](https://github.com/WingedGuardian/xeditlib)** and **[koffi](https://koffi.dev/)** — Node.js bindings enabling direct execution of `XEditLib.dll`.
* **[pex-parser](https://github.com/matortheeternal/pex-parser)** (Mator) — Papyrus script parser used by Merge Plugins' script relinking feature.
* **[BSA Browser](https://github.com/AlexxEG/BSA_Browser)** (AlexxEG) — CLI utility utilized for Bethesda archive extraction (BSA/BA2).
* **[7-Zip](https://www.7-zip.org/)** — Bundled archive extraction utility.
* **[sharp](https://github.com/lovell/sharp)** and **[oxipng](https://github.com/oxipng/oxipng)** — Image optimization tools for release assets (`scripts/compress-image.js`).
* **[Node.js](https://nodejs.org/)** — JavaScript runtime powering the application package.

Full licensing details and third-party attributions are available in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
