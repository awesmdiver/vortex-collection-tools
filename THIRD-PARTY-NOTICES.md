# Third-party notices

This project bundles the following third-party components. This file is required before any
release that ships `XEditLib.dll` (Merge Plugins / "The Forge", added for v1.1+) -- see
`TECHNICAL.md`'s "Merge engine" section for the full feasibility-spike writeup this is based on.

## XEditLib.dll / xedit-lib

**License: Mozilla Public License 1.1 (MPL-1.1).**

`XEditLib.dll` is compiled from [`matortheeternal/xedit-lib`](https://github.com/matortheeternal/xedit-lib),
the C API layer extracted from [xEdit](https://github.com/TES5Edit/TES5Edit) (itself licensed under
MPL-2.0) for programmatic use by tools like zEdit. Confirmed directly against that repository's own
`LICENSE` file (GitHub's automatic license detection reports this repo as "Other"/unrecognized, so
its badge alone can't be trusted -- the file's actual text is plain MPL-1.1).

MPL is a weak, file-level copyleft license: it permits combining MPL-covered files with
differently-licensed code (including this project's own code) in a "Larger Work" without requiring
the combined work to relicense under MPL. The MPL-covered source must stay available under MPL
terms -- already satisfied since it's public on GitHub at the link above.

## zEdit / zMerge (merge engine algorithm)

**License: MIT. Copyright (c) 2017 Colin Allen.**

Merge Plugins' v2 engine (`lib/merge-v2-worker.js`, `lib/merge-v2-runner.js`) is a direct algorithmic
port of the merge engine from [`z-edit/zedit`](https://github.com/z-edit/zedit) (zMerge), written by
Colin Allen (matortheeternal) -- confirmed against that repo's own `LICENSE` file and its
`package.json` (`"license": "MIT"`, v0.6.7). Built from `docs/plans/2026-08-24-merge-port-spec.md`,
which traces every ported behaviour to file:line in that source. This project's own fork of it,
`skyrim-modding/zedit-revised`, is a local copy under active modernization -- credit stays with the
original author regardless of how much local rework sits on top (same standing rule this project
already applies to BSA Browser and PGPatcher above).

MIT requires the copyright notice and this permission text travel with any substantial portion of
the software. Reproduced here in full:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction,
> including without limitation the rights to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
> NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
> DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
> OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

`lib/merge-v2-worker.js`'s own header comment names the specific zedit-revised source files each
phase was ported from, so the two stay traceable to each other for anyone reviewing either side later.

## xeditlib (Node.js wrapper)

**License: MIT.**

The Node.js FFI bindings this project uses to call `XEditLib.dll` (a pure-JS
[`koffi`](https://koffi.dev/)-based wrapper, no native compile step) are
[`WingedGuardian/xeditlib`](https://github.com/WingedGuardian/xeditlib), MIT licensed. Note: that
package's own README credits the bundled DLL itself as "MIT license" -- this is inaccurate for the
DLL (see above, it's MPL-1.1); the MIT statement is only correct for the wrapper's own JS code.

## koffi

**License: MIT.**

The FFI (foreign function interface) engine `xeditlib` uses to call into `XEditLib.dll` directly,
with no C++ compilation step required. See [koffi.dev](https://koffi.dev/).

## pex-parser

**License: MIT.**

[`matortheeternal/pex-parser`](https://github.com/matortheeternal/pex-parser) reads and rewrites
compiled Papyrus (`.pex`) scripts -- used by Merge Plugins' Relink Scripts feature to find and patch
script references to plugins that got merged away.

## ini-api

**License: MIT. Copyright Colin Allen (matortheeternal).**

[`matortheeternal/ini-api`](https://github.com/matortheeternal/ini-api) (npm `ini-api`) parses,
merges, and re-serializes per-plugin MCM `.ini` files for Merge Plugins v2's own INI Files asset
handler (`lib/merge/asset-handlers/ini-file-handler.js`) -- the SAME real library zMerge's own
`iniFileHandler.js` uses (its own `package.json` pins `ini-api: ^1.0.0`; this project uses the
current `^2.0.2`), same author as zMerge itself (see the "zEdit / zMerge" entry above).

## minimatch

**License: Blue Oak Model License 1.0.0** (confirmed against the installed package's own
`LICENSE.md` -- its `package.json` `"license"` field already says so too, not ISC as older
minimatch releases used).

[`isaacs/minimatch`](https://github.com/isaacs/minimatch) (npm `minimatch`) provides the real glob
matching the merge v2 asset handlers use throughout `lib/merge/asset-fs.js`/`asset-helpers.js`/
`bsa-container.js` -- the same library zMerge's own `fileHelpers.js`/`bsaHelpers.js` build their own
asset-discovery patterns on (its own `package.json` pins the older `minimatch: ^3.0.4`, itself ISC --
this project uses the current `^10.2.6`).

## BSA Browser (CLI)

**License: GPLv3.**

[`AlexxEG/BSA_Browser`](https://github.com/AlexxEG/BSA_Browser) provides the CLI this project shells
out to for Bethesda archive (BSA/BA2) extraction -- invoked as a separate process, not linked into
this project's own code, so GPLv3's copyleft obligations apply to BSA Browser itself, not to this
project. This project's copy is a local fork under active modernization
(`skyrim-modding/bsa-browser-revised`) -- credit stays with the original author regardless.

## PGPatcher (pgtools.exe)

**License: GNU GPLv3.**

`pgtools.exe` (the headless CLI backend for the PGPatcher Load Order Editor) is compiled from
[`hakasapl/PGPatcher`](https://github.com/hakasapl/PGPatcher) via this project's own fork,
[`awesmdiver/PGPatcher`](https://github.com/awesmdiver/PGPatcher) (source lives alongside this
project's workspace at `skyrim-modding/pgpatcher-fork`). Unlike BSA Browser above, this is invoked as
a separate process too, but the compiled binary is bundled DIRECTLY inside this project's own release
zip (`tools/pgtools/`) rather than downloaded fresh from the original author's own releases at
runtime -- a heavier distribution event than BSA Browser's, and specifically what triggers this
entry.

- **Full GPLv3 text** is bundled alongside the binary itself at `tools/pgtools/LICENSE`, mirroring
  this project's existing practice for 7-Zip's own License.txt below.
- **Credit**: hakasapl, original author, regardless of how much local modification sits on top --
  same standing rule this project already applies to BSA Browser.
- **Corresponding Source**: the fork is public, satisfying GPLv3's source-availability requirement,
  ***provided the exact commit each shipped binary was built from is actually pushed there before
  that release goes out*** -- flagged explicitly in this change's own handoff as a real, unresolved
  compliance gap as of this writing (the fork's `main` was 2 commits ahead of its own public
  `origin/main` when this entry was written), not something to assume is already true.
- **Modifications**: this fork DOES modify the original (a shared patcher-registration refactor, a
  `--relax-weight-validation` CLI flag, a rotating file-sink logger, and this project's own
  `initLogger()`/CLI additions to the `PGTools` subproject specifically) -- GPLv3 Section 5's
  "carry prominent notices stating that you modified it" requirement applies here, not just Section
  6's object-code-conveyance requirements for an unmodified binary. Not resolved by this entry alone
  -- flagged in the handoff for real legal-language review rather than guessed at here.

## 7-Zip

**License: GNU LGPL (the 7-Zip source/executables); the unRAR restriction in 7-Zip's own license
does not apply here -- this project only bundles the LGPL-covered parts.**

The `7z.exe` console binary is bundled for archive extraction. See [7-zip.org](https://www.7-zip.org/).

## sharp

**License: Apache-2.0.**

[`lovell/sharp`](https://github.com/lovell/sharp) (npm `sharp`, currently `^0.35.3`) resizes and
re-saves the release banner art in `scripts/compress-image.js` -- resize to a max width (never
upscaling) + a lossless PNG re-save at max compression, palette-forcing off so full color depth is
kept.

## oxipng

**License: MIT.**

[`oxipng/oxipng`](https://github.com/oxipng/oxipng) re-encodes those same pixels (genuinely
lossless -- not one pixel changes) with a slower/better DEFLATE strategy for extra size reduction,
also in `scripts/compress-image.js`. The Windows binary is auto-downloaded from oxipng's GitHub
releases on first use and lives at `tools/oxipng/oxipng.exe`, gitignored -- not vendored in the repo,
same pattern this project already uses for `tools/7-Zip/7z.exe`.

## FallrimTools ReSaver (ReSaver_Renewed.exe)

**License: Apache 2.0.**

`ReSaver_Renewed.exe` (the save-parsing/editing engine behind Save Cleaner) is compiled from a
community-maintained, modernized fork of [`mdfairch/FallrimTools`](https://github.com/mdfairch/FallrimTools)
by Mark Fairchild -- the original save-file editor for Skyrim (LE/SE/VR) and Fallout 4. This project's
own fork, `fallrimtools-resaver-renewed` (source lives alongside this project's workspace at
`skyrim-modding/fallrimtools-resaver-renewed`), adds headless CLI entry points this app calls directly.
Same shape as PGPatcher above -- the compiled binary is bundled directly inside this project's own
release zip (`tools/resaver-renewed/`) rather than downloaded fresh at runtime -- but Apache 2.0 is
permissive, not copyleft, so there's no license-compatibility concern to note beyond crediting the
original author, which stays with Mark Fairchild regardless of how much local modernization sits on
top.

## Node.js

**License: MIT.**

A portable Node.js runtime is bundled in the release package so the app runs with nothing else to
install. See [nodejs.org](https://nodejs.org/).
