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

## BSA Browser (CLI)

**License: GPLv3.**

[`AlexxEG/BSA_Browser`](https://github.com/AlexxEG/BSA_Browser) provides the CLI this project shells
out to for Bethesda archive (BSA/BA2) extraction -- invoked as a separate process, not linked into
this project's own code, so GPLv3's copyleft obligations apply to BSA Browser itself, not to this
project. This project's copy is a local fork under active modernization
(`skyrim-modding/bsa-browser-revised`) -- credit stays with the original author regardless.

## 7-Zip

**License: GNU LGPL (the 7-Zip source/executables); the unRAR restriction in 7-Zip's own license
does not apply here -- this project only bundles the LGPL-covered parts.**

The `7z.exe` console binary is bundled for archive extraction. See [7-zip.org](https://www.7-zip.org/).

## Node.js

**License: MIT.**

A portable Node.js runtime is bundled in the release package so the app runs with nothing else to
install. See [nodejs.org](https://nodejs.org/).
