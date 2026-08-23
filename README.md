# Vortex Collection Tools

![Vortex Collection Tools](assets/readme-banner.png)

> **Everything you need to run massive Vortex collections without the friction. Fix conflicts visually, protect your personal setup across updates, clean up orphaned clutter, and rebuild at full speed.**

[![Donate PayPal](https://img.shields.io/badge/Donate-PayPal-00457C?logo=paypal&logoColor=white)](https://paypal.me/awesmdiver)
[![Donate Venmo](https://img.shields.io/badge/Donate-Venmo-3D95CE?logo=venmo&logoColor=white)](https://www.venmo.com/u/awesmdiver)

---

## ⚡ Overview

Vortex works fine for smaller mod lists, but at scale (1,000+ mods) it can freeze, lose track of settings, and burn hours on installs and updates. Vortex Collection Tools runs alongside Vortex to take the pain out of managing large setups: rebuild broken or corrupted collections in a fraction of the time, update collections without resetting your Ignored or Disabled mods, keep custom mod-order rules intact across updates, and merge plugins to reclaim precious load-order slots.

A collection of focused utilities rounds out the workspace — clearing leftover mod clutter, catching missing master files before they crash your game, and locating files inside archives without unpacking them. Everything lives on a single Home page so you're always one click away from the tool you need. Want to flavor your workspace? Flip on a Skyrim or Fallout 4 theme to give every tool a lore-friendly name and custom look — see **🎨 Make It Yours** below.

![The Arcaneum — the Skyrim-themed Home page, one click away from every tool](assets/readme-home-screenshot.png)

### 📋 At a Glance

| Feature | Details |
| :--- | :--- |
| **Requirements** | A local web page you run on your own PC. The only outside connections are to Nexus Mods when a tool needs one (checking your account, downloading an archive) — nothing else leaves your machine. The release zip bundles its own Node.js and 7-Zip, so you don't need to install any extra runtimes. |
| **Nexus Account** | Free accounts work for almost everything. Automatic missing-archive downloads require Nexus Premium (the same rule Nexus enforces everywhere). Clear instructions and manual download options are always provided. |
| **Performance** | Rebuilds run 2–3x faster using parallel extraction (up to 8 mods at once). |
| **Safety** | Automatic full backups are created before every live write to Vortex. Your game saves are never touched. |
| **Compatibility** | Vortex-managed Skyrim SE mod collections. |

---

## ✨ Key Features

* **Every tool in one place:** The app opens to a clean Home page with a card for each tool. Pin your favorites to the top, see exactly where you are with clear breadcrumbs, and hop back Home in a single click.
* **Organized settings:** Settings are grouped neatly by category in a sidebar instead of buried in a giant endless page. Pin your most frequent settings just like tool cards.

### 🧰 Main Tools

* **Rebuild Collection** *(✨ Restoration / Project Purity)*: Rebuilding massive collections inside Vortex takes hours and can chew through your system RAM. This tool extracts the same files — including your FOMOD choices — outside of Vortex at top speed. Turn on parallel extraction in Settings to unpack up to 8 mods at once and cut rebuild times by 2–3x. Pause and resume whenever you want without re-extracting completed mods. Nexus Premium users can download missing archives automatically. Leaves `.ghost` files (Vortex's markers for disabled files) intact so your custom file tweaks survive.
* **Update Collection** *(🛡️ The Ward / Defense Protocol)*: Updating a collection in Vortex normally wipes your Ignored and Disabled mod choices, forcing you to hunt down and re-disable dozens of mods by hand. This tool snapshots your choices before the update and restores them automatically once it's done. A step-by-step wizard previews every single change before applying it.
* **Rules Generator** *(✒️ The Scribe / Automation Terminal)*: Collection updates often break custom "load after" rules when mods get renamed or replaced. This tool matches your old rules to their updated equivalents — even matching rules that point to older version numbers — so you don't have to rebuild your rule list from scratch.
* **Merge Plugins** *(🔨 The Forge / Institute Sub-Assembly)*: Skyrim's plugin limit fills up fast. This tool bundles new-content plugins from your collections into a single merged file, ESL-flagging the result whenever possible (costing 0 load-order slots) while leaving your original files safe to disable. You can review all contents before merging.
* **Safe Collection Removal** *(📦 The Quartermaster / Supply Depot)*: Uninstalling a collection in Vortex can easily wipe out mods that your other collections still rely on. This tool scans your setup first, flags every shared mod, and lets you choose what to keep and what to delete — so you can clean up old collections without breaking anything else.

### 🧩 Utilities

* **Missing Masters** *(🔮 The Augur)*: Instantly shows active plugins missing master files — the #1 cause of startup crashes — without making you run a slow manual scan. Fix problems on the spot with **Create Dummy Master** or re-extract missing files with **Rebuild This Mod**.
* **Mod Scrub** *(🔥 The Cleansing)*: Scans staging folders and downloaded archives for leftover files that aren't linked to any active Vortex mod. Review and safely clean up orphaned clutter, with a permanent exclude list for anything you want to keep.
* **Archive Finder** *(👁️ Clairvoyance)*: Indexes your download archives up front without unpacking them. Search across all your archives by file or mod name and extract specific files instantly.
* **Rebuild Missing Files** *(🗝️ The Vault-Keeper)*: Fixes individual missing staging files without rebuilding an entire collection. Scans your collections, pinpoints missing files per mod, and restores just those files straight from your archives.
* **Cycle Helper** *(🕸️ The Webweaver)*: When Vortex detects a load-order cycle, it dumps every involved mod on screen at once without telling you which rule caused the loop. Snapshot your rules, pinpoint the exact conflicting rule, view it as a visual graph diagram, and test rule changes directly before returning to Vortex.
* **Clear Update Flags** *(💎 Cleansing Stone)*: Vortex's "Check for Updates" button often flags hundreds of mods with "Update Available" badges — even when a curated collection intentionally pins older, tested versions. This tool clears those stale badges in bulk directly from Vortex without touching your installed files, load order, or collection rules.
* **PGPatcher Load Order Editor** *(👑 Order of Succession)*: Replaces PGPatcher's bare-bones ordering screen with a full drag-and-drop load-order editor, reads your PGPatcher settings, and runs the command-line patcher behind the scenes with live phase-by-phase progress. *(Requires PGPatcher to be installed and configured once first — see Important Notes.)*

### 📊 Reports

A dedicated tab for data views and checklists that don't fit into a single-action tool:

* **Stats**: Track rebuild speeds over time and see what still needs attention.
* **Work Through**: Every problem mod across all your collections, organized into a single actionable checklist.
* **Update Compare**: A clear before-and-after breakdown of what an update added, kept, and removed.
* **Workshop Report**: See the actual date you last modified each Workshop collection, pulled straight from Nexus.
* **Mod Exceptions**: Mods that need a custom, hand-picked installation (where you only want a subset of files). Auto-restoring these would install files you never picked and risk crashes. Add a mod here once, and **Rebuild Collection** and **Rebuild Missing Files** will leave it alone everywhere it appears.

### 🎨 Make It Yours

* **Skyrim or Fallout 4 themes:** Flip a switch in Settings to give every tool a lore-friendly name, custom icon, and color accent tailored to the game you're playing. Rebuild Collection becomes *Restoration* (Skyrim) or *Project Purity* (Fallout 4); Merge Plugins becomes *The Forge* or *Institute Sub-Assembly*. You can switch back to the standard theme anytime.
* **Custom accent and background colors:** Adjust accent colors and background tints in Settings. Preferences save separately for each theme.
* **Dedicated theme fonts:** Choose from six Skyrim-style fonts (Cinzel by default) or five retro-terminal Fallout fonts in Settings for headings and lore text.
* **Themed in-app guide:** Consult *The Arcaneum* (Skyrim) or *The Pip-Boy — A Survivor's Manual* (Fallout 4) for details on what each tool does, complete with lore descriptions and a quick cross-reference table mapping plain tool names to their themed equivalents. Open it via the book icon in the header or directly from Home.

---

## 📦 Getting Started

**Installer (recommended):** Grab `VortexCollectionTools-Setup.exe` from the [Releases page](../../releases) and run it. You'll find Vortex Collection Tools in your Start Menu and running from your system tray. For the optional companion extension, see **🧩 Install the Helper** below.

**Portable version:**

1. **Download the zip** from the [Releases page](../../releases) and extract it anywhere.
2. **Double-click `start-server.bat`.** A console window will open and stay running while the app is active.
3. **Set your paths.** Your browser will open the app automatically. On first launch, head to **Settings** to set your staging and download paths.

When finished, stop the server by running `stop.bat`, pressing `Ctrl+C` in the console window, or simply closing the window.

> [!TIP]
> The release zip bundles its own Node.js and 7-Zip binaries — no command-line tools or extra runtimes required. Step-by-step instructions are also included in `START HERE.txt` inside the zip.

---

## 🧩 Install the Helper (Optional, Recommended)

If you prefer to close Vortex when prompted, you can skip this step — all core features work without it. Installing the Helper allows several tools to run with Vortex left open instead (see the table under **Important Notes** for the full breakdown).

**Method 1: Through Vortex (Easiest)**

1. In Vortex, go to **Settings** > **Extensions**.
2. Click **Install from File** and choose `vortex-collection-helper.zip` from the release package.
3. Restart Vortex.

**Method 2: Manual Installation**

1. Extract `vortex-collection-helper.zip` from the release package into its own folder.
2. Copy the `vortex-collection-helper` folder into `%APPDATA%\Vortex\plugins\`.
3. Restart Vortex.

Once installed, supported tools detect the Helper automatically — no app restart needed.

> [!NOTE]
> The Helper only reads active Vortex data and applies rule changes through Vortex's native actions — exactly like making manual edits in Vortex's Conflict Editor.

---

## ⚠️ Important Notes

> [!WARNING]
> **Does this need Vortex closed?** The app checks and prompts you right away if it does — you don't need to memorize this table, but here is the reference:
>
> | Tool / step | Without the Helper | With the Helper installed |
> | :--- | :--- | :--- |
> | Reports, Missing Masters' scan, Mod Scrub's exclude list, Archive Finder | Works with Vortex open | Works with Vortex open |
> | Rebuild Collection, Merge Plugins | **Vortex must be closed** | **Vortex must be closed** |
> | Mod Scrub's scan, Missing Masters' **Rebuild This Mod**, Rebuild Missing Files, Cycle Helper, Rules Generator, Update Collection's review steps | **Vortex must be closed** | Works with Vortex open |
> | Clear Update Flags, PGPatcher Load Order Editor, Safe Collection Removal, Update Collection's **Apply** step | **Requires the Helper — no offline path** | Works with Vortex open |

> [!NOTE]
> After rebuilding a collection, Vortex may show an **"External Changes"** prompt when you re-open it. This is expected — choose **"Use newer file"** or **"Save all changes"**.

> [!CAUTION]
> Tools that modify your Vortex setup (such as Update Collection's **Apply**, Rules Generator, Clear Update Flags, and Safe Collection Removal) write directly to Vortex. Full automatic backups are created before every write, but keeping your own regular backups of your Vortex data is always good practice.

> [!WARNING]
> **PGPatcher Load Order Editor requires initial PGPatcher setup.** This tool reads configuration files created by the standalone PGPatcher app. You need to install PGPatcher and run it at least once (save settings or generate a patch) before using this tool.

---

## ❓ Frequently Asked Questions

* **Q: Does this tool modify my game save files?**
  > **No.** The app only interacts with your mod staging folder, archive downloads, and Vortex's own settings. It never touches your game saves.

---

* **Q: What happens if an operation encounters an error mid-run?**
  > **Tasks run in isolation.** If an extraction or patch operation runs into an error, only that specific task stops. The rest of the app stays running, and your existing setup isn't left in a corrupted state.

---

* **Q: Does Rebuild Collection change anything in Vortex itself?**
  > **No.** Rebuild Collection only unpacks files into your mod staging folder — it doesn't modify Vortex's settings or collections. Whenever *any* tool makes direct changes to Vortex (such as the tools marked in the compatibility table above), it automatically creates a full backup first so you can easily roll back.

---

* **Q: What if I don't have a Nexus Premium account?**
  > **All tools still work.** Missing archives simply need to be downloaded through the Nexus website and dropped into Vortex manually. Automatic background downloads require Nexus Premium due to Nexus API limits.

---

* **Q: How do I report bugs or submit feedback?**
  > **Open an issue on GitHub.** Please include steps to reproduce what happened, what you expected to see, what actually happened, and any relevant screenshots.

---

## 🛠️ Technical Details & Contributions

Instructions for building from source, CLI commands, architecture overviews, and internal workflows are documented in [`TECHNICAL.md`](TECHNICAL.md).

---

## 🤝 Credits

* **Vortex** ([Nexus Mods](https://www.nexusmods.com/about/vortex/)) — The mod manager this toolkit runs alongside.
* **[PGPatcher](https://github.com/hakasapl/PGPatcher)** (hakasapl) — The PBR texture-patching utility driven by the PGPatcher Load Order Editor.
* **Nexus Mods API** — Powers automated missing-archive downloads for Nexus Premium accounts.
* **[xEdit](https://github.com/TES5Edit/TES5Edit)** and **[xedit-lib](https://github.com/matortheeternal/xedit-lib)** (Mator) — Plugin manipulation engine powering Merge Plugins via `XEditLib.dll`.
* **[xeditlib](https://github.com/WingedGuardian/xeditlib)** and **[koffi](https://koffi.dev/)** — Node.js bindings for direct execution of `XEditLib.dll`.
* **[pex-parser](https://github.com/matortheeternal/pex-parser)** (Mator) — Papyrus script parser used by Merge Plugins' script relinking.
* **[BSA Browser](https://github.com/AlexxEG/BSA_Browser)** (AlexxEG) — CLI utility used for Bethesda archive extraction (BSA/BA2).
* **[7-Zip](https://www.7-zip.org/)** — Bundled archive extraction utility.
* **[sharp](https://github.com/lovell/sharp)** and **[oxipng](https://github.com/oxipng/oxipng)** — Image optimization tools for release assets (`scripts/compress-image.js`).
* **[Node.js](https://nodejs.org/)** — JavaScript runtime powering the application.

Full licensing details and third-party attributions are available in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
