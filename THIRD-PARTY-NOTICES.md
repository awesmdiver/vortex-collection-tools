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
