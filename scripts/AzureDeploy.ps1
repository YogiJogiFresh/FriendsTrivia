[CmdletBinding()]
param(
    [string]$SubscriptionId = '299e641c-a5ad-4736-a74e-31ee5da9aef6',
    [string]$ResourceGroup = 'friendsTrivia-app',
    [Parameter(Mandatory)][string]$AppName,
    [string]$Artifact = 'dist\cloud.zip',
    [switch]$Deploy,
    [switch]$ReleaseApproved
)
. "$PSScriptRoot\AzureCommon.ps1"
if (-not $Deploy) { Write-Host "Dry run: would deploy $Artifact to $ResourceGroup/$AppName. No upload performed."; return }
if (-not $ReleaseApproved) { throw 'Upload is blocked until backend/live Cosmos and Blob acceptance and the separate deployment todo are approved. Use -ReleaseApproved only after that gate.' }
Assert-AzureSubscription $SubscriptionId | Out-Null
if (-not (Test-Path $Artifact -PathType Leaf) -or [IO.Path]::GetExtension($Artifact) -ne '.zip') { throw 'Provide the Linux-built ZIP artifact.' }
$hostname = Invoke-Azure @('webapp', 'show', '--subscription', $SubscriptionId, '--resource-group', $ResourceGroup, '--name', $AppName, '--query', 'defaultHostName', '--output', 'tsv')
if ($hostname -notmatch '^[a-zA-Z0-9.-]+\.azurewebsites\.net$') { throw 'Unexpected Azure default hostname; refusing smoke-check redirection.' }
Write-Host "Deploying to https://$hostname. This interrupts active games; retain the previous ZIP for schema-compatible rollback."
$previousBootId = $null
try {
    $previous = Invoke-WebRequest "https://$hostname/api/health" -TimeoutSec 15 -MaximumRedirection 0
    $previousBootId = ($previous.Content | ConvertFrom-Json).bootId
} catch { Write-Host 'Pre-deployment boot identity unavailable; a new healthy worker is still required.' }
# Azure startup tracking can retain a pre-upload cold-start failure; verify the actual new worker instead.
Invoke-Azure @('webapp', 'deploy', '--subscription', $SubscriptionId, '--resource-group', $ResourceGroup, '--name', $AppName, '--src-path', (Resolve-Path $Artifact).Path, '--type', 'zip', '--clean', 'true', '--restart', 'true', '--track-status', 'false', '--output', 'none') | Out-Null
for ($attempt = 1; $attempt -le 24; $attempt++) {
    try {
        $response = Invoke-WebRequest "https://$hostname/api/health" -TimeoutSec 15 -MaximumRedirection 0
        $health = $response.Content | ConvertFrom-Json
        if ($response.StatusCode -eq 200 -and $health.status -eq 'ok' -and
            $health.bootId -match '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$' -and
            $health.bootId -ne $previousBootId) { Write-Host 'Deployment new-worker health check passed.'; return }
        Write-Host "Health attempt $attempt/24 has no new healthy worker; retrying."
    } catch { Write-Host "Health attempt $attempt/24 failed; retrying." }
    Start-Sleep -Seconds 10
}
throw 'Deployment did not become healthy. Inspect logs; do not automatically rewind documents or restore data.'
