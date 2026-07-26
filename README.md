# Vortex Collection Tools

![Vortex Collection Tools](assets/banner.png)

A toolkit for managing your Vortex-installed Skyrim SE mod collections, with a simple web page you
run locally — nothing is sent anywhere else. It covers two jobs:

- **Rebuild Collection** — if a collection's mods have gotten corrupted, gone missing, or you just
  want a much faster full reinstall than Vortex's own "Resume" step, this re-extracts everything
  directly from your downloaded mod archives and puts it back the way it should be.
- **Update Collection** — when you update a collection in Vortex, it forgets which mods you'd
  marked as Ignored or Disabled. This restores that for you, so you don't have to redo it by hand
  every single update.

## Getting a release without installing anything

Grab the zip from the [Releases page](../../releases). It comes with everything bundled — its own
copy of Node.js and 7-Zip — so there's nothing else to install:

1. Download the zip from the latest release and unzip it anywhere.
2. Close Vortex.
3. Double-click `start-server.bat`.
4. Your browser opens to the app automatically. First time through, it'll ask you to set your
   staging/downloads folders under **Settings** — do that once and you're set.

No Node.js, no 7-Zip, no command line. When you're done, just close the console window that opened
alongside it (that's the server; closing it stops the app). Full instructions are also in
`START HERE.txt` inside the zip.

## A few things worth knowing

- **Vortex needs to be fully closed** before running either tool.
- After you have rebuilt a collection, Vortex will likely show an **"External Changes"** prompt the
  next time you open it, for anything that got rebuilt. That's expected — go ahead and click
  through it ("Use newer file" / "Save all changes").
- **Update Collection writes directly to Vortex's database.** It takes a full backup automatically
  before every write, but keeping a second, independent backup of your own never hurts.

## Found a problem, or have feedback?

Please open an issue on GitHub — include what you were doing, what you expected, and what actually
happened (a screenshot helps a lot).

## Want to dig into the technical details?

Building from source, command-line usage, how things work under the hood, and the project's
internals all live in [`TECHNICAL.md`](TECHNICAL.md).
