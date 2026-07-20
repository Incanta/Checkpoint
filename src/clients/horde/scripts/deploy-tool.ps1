<#
.SYNOPSIS
Uploads a repacked agent zip as a new tool deployment on a Horde server.

.DESCRIPTION
Creates a new deployment of the agent tool via POST /api/v1/tools/{id}/deployments (multipart
form). Agents assigned to that tool pick up the new version via their normal upgrade flow.

.PARAMETER Server
Base URL of the Horde server (e.g. https://horde.example.com).

.PARAMETER Zip
Path to the repacked agent zip from repack-agent.ps1.

.PARAMETER ToolId
Tool id to deploy to. Defaults to horde-agent-win-x64.

.PARAMETER Token
Bearer token for the Horde server (needs tool upload permissions). Falls back to the
HORDE_TOKEN environment variable.

.PARAMETER Duration
Optional rollout duration (e.g. "00:30:00" for a 30 minute phased rollout). Default deploys
immediately.
#>
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [Parameter(Mandatory = $true)][string]$Zip,
  [string]$ToolId = "horde-agent-win-x64",
  [string]$Token = $env:HORDE_TOKEN,
  [string]$Duration = ""
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $Zip)) { throw "Zip not found: $Zip" }

$uri = "$($Server.TrimEnd('/'))/api/v1/tools/$ToolId/deployments"
Write-Host "Deploying $Zip to $uri..."

$form = @{ file = Get-Item $Zip }
if ($Duration) { $form["Duration"] = $Duration }

$headers = @{}
if ($Token) { $headers["Authorization"] = "Bearer $Token" }

$response = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Form $form
Write-Host "Created deployment: $($response | ConvertTo-Json -Compress)"
Write-Host "Agents using tool '$ToolId' will upgrade on their next update check."
