# build-daemon-sea.ps1: Build Checkpoint Daemon as a Node.js Single Executable Application
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

# Source of truth for versions is versions.json (client_version is the
# user-facing desktop/daemon semver).
$Version = (Get-Content (Join-Path $RootDir "versions.json") -Raw | ConvertFrom-Json).client_version

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
$BinaryPath = Join-Path $OutputDir $BinaryName
$NodeBin = (Get-Command node).Source

Copy-Item $NodeBin $BinaryPath -Force

# Remove the Authenticode signature inherited from the official node.exe before
# injecting the SEA blob. Node's SEA docs require this on Windows: leaving the
# signature in place leaves a dangling certificate table, so a later re-sign
# (e.g. electron-builder's Azure Trusted Signing) fails with SignTool error
# 0x800700C1 (bad EXE format). This mirrors the codesign --remove-signature
# step the Unix build script does on macOS.
$signtool = Get-ChildItem -Path "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter "signtool.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\x64\\" } |
    Sort-Object FullName -Descending |
    Select-Object -First 1
if ($null -ne $signtool) {
    Write-Host "Removing inherited node.exe signature using $($signtool.FullName)"
    try {
        & $signtool.FullName remove /s $BinaryPath
    } catch {
        # node.exe ships signed, so this should succeed; tolerate an
        # already-unsigned binary rather than failing the build.
        Write-Warning "signtool remove reported: $_; continuing"
    }
    $global:LASTEXITCODE = 0
} else {
    Write-Warning "signtool.exe not found; skipping signature removal. Re-signing the daemon may fail with 0x800700C1."
}

# Inject the SEA blob
$BlobPath = Join-Path $DaemonDir "daemon-sea.blob"
npx postject $BinaryPath NODE_SEA_BLOB $BlobPath `
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

# Step 5: Copy longtail addon
Write-Host "[5/5] Copying longtail native addon..." -ForegroundColor Yellow
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

# Write VERSION file (consumed by the daemon's runtime version fallback in
# updater.ts) from the versions.json client_version resolved above.
Set-Content -Path (Join-Path $OutputDir "VERSION") -Value $Version -NoNewline

Write-Host ""
Write-Host "=== Daemon SEA build complete ===" -ForegroundColor Green
Write-Host "Output: $(Join-Path $OutputDir $BinaryName)"
Get-ChildItem $OutputDir | Format-Table Name, Length -AutoSize
