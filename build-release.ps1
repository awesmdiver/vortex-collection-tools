# Builds the self-contained release zip (VortexCollectionTools-v<version>-win-x64.zip) -- bundles a
# portable Node.js runtime and the 7-Zip console binaries alongside this project's own tracked files
# and a clean production node_modules, so a downloader can just unzip and double-click
# start-server.bat with nothing else installed. Mirrors exactly what start-server.bat itself expects
# (node\node.exe, tools\7-Zip\7z.exe -- see lib/sevenzip.js's own bundled-path check) and what
# README.md tells users to expect ("comes with everything bundled").
#
# Source file list comes from `git ls-files` -- anything gitignored (config.json, logs/, the
# archived terminal-flow-archive/, etc.) is correctly excluded automatically, no separate exclude
# list to keep in sync.
#
# Usage:
#   .\build-release.ps1                                  # bundles whatever's CURRENTLY latest
#   .\build-release.ps1 -NodeVersion 24.18.0 -SevenZipRelease 26.02   # pin explicitly if ever needed
#
# Node/7-Zip versions default to "whatever is latest right now" (queried live), NOT a hardcoded
# string -- a hardcoded default here would go stale exactly the way this whole script exists to
# prevent. Pass either param explicitly to pin a specific version instead (e.g. to reproduce an
# older release exactly).
#
# Requires: git, npm, and an internet connection. Nothing else needs to be pre-installed -- see the
# 7-Zip section below for how it avoids needing 7-Zip itself to unpack 7-Zip.

