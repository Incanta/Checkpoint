<#
.SYNOPSIS
Repacks a stock Horde agent tool zip with the Checkpoint-extended JobDriver.

.DESCRIPTION
Horde agents install/upgrade from a server-hosted tool zip and replace their entire install
directory on upgrade, so the Checkpoint JobDriver must be baked into that zip. This script takes
the stock agent zip (download it from your Horde server's tools page, e.g. tool id
horde-agent-win-x64), swaps its JobDriver folder for the Checkpoint build produced by
jobdriver/build.ps1, and writes a new zip ready for deploy-tool.ps1.

Re-run this against the new stock zip after every Horde server upgrade.

.PARAMETER AgentZip
Path to the stock horde-agent tool zip.

.PARAMETER JobDriverDir
Path to the Checkpoint JobDriver folder (default: ../artifacts/jobdriver/JobDriver).

.PARAMETER OutZip
Path for the repacked zip (default: alongside AgentZip with a -checkpoint suffix).
#>
param(
  [Parameter(Mandatory = $true)][string]$AgentZip,
  [string]$JobDriverDir = (Join-Path $PSScriptRoot "../artifacts/jobdriver/JobDriver"),
  [string]$OutZip = ""
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $AgentZip)) { throw "Agent zip not found: $AgentZip" }
if (-not (Test-Path (Join-Path $JobDriverDir "JobDriver.dll"))) {
  throw "No Checkpoint JobDriver build found at '$JobDriverDir'. Run jobdriver/build.ps1 first."
}
if (-not $OutZip) {
  $OutZip = [System.IO.Path]::ChangeExtension($AgentZip, $null).TrimEnd('.') + "-checkpoint.zip"
}

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("horde-agent-repack-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempDir | Out-Null

try {
  Write-Host "Extracting $AgentZip..."
  Expand-Archive -Path $AgentZip -DestinationPath $tempDir

  $driverDest = Join-Path $tempDir "JobDriver"
  if (-not (Test-Path $driverDest)) {
    Write-Warning "The agent zip does not contain a JobDriver folder at its root; adding one anyway."
  } else {
    Remove-Item $driverDest -Recurse -Force
  }

  Write-Host "Injecting Checkpoint JobDriver..."
  Copy-Item $JobDriverDir $driverDest -Recurse

  if (Test-Path $OutZip) { Remove-Item $OutZip -Force }
  Write-Host "Writing $OutZip..."
  Compress-Archive -Path (Join-Path $tempDir "*") -DestinationPath $OutZip

  Write-Host "Done. Deploy with scripts/deploy-tool.ps1 -Zip `"$OutZip`""
}
finally {
  Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
