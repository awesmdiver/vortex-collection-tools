Merge Plugins patch — for Vortex Collection Tools v1.3.0
========================================================

WHAT THIS FIXES

Plugin filenames were being read using the wrong character encoding. Any master
file with an accented letter or a curly apostrophe in its name — Café.esp,
Bob's Mod.esp, Niflheim - Fjörm.esp — came out garbled.

Two things went wrong because of it:

  * Merge Plugins could write a merged plugin pointing at a master name that
    doesn't exist, because the name was mangled on the way in.
  * Missing Masters reported those mods as missing when they were sitting
    right there.

Plain-ASCII mod names were never affected. If none of your mods have accented
characters in their filenames, you weren't hitting this.


HOW TO APPLY IT

1. Close Vortex Collection Tools completely.

   Right-click its icon in your system tray (bottom-right of the screen, you
   may need to click the little arrow to see hidden icons) and choose Exit.

   If you run it from the portable zip instead, just close the black console
   window.

2. Find your installation folder.

   Installed with the installer:
       Press Windows+R, paste this in, and press Enter:
       %LOCALAPPDATA%\Programs\Vortex Collection Tools

   Portable zip:
       Wherever you unzipped it — the folder with start-server.bat in it.

3. Open the "lib" folder inside it.

4. Copy esp-header.js from this patch into that lib folder, replacing the
   file already there. Windows will ask you to confirm the replacement — say
   yes.

   If you'd like a safety net first, rename the existing esp-header.js to
   esp-header.js.backup before copying the new one in.

5. Start Vortex Collection Tools again.

That's everything. Nothing else needs changing, and your settings, paths and
backups are untouched.


HOW TO CHECK IT WORKED

Run Missing Masters. Any mod that was being reported missing purely because of
an accented character in its name should now show correctly.

If you were mid-way through a merge when you hit this, redo that merge — a
merged plugin created before the patch may still hold a mangled master name.


IF SOMETHING GOES WRONG

Put the original file back (that's what the .backup copy is for) and let us
know what happened.

    https://github.com/awesmdiver/vortex-collection-tools/issues