param(
    [string]$NodeVersion,
    [string]$SevenZipRelease
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$version = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
$releaseName = "VortexCollectionTools-v$version-win-x64"
$work = Join-Path $env:TEMP "vct-release-build"
$stageDir = Join-Path $work $releaseName

if (-not $NodeVersion) {
    Write-Host "No -NodeVersion given -- looking up the current Node.js LTS..."
    $nodeIndex = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json"
    $NodeVersion = ($nodeIndex | Where-Object { $_.lts } | Select-Object -First 1).version -replace '^v', ''
}
if (-not $SevenZipRelease) {
    Write-Host "No -SevenZipRelease given -- looking up the current 7-Zip release..."
    $ghRelease = Invoke-RestMethod -Uri "https://api.github.com/repos/ip7z/7zip/releases/latest" -Headers @{ "User-Agent" = "vortex-collection-tools-build-release" }
    $SevenZipRelease = $ghRelease.tag_name
}

Write-Host "Building $releaseName (bundling Node v$NodeVersion, 7-Zip $SevenZipRelease)..."

if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

# 1. Copy every git-tracked file -- same set as what's actually in the repo, no separate list to
#    keep in sync with .gitignore.
Write-Host "Copying tracked source files..."
Push-Location $root
$files = git ls-files
Pop-Location
foreach ($f in $files) {
    $dest = Join-Path $stageDir $f
    $destDir = Split-Path $dest -Parent
    if ($destDir -and !(Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
    Copy-Item (Join-Path $root $f) $dest -Force
}

# 2. Clean production install, matching package-lock.json exactly (npm ci, not install).
Write-Host "Running npm ci --omit=dev in the staged copy..."
Push-Location $stageDir
npm ci --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
Pop-Location

# 3. Bundle a portable Node.js runtime -- only node.exe is actually needed (start-server.bat never
#    calls npm from the bundled copy; node_modules already ships pre-installed), but the LICENSE
#    comes along too for attribution.
Write-Host "Downloading Node.js v$NodeVersion..."
$nodeZipUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
$nodeZipPath = Join-Path $work "node.zip"
Invoke-WebRequest -Uri $nodeZipUrl -OutFile $nodeZipPath
Expand-Archive -Path $nodeZipPath -DestinationPath $work -Force
$extractedNodeDir = Join-Path $work "node-v$NodeVersion-win-x64"
$bundledNodeDir = Join-Path $stageDir "node"
New-Item -ItemType Directory -Path $bundledNodeDir -Force | Out-Null
Copy-Item (Join-Path $extractedNodeDir "node.exe") (Join-Path $bundledNodeDir "node.exe") -Force
$nodeLicense = Join-Path $extractedNodeDir "LICENSE"
if (Test-Path $nodeLicense) { Copy-Item $nodeLicense (Join-Path $bundledNodeDir "LICENSE") -Force }

# 4. Bundle the 7-Zip console binaries (7z.exe + 7z.dll) -- lib/sevenzip.js checks
#    tools/7-Zip/7z.exe FIRST, before any system-installed 7-Zip. These two files specifically (not
#    the lighter 7za.exe/7za.dll from 7-Zip's standalone "extra" download package, which drops RAR
#    support and other codecs) only ship via the real installer. Assumes NOTHING is pre-installed on
#    the machine running this script (no 7-Zip, nothing) -- downloads the official MSI and extracts
#    it via `msiexec /a` (an "administrative install": just unpacks files to a folder, installs/
#    registers nothing), which is built into every Windows install, so no chicken-and-egg problem.
Write-Host "Downloading 7-Zip $SevenZipRelease (official MSI)..."
$sevenZipMsiUrl = "https://github.com/ip7z/7zip/releases/download/$SevenZipRelease/7z$($SevenZipRelease -replace '\.','')-x64.msi"
$sevenZipMsiPath = Join-Path $work "7zip.msi"
Invoke-WebRequest -Uri $sevenZipMsiUrl -OutFile $sevenZipMsiPath
$sevenZipExtractDir = Join-Path $work "7z-msi-extract"
$msiLog = Join-Path $work "7z-msi-extract.log"
$proc = Start-Process msiexec.exe -ArgumentList "/a `"$sevenZipMsiPath`" /qn TARGETDIR=`"$sevenZipExtractDir`" /log `"$msiLog`"" -Wait -PassThru
if ($proc.ExitCode -ne 0) { throw "msiexec /a extraction of the 7-Zip MSI failed (exit $($proc.ExitCode)) -- see $msiLog" }
$sevenZipFilesDir = Join-Path $sevenZipExtractDir "Files\7-Zip"
if (!(Test-Path (Join-Path $sevenZipFilesDir "7z.exe")) -or !(Test-Path (Join-Path $sevenZipFilesDir "7z.dll"))) {
    throw "Could not find 7z.exe/7z.dll after extracting the 7-Zip MSI -- its internal layout may have changed."
}
$bundledSevenZipDir = Join-Path $stageDir "tools\7-Zip"
New-Item -ItemType Directory -Path $bundledSevenZipDir -Force | Out-Null
Copy-Item (Join-Path $sevenZipFilesDir "7z.exe") (Join-Path $bundledSevenZipDir "7z.exe") -Force
Copy-Item (Join-Path $sevenZipFilesDir "7z.dll") (Join-Path $bundledSevenZipDir "7z.dll") -Force
$sevenZipLicense = Join-Path $sevenZipFilesDir "License.txt"
if (Test-Path $sevenZipLicense) { Copy-Item $sevenZipLicense (Join-Path $bundledSevenZipDir "License.txt") -Force }

# 5. START HERE.txt -- plain-language quick start, referenced by README.md and the release notes.
@"
Vortex Collection Tools -- Quick Start
=======================================

1. Close Vortex completely.
2. Double-click start-server.bat.
3. Your browser opens to the app automatically. First time through, it'll ask you to set your
   staging/downloads folders under Settings -- do that once and you're set.

That's it -- Node.js and 7-Zip are both already included in this folder, so there's nothing else
to install.

When you're done, close the console window that opened alongside the app (that's the server;
closing it stops the app).

Found a problem, or have feedback? Please open an issue on GitHub:
https://github.com/awesmdiver/vortex-collection-tools/issues
Include what you were doing, what you expected, and what actually happened -- a screenshot helps
a lot.

Full details (what each tool does, command-line usage, troubleshooting): see README.md and
TECHNICAL.md in this folder.
"@ | Set-Content (Join-Path $stageDir "START HERE.txt") -Encoding UTF8

# 6. Zip it into github-releases/ (never loose at the project root -- see docs/DESIGN-GUIDE.md's
#    "Release packaging" section for why it's named that and not "release(s)").
Write-Host "Creating zip..."
$releasesDir = Join-Path $root "github-releases"
New-Item -ItemType Directory -Path $releasesDir -Force | Out-Null
$outZip = Join-Path $releasesDir "$releaseName.zip"
if (Test-Path $outZip) { Remove-Item $outZip -Force }
Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $outZip -CompressionLevel Optimal

Write-Host "Built: $outZip"
Write-Host "Staged (uncompressed) copy left at: $stageDir -- safe to delete."
