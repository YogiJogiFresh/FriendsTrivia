[CmdletBinding()]
param(
    [string]$SubscriptionId = '299e641c-a5ad-4736-a74e-31ee5da9aef6',
    [string]$ResourceGroup = 'friendsTrivia-app',
    [ValidatePattern('^$|^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$')][string]$DeveloperTestObjectId = '',
    [switch]$WhatIf,
    [switch]$Bootstrap,
    [switch]$GrantApproved,
    [switch]$WhatIfReviewed
)
. "$PSScriptRoot\AzureCommon.ps1"
if (-not $WhatIf -and -not $Bootstrap) { Write-Host 'Dry run: no IAM changes. -WhatIf previews data grants; -Bootstrap requires -GrantApproved -WhatIfReviewed.'; return }
if ($WhatIf -and $Bootstrap) { throw 'Choose preview or bootstrap, not both.' }
if ($Bootstrap -and (-not $GrantApproved -or -not $WhatIfReviewed)) { throw 'Explicit reviewed IAM grant approval is required.' }
$account = Assert-AzureSubscription $SubscriptionId
if ($account.user.type -ne 'user') { throw 'Grant bootstrap requires an approved human with role-assignment authority.' }
$outputs = Get-AzureOutputs $ResourceGroup $SubscriptionId
$arguments = @('--subscription', $SubscriptionId, '--resource-group', $ResourceGroup, '--name', 'friends-trivia-access',
    '--template-file', "$PSScriptRoot\..\infra\azure\access.bicep", '--parameters',
    "cosmosAccount=$($outputs.cosmosAccount.value)", "storageAccount=$($outputs.storageAccount.value)",
    "runtimeObjectId=$($outputs.runtimeObjectId.value)", "testObjectId=$($outputs.testObjectId.value)",
    "deployObjectId=$($outputs.deployObjectId.value)", "appName=$($outputs.appName.value)", "developerTestObjectId=$DeveloperTestObjectId")
Invoke-Azure (@('deployment', 'group', 'what-if') + $arguments) | Out-Host
if (-not $Bootstrap) { return }
Invoke-Azure (@('deployment', 'group', 'create') + $arguments + @('--output', 'none')) | Out-Null
Write-Host 'Granted runtime: prod DB + songs; tester/optional human: test DB + songs-tests; deployer: app only (when present). Allow RBAC propagation, then run live conformance.'
