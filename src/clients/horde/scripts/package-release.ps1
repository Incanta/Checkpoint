<#
.SYNOPSIS
Packages the Checkpoint Horde integration release artifact.

.DESCRIPTION
Bundles the server plugin DLLs and the Checkpoint JobDriver (plus the agent repack/deploy
scripts and docs) into a single versioned zip: checkpoint-horde-<clientVersion>_horde-<HordeVersion>.zip.
Run build.ps1 and jobdriver/build.ps1 first.

.PARAMETER HordeVersion
Horde release the artifacts were built against (e.g. 5.8). Required for the artifact name.
#>
param(
  [Parameter(Mandatory = $true)][string]$HordeVersion
)

$ErrorActionPreference = "Stop"
$root = Join-Path $PSScriptRoot ".."

$serverDir = Join-Path $root "artifacts/server"
$driverDir = Join-Path $root "artifacts/jobdriver/JobDriver"
if (-not (Test-Path (Join-Path $serverDir "HordeServer.Checkpoint.dll"))) { throw "Server artifacts missing; run build.ps1 first." }
if (-not (Test-Path (Join-Path $driverDir "JobDriver.dll"))) { throw "JobDriver artifacts missing; run jobdriver/build.ps1 first." }

$versions = Get-Content (Join-Path $root "../../../versions.json") | ConvertFrom-Json
$version = $versions.client_version

$stageDir = Join-Path $root "artifacts/release-stage"
if (Test-Path $stageDir) { Remove-Item $stageDir -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $stageDir "server") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stageDir "scripts") | Out-Null

Copy-Item (Join-Path $serverDir "*") (Join-Path $stageDir "server") -Recurse
Copy-Item $driverDir (Join-Path $stageDir "JobDriver") -Recurse
Copy-Item (Join-Path $PSScriptRoot "repack-agent.ps1") (Join-Path $stageDir "scripts")
Copy-Item (Join-Path $PSScriptRoot "deploy-tool.ps1") (Join-Path $stageDir "scripts")
Copy-Item (Join-Path $root "README.md") $stageDir

$zipName = "checkpoint-horde-${version}_horde-$HordeVersion.zip"
$zipPath = Join-Path $root "artifacts/$zipName"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $zipPath
Remove-Item $stageDir -Recurse -Force

Write-Host "Release artifact written to $zipPath"
