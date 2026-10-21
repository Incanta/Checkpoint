<#
.SYNOPSIS
Builds the full Checkpoint Horde integration (server plugin + JobDriver with bundled CLI) in one step.

.DESCRIPTION
Cleans previous build outputs from artifacts/ (keeping any checkpoint-cli-*.zip), extracts the
prebuilt Checkpoint CLI zip, builds the server plugin into artifacts/server, and builds the
Checkpoint JobDriver with the CLI bundled into its tools/ folder at artifacts/jobdriver/JobDriver.
repack-agent.ps1 consumes that folder directly. Pass -Package to also produce the distributable
release zip via package-release.ps1.

The CLI zip is the CD artifact (e.g. checkpoint-cli-win32-x64.zip). Its contents are bundled
as-is: the CLI finds its daemon at <exeDir>/resources/daemon, so the layout needs no changes.
The CLI's platform must match the build agents' OS, not the machine running this script.

.PARAMETER EngineDir
Path to the Unreal Engine checkout root containing Horde source (e.g. E:/epic/engine/UE_Incanta).
Defaults to the HORDE_ENGINE_DIR environment variable.

.PARAMETER HordeVersion
Horde release the artifacts are built against (e.g. 5.8), used in the release zip name with
-Package. Defaults to the engine's Major.Minor version from Engine/Build/Build.version.

.PARAMETER CliZip
Prebuilt Checkpoint CLI zip to bundle. Defaults to artifacts/checkpoint-cli-win32-x64.zip.

.PARAMETER Package
Also bundle the outputs into checkpoint-horde-<clientVersion>_horde-<HordeVersion>.zip for
distribution to people who can't build from source.

.EXAMPLE
./scripts/build-release.ps1 -EngineDir E:/epic/engine/UE_Incanta
#>
param(
  [string]$EngineDir = $env:HORDE_ENGINE_DIR,
  [string]$HordeVersion = "",
  [string]$CliZip = "",
  [switch]$Package
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$artifactsDir = Join-Path $root "artifacts"

if (-not $EngineDir) {
  throw "EngineDir is required. Pass -EngineDir or set the HORDE_ENGINE_DIR environment variable."
}
if (-not (Test-Path $EngineDir)) { throw "Engine directory '$EngineDir' does not exist." }

if (-not $CliZip) { $CliZip = Join-Path $artifactsDir "checkpoint-cli-win32-x64.zip" }
if (-not (Test-Path $CliZip)) { throw "CLI zip not found at '$CliZip'." }
$CliZip = (Resolve-Path $CliZip).Path

# Derive the Horde version from the engine's Build.version when not given
if (-not $HordeVersion) {
  $buildVersionFile = Join-Path $EngineDir "Engine/Build/Build.version"
  if (-not (Test-Path $buildVersionFile)) {
    throw "No -HordeVersion given and '$buildVersionFile' not found."
  }
  $buildVersion = Get-Content $buildVersionFile -Raw | ConvertFrom-Json
  $HordeVersion = "$($buildVersion.MajorVersion).$($buildVersion.MinorVersion)"
}
Write-Host "Horde version: $HordeVersion"

# Clean previous outputs, keeping the CLI zip(s)
Write-Host "Cleaning $artifactsDir..."
New-Item -ItemType Directory -Force -Path $artifactsDir | Out-Null
Get-ChildItem $artifactsDir |
  Where-Object { $_.FullName -ne $CliZip -and $_.Name -notlike "checkpoint-cli-*.zip" } |
  Remove-Item -Recurse -Force

$cliStage = Join-Path $artifactsDir "cli-stage"
try {
  # Extract the CLI; the CD zip wraps everything in a single top-level folder
  Write-Host "Extracting $CliZip..."
  Expand-Archive -Path $CliZip -DestinationPath $cliStage -Force
  $cliDir = $cliStage
  $entries = @(Get-ChildItem $cliStage)
  if ($entries.Count -eq 1 -and $entries[0].PSIsContainer) { $cliDir = $entries[0].FullName }

  foreach ($required in @("checkpoint.exe", "resources/daemon/daemon-bundle.cjs")) {
    if (-not (Test-Path (Join-Path $cliDir $required))) {
      throw "CLI zip is missing '$required'; expected the CD checkpoint-cli layout."
    }
  }

  & (Join-Path $root "build.ps1") -HordeEngineDir $EngineDir
  & (Join-Path $root "jobdriver/build.ps1") -HordeEngineDir $EngineDir -CheckpointCliDir $cliDir
  if ($Package) {
    & (Join-Path $PSScriptRoot "package-release.ps1") -HordeVersion $HordeVersion
  }
}
finally {
  if (Test-Path $cliStage) { Remove-Item $cliStage -Recurse -Force }
}
