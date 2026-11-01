[CmdletBinding()]
param([switch]$Migrate)
$ErrorActionPreference = 'Stop'
if ($Migrate) { throw 'Cloud SQL migration has been retired. Cosmos containers are provisioned by AzureSetup; document upgrades belong to the bounded/versioned backend implementation.' }
Write-Host 'Dry run: no SQL migration, credentials, data import or resource changes. Local SQLite migrations remain unchanged.'
