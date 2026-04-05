# build-daemon-sea.ps1 — Build Checkpoint Daemon as a Node.js Single Executable Application
# Usage: .\scripts\build-daemon-sea.ps1 [-OutputDir <path>]
#
# Requires: Node.js 22+, yarn, esbuild, postject

param(
    [string]$OutputDir
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir
$DaemonDir = Join-Path $RootDir "src\core\daemon"

if (-not $OutputDir) {
    $OutputDir = Join-Path $DaemonDir "dist-sea"
}

$Version = (Get-Content (Join-Path $RootDir "VERSION") -Raw).Trim()

Write-Host "=== Building Checkpoint Daemon SEA v${Version} (win32-x64) ===" -ForegroundColor Cyan

# Step 1: Build TypeScript
Write-Host "[1/5] Building TypeScript..." -ForegroundColor Yellow
Push-Location $DaemonDir
yarn build
Pop-Location

# Step 2: Bundle with esbuild
Write-Host "[2/5] Bundling with esbuild..." -ForegroundColor Yellow
Push-Location $DaemonDir
node esbuild.config.mjs
Pop-Location

# Step 3: Generate SEA blob
Write-Host "[3/5] Generating SEA blob..." -ForegroundColor Yellow
Push-Location $DaemonDir
node --experimental-sea-config sea-config.json
Pop-Location

# Step 4: Copy Node.js binary and inject SEA blob
Write-Host "[4/5] Creating SEA binary..." -ForegroundColor Yellow
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

$BinaryName = "checkpoint-daemon.exe"
$NodeBin = (Get-Command node).Source

Copy-Item $NodeBin (Join-Path $OutputDir $BinaryName) -Force

# Inject the SEA blob
$BlobPath = Join-Path $DaemonDir "daemon-sea.blob"
npx postject (Join-Path $OutputDir $BinaryName) NODE_SEA_BLOB $BlobPath `
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

# Step 5: Copy longtail addon
Write-Host "[5/5] Copying longtail native addon..." -ForegroundColor Yellow
$AddonDir = Join-Path $RootDir "src\longtail\addon"
$PrebuiltSrc = Join-Path $AddonDir "prebuilds\win32-x64\longtail_addon.node"

$LibDir = Join-Path $OutputDir "lib"
New-Item -ItemType Directory -Path $LibDir -Force | Out-Null

if (Test-Path $PrebuiltSrc) {
    Copy-Item $PrebuiltSrc (Join-Path $LibDir "longtail_addon.node") -Force
    Write-Host "Copied longtail addon from prebuilds\win32-x64"
} else {
    Write-Warning "Longtail addon not found at $PrebuiltSrc"
    Write-Warning "The daemon will not function without the native addon."
}

# Copy VERSION file
Copy-Item (Join-Path $RootDir "VERSION") (Join-Path $OutputDir "VERSION") -Force

Write-Host ""
Write-Host "=== Daemon SEA build complete ===" -ForegroundColor Green
Write-Host "Output: $(Join-Path $OutputDir $BinaryName)"
Get-ChildItem $OutputDir | Format-Table Name, Length -AutoSize
