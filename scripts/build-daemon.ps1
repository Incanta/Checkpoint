# build-daemon.ps1: Build the Checkpoint Daemon as an esbuild-bundled JS app run
# by a portable Node.js runtime (this replaces the Node Single Executable
# Application approach, which proved unreliable).
#
# The output directory contains:
#   checkpoint-daemon.exe    a portable node.exe, renamed
#   daemon-bundle.cjs        the esbuild-bundled daemon, executed by that node
#   lib\longtail_addon.node  the longtail native addon
#   node_modules\...         better-sqlite3 (+ its native deps)
#   VERSION                  the client version string
#
# Launchers run the daemon with: checkpoint-daemon.exe daemon-bundle.cjs
# Keeping the runtime named checkpoint-daemon.exe preserves the process name the
# tray relies on (e.g. `taskkill /im checkpoint-daemon.exe`).
#
# Requires: Node.js 22+, yarn, esbuild
#
# Usage: .\scripts\build-daemon.ps1 [-OutputDir <path>] [-NodeVersion <vX.Y.Z>]

param(
    [string]$OutputDir,
    [string]$NodeVersion = $(if ($env:CHECKPOINT_NODE_VERSION) { $env:CHECKPOINT_NODE_VERSION } else { "v24.17.0" })
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir
$DaemonDir = Join-Path $RootDir "src\core\daemon"

if (-not $OutputDir) {
    $OutputDir = Join-Path $DaemonDir "dist-daemon"
}

# Source of truth for versions is versions.json (client_version is the
# user-facing desktop/daemon semver).
$Version = (Get-Content (Join-Path $RootDir "versions.json") -Raw | ConvertFrom-Json).client_version

Write-Host "=== Building Checkpoint Daemon v${Version} (win32-x64, node ${NodeVersion}) ===" -ForegroundColor Cyan

# Step 1: Build TypeScript
Write-Host "[1/6] Building TypeScript..." -ForegroundColor Yellow
Push-Location $DaemonDir
yarn build
Pop-Location

# Step 2: Bundle with esbuild
Write-Host "[2/6] Bundling with esbuild..." -ForegroundColor Yellow
Push-Location $DaemonDir
node esbuild.config.mjs
Pop-Location

# Step 3: Download the portable Node.js runtime and rename it to checkpoint-daemon.exe
Write-Host "[3/6] Downloading portable Node.js ${NodeVersion}..." -ForegroundColor Yellow
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

$BinaryName = "checkpoint-daemon.exe"
$BinaryPath = Join-Path $OutputDir $BinaryName
$NodeDist = "node-$NodeVersion-win-x64"
$NodeUrl = "https://nodejs.org/dist/$NodeVersion/$NodeDist.zip"

$TmpBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$TmpDir = Join-Path $TmpBase ("node-" + [System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null

$ZipPath = Join-Path $TmpDir "node.zip"
Invoke-WebRequest -Uri $NodeUrl -OutFile $ZipPath
Expand-Archive -Path $ZipPath -DestinationPath $TmpDir -Force
Copy-Item (Join-Path $TmpDir "$NodeDist\node.exe") $BinaryPath -Force
Remove-Item -Recurse -Force $TmpDir

# Step 4: Copy the daemon bundle next to the runtime
Write-Host "[4/6] Copying daemon bundle..." -ForegroundColor Yellow
Copy-Item (Join-Path $DaemonDir "daemon-bundle.cjs") (Join-Path $OutputDir "daemon-bundle.cjs") -Force

# Step 5: Copy longtail addon
Write-Host "[5/6] Copying longtail native addon..." -ForegroundColor Yellow
$AddonPkgDir = node -e "console.log(require('path').dirname(require.resolve('@checkpointvcs/longtail-addon/package.json')))"
$PrebuiltSrc = Join-Path $AddonPkgDir "prebuilds\win32-x64\longtail_addon.node"

$LibDir = Join-Path $OutputDir "lib"
New-Item -ItemType Directory -Path $LibDir -Force | Out-Null

if (Test-Path $PrebuiltSrc) {
    Copy-Item $PrebuiltSrc (Join-Path $LibDir "longtail_addon.node") -Force
    Write-Host "Copied longtail addon from prebuilds\win32-x64"
} else {
    Write-Warning "Longtail addon not found at $PrebuiltSrc"
    Write-Warning "The daemon will not function without the native addon."
}

# Step 6: Copy better-sqlite3 (+ its native deps) next to the runtime so the
# bundle can require it at runtime (it is external to the JS bundle; see
# esbuild.config.mjs). Then write the VERSION file consumed by updater.ts.
Write-Host "[6/6] Copying runtime node_modules..." -ForegroundColor Yellow
node (Join-Path $RootDir "scripts\copy-daemon-node-modules.mjs") $OutputDir
Set-Content -Path (Join-Path $OutputDir "VERSION") -Value $Version -NoNewline

Write-Host ""
Write-Host "=== Daemon build complete ===" -ForegroundColor Green
Write-Host "Output: $BinaryPath"
Get-ChildItem $OutputDir | Format-Table Name, Length -AutoSize
