# install-service.ps1 — Register Checkpoint Daemon as a Windows Service
# Run as Administrator during installation

param(
    [string]$InstallDir = "$env:ProgramFiles\Checkpoint",
    [switch]$Uninstall
)

$ServiceName = "CheckpointDaemon"
$ServiceDisplayName = "Checkpoint VCS Daemon"
$ServiceDescription = "Checkpoint version control system daemon — manages workspaces, file sync, and VCS operations."
$DaemonExe = Join-Path $InstallDir "checkpoint-daemon.exe"

function Install-CheckpointService {
    $existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue

    if ($existingService) {
        Write-Host "Service '$ServiceName' already exists. Stopping and removing..."
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        & sc.exe delete $ServiceName
        Start-Sleep -Seconds 2
    }

    if (-not (Test-Path $DaemonExe)) {
        Write-Error "Daemon executable not found at: $DaemonExe"
        exit 1
    }

    Write-Host "Creating service '$ServiceName'..."

    # Create the service to run as the current user (user-level service)
    # The daemon manages per-user workspaces in ~/.checkpoint/
    & sc.exe create $ServiceName `
        binPath= "`"$DaemonExe`"" `
        DisplayName= "$ServiceDisplayName" `
        start= auto `
        obj= "$env:USERDOMAIN\$env:USERNAME"

    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to create service"
        exit 1
    }

    & sc.exe description $ServiceName "$ServiceDescription"
    & sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/10000/restart/30000

    Write-Host "Starting service '$ServiceName'..."
    Start-Service -Name $ServiceName

    Write-Host "Service '$ServiceName' installed and started successfully."
}

function Uninstall-CheckpointService {
    $existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue

    if (-not $existingService) {
        Write-Host "Service '$ServiceName' does not exist."
        return
    }

    Write-Host "Stopping service '$ServiceName'..."
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2

    Write-Host "Removing service '$ServiceName'..."
    & sc.exe delete $ServiceName

    if ($LASTEXITCODE -eq 0) {
        Write-Host "Service '$ServiceName' removed successfully."
    } else {
        Write-Error "Failed to remove service."
    }
}

if ($Uninstall) {
    Uninstall-CheckpointService
} else {
    Install-CheckpointService
}
