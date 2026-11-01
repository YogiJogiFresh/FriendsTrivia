[CmdletBinding()]
param([string]$Output = 'dist/cloud', [switch]$UseWsl)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    if ($UseWsl) {
        & wsl --cd $root -- node scripts/AzurePackage.mjs $Output
    } else {
        & node (Resolve-Path "$PSScriptRoot\AzurePackage.mjs").Path $Output
    }
    if ($LASTEXITCODE -ne 0) { throw 'Linux packaging failed. WSL needs Node 22, npm, zip and the Linux-built workspace outputs.' }
} finally { Pop-Location }
