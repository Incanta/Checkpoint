<#
.SYNOPSIS
Builds the Checkpoint Horde integration (server plugin + API client).

.DESCRIPTION
Builds HordeServer.Checkpoint.dll and Checkpoint.Api.dll against the Horde source in an
Unreal Engine checkout. The engine checkout is located via -HordeEngineDir, the
HORDE_ENGINE_DIR environment variable, or must otherwise be provided.

Use jobdriver/build.ps1 to produce the patched JobDriver for agents.

.PARAMETER HordeEngineDir
Path to the Unreal Engine checkout root (e.g. E:/epic/engine/UE_Incanta).

.PARAMETER Configuration
Build configuration, Debug or Release. Defaults to Release.
#>
param(
  [string]$HordeEngineDir = $env:HORDE_ENGINE_DIR,
  [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

if (-not $HordeEngineDir) {
  throw "HordeEngineDir is required. Pass -HordeEngineDir or set the HORDE_ENGINE_DIR environment variable."
}
if (-not (Test-Path (Join-Path $HordeEngineDir "Engine/Source/Programs/Horde"))) {
  throw "No Horde source found under '$HordeEngineDir'. Expected Engine/Source/Programs/Horde."
}
$env:HORDE_ENGINE_DIR = $HordeEngineDir

# Prefer a system dotnet 10+; fall back to the SDK bundled with the engine
$dotnet = "dotnet"
$sdkOk = $false
try {
  $sdks = & dotnet --list-sdks 2>$null
  $sdkOk = [bool]($sdks | Where-Object { $_ -match "^(1[0-9])\." })
} catch { }
if (-not $sdkOk) {
  $bundled = Join-Path $HordeEngineDir "Engine/Binaries/ThirdParty/DotNet/10.0/win-x64/dotnet.exe"
  if (Test-Path $bundled) {
    $dotnet = $bundled
  } else {
    throw "No .NET 10+ SDK found on PATH or bundled with the engine."
  }
}

Write-Host "Using dotnet: $dotnet"
Write-Host "Horde engine dir: $HordeEngineDir"

& $dotnet build (Join-Path $root "src/HordeServer.Checkpoint/HordeServer.Checkpoint.csproj") -c $Configuration
if ($LASTEXITCODE -ne 0) { throw "Build failed" }

# Collect the server artifact: just our two assemblies (Horde provides everything else)
$outDir = Join-Path $root "artifacts/server"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$binDir = Join-Path $root "src/HordeServer.Checkpoint/bin/$Configuration/net10.0"
Copy-Item (Join-Path $binDir "HordeServer.Checkpoint.dll") $outDir -Force
Copy-Item (Join-Path $binDir "Checkpoint.Api.dll") $outDir -Force

Write-Host "Server plugin artifacts written to $outDir"
