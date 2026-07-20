<#
.SYNOPSIS
Builds the Checkpoint-extended Horde JobDriver.

.DESCRIPTION
The JobDriver's materializer registry is compiled in (no plugin loading), so Checkpoint support
requires rebuilding it with two small patches plus the Checkpoint materializer sources. This script
patches the stock JobDriver source in the engine checkout IN PLACE, publishes it, and then restores
the original files, so the engine tree is left untouched. The patches applied are documented in
patches/*.patch.

Output: artifacts/jobdriver/JobDriver (a drop-in replacement for the agent's JobDriver folder).

.PARAMETER HordeEngineDir
Path to the Unreal Engine checkout root (e.g. E:/epic/engine/UE_Incanta).

.PARAMETER Configuration
Build configuration. Defaults to Release.

.PARAMETER CheckpointCliDir
Optional directory containing checkpoint.exe (and optionally a daemon bundle) to embed into the
driver's tools/ folder so agents need no separate CLI install.
#>
param(
  [string]$HordeEngineDir = $env:HORDE_ENGINE_DIR,
  [string]$Configuration = "Release",
  [string]$CheckpointCliDir = ""
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

if (-not $HordeEngineDir) {
  throw "HordeEngineDir is required. Pass -HordeEngineDir or set the HORDE_ENGINE_DIR environment variable."
}
$driverDir = Join-Path $HordeEngineDir "Engine/Source/Programs/Horde/Drivers/JobDriver"
if (-not (Test-Path (Join-Path $driverDir "JobDriver.csproj"))) {
  throw "No JobDriver source found at '$driverDir'."
}

# Locate a .NET 10+ SDK (system or engine-bundled)
$dotnet = "dotnet"
$sdkOk = $false
try {
  $sdks = & dotnet --list-sdks 2>$null
  $sdkOk = [bool]($sdks | Where-Object { $_ -match "^(1[0-9])\." })
} catch { }
if (-not $sdkOk) {
  $bundled = Join-Path $HordeEngineDir "Engine/Binaries/ThirdParty/DotNet/10.0/win-x64/dotnet.exe"
  if (Test-Path $bundled) { $dotnet = $bundled } else { throw "No .NET 10+ SDK found." }
}

function Apply-Patch {
  param([string]$File, [string]$Pattern, [string]$Replacement, [string]$AlreadyAppliedMarker)

  $content = [System.IO.File]::ReadAllText($File)
  if ($content.Contains($AlreadyAppliedMarker)) {
    Write-Host "  $([System.IO.Path]::GetFileName($File)): already patched"
    return
  }
  $newContent = [regex]::Replace($content, $Pattern, $Replacement)
  if ($newContent -eq $content) {
    throw "Patch anchor not found in $File. The Horde version may have changed; update jobdriver/build.ps1 and patches/*.patch to match."
  }
  [System.IO.File]::WriteAllText($File, $newContent)
  Write-Host "  $([System.IO.Path]::GetFileName($File)): patched"
}

$driverAppFile = Join-Path $driverDir "DriverApp.cs"
$conformFile = Join-Path $driverDir "Execution/ConformExecutor.cs"
$injectedFiles = @()
$backups = @{}

try {
  # Back up files we modify
  foreach ($file in @($driverAppFile, $conformFile)) {
    $backups[$file] = [System.IO.File]::ReadAllText($file)
  }

  # Inject the Checkpoint materializer sources
  foreach ($src in (Get-ChildItem (Join-Path $root "src/Execution") -Filter *.cs)) {
    $dest = Join-Path $driverDir "Execution/$($src.Name)"
    Copy-Item $src.FullName $dest -Force
    $injectedFiles += $dest
    Write-Host "  injected $($src.Name)"
  }

  Write-Host "Applying patches..."

  # Patch 1 (patches/0001-register-checkpoint-factory.patch):
  # register CheckpointMaterializerFactory in the DI container
  Apply-Patch -File $driverAppFile `
    -Pattern "([ \t]*)(services\.AddSingleton<IWorkspaceMaterializerFactory, PerforceMaterializerFactory>\(\);)" `
    -Replacement "`$1`$2`r`n`$1services.AddSingleton<IWorkspaceMaterializerFactory, CheckpointMaterializerFactory>();" `
    -AlreadyAppliedMarker "CheckpointMaterializerFactory"

  # Patch 2a (patches/0002-conform-routing.patch): split Checkpoint workspaces out of the
  # ManagedWorkspace bucket so they are not conformed via Perforce
  Apply-Patch -File $conformFile `
    -Pattern "([ \t]*)(List<RpcAgentWorkspace> managedWorkspaces = pendingWorkspaces\s*\r?\n\s*\.Where\(x => !String\.Equals\(PerforceExecutor\.GetMaterializerName\(x\.Method\), PerforceExecutor\.Name, StringComparison\.OrdinalIgnoreCase\)\)\s*\r?\n\s*\.ToList\(\);)" `
    -Replacement ("`$1List<RpcAgentWorkspace> checkpointWorkspaces = pendingWorkspaces`r`n" +
      "`$1`t.Where(x => String.Equals(PerforceExecutor.GetMaterializerName(x.Method), CheckpointWorkspaceMaterializer.TypeName, StringComparison.OrdinalIgnoreCase))`r`n" +
      "`$1`t.ToList();`r`n`r`n" +
      "`$1List<RpcAgentWorkspace> managedWorkspaces = pendingWorkspaces`r`n" +
      "`$1`t.Where(x => !String.Equals(PerforceExecutor.GetMaterializerName(x.Method), PerforceExecutor.Name, StringComparison.OrdinalIgnoreCase))`r`n" +
      "`$1`t.Where(x => !checkpointWorkspaces.Contains(x))`r`n" +
      "`$1`t.ToList();") `
    -AlreadyAppliedMarker "checkpointWorkspaces"

  # Patch 2b: conform Checkpoint workspaces through the generic materializer path
  Apply-Patch -File $conformFile `
    -Pattern "([ \t]*)(if \(perforceWorkspaces\.Count > 0\)\s*\r?\n\s*\{\s*\r?\n\s*_logger\.LogInformation\(""Conforming PerforceMaterializers\.\.\.""\);\s*\r?\n\s*await PerforceExecutor\.ConformMaterializersAsync\(_materializerFactories, _workingDir, perforceWorkspaces, removeUntrackedFiles, workspaceMetadataDirs, _tracer, _logger, cancellationToken\);\s*\r?\n\s*\})" `
    -Replacement ("`$1`$2`r`n" +
      "`$1if (checkpointWorkspaces.Count > 0)`r`n" +
      "`$1{`r`n" +
      "`$1`t_logger.LogInformation(""Conforming Checkpoint workspaces..."");`r`n" +
      "`$1`tawait PerforceExecutor.ConformMaterializersAsync(_materializerFactories, _workingDir, checkpointWorkspaces, removeUntrackedFiles, workspaceMetadataDirs, _tracer, _logger, cancellationToken);`r`n" +
      "`$1}") `
    -AlreadyAppliedMarker "Conforming Checkpoint workspaces"

  # Publish (framework-dependent, matching how the agent invokes JobDriver.dll via dotnet)
  $outDir = Join-Path $root "../artifacts/jobdriver/JobDriver"
  if (Test-Path $outDir) { Remove-Item $outDir -Recurse -Force }
  Write-Host "Publishing JobDriver..."
  & $dotnet publish (Join-Path $driverDir "JobDriver.csproj") -c $Configuration -o $outDir
  if ($LASTEXITCODE -ne 0) { throw "JobDriver publish failed" }

  # Optionally bundle the Checkpoint CLI/daemon so agents need no separate install
  if ($CheckpointCliDir) {
    $toolsDir = Join-Path $outDir "tools"
    New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
    Copy-Item (Join-Path $CheckpointCliDir "*") $toolsDir -Recurse -Force
    Write-Host "Bundled Checkpoint CLI from $CheckpointCliDir"
  }

  Write-Host "Checkpoint JobDriver written to $outDir"
}
finally {
  # Restore the engine tree
  foreach ($file in $backups.Keys) {
    [System.IO.File]::WriteAllText($file, $backups[$file])
  }
  foreach ($file in $injectedFiles) {
    Remove-Item $file -Force -ErrorAction SilentlyContinue
  }
  Write-Host "Restored stock JobDriver sources in the engine tree"
}
