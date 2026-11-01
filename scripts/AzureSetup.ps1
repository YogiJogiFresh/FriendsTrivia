[CmdletBinding()]
param(
    [string]$SubscriptionId = '299e641c-a5ad-4736-a74e-31ee5da9aef6',
    [string]$ResourceGroup = 'friendsTrivia-app',
    [ValidateSet('centralus')][string]$Location = 'centralus',
    [ValidateRange(40,40)][int]$BudgetAmount = 40,
    [string]$BudgetEmail = $env:AZURE_BUDGET_EMAIL,
    [switch]$NotifySubscriptionOwners,
    [switch]$IncludeApplication,
    [switch]$WhatIf,
    [switch]$Provision,
    [switch]$ResourceCostApproved,
    [switch]$IdentitySetupApproved,
    [switch]$WhatIfReviewed
)
. "$PSScriptRoot\AzureCommon.ps1"
$root = Split-Path $PSScriptRoot -Parent
Write-Host "Target: $SubscriptionId / $ResourceGroup / $Location; application included: $IncludeApplication."
Write-Host 'Cosmos NoSQL serverless, prod + isolated test databases; private LRS Blob; three distinct managed identities and OIDC subjects; USD40 alert, NOT a cap.'
if (-not $WhatIf -and -not $Provision) {
    Write-Host 'Dry run: no Azure calls. Use -WhatIf to validate/preview; provisioning additionally requires -ResourceCostApproved -IdentitySetupApproved -WhatIfReviewed.'
    return
}
if ($WhatIf -and $Provision) { throw 'Choose preview or provisioning, not both.' }
if ($Provision -and (-not $ResourceCostApproved -or -not $IdentitySetupApproved -or -not $WhatIfReviewed)) {
    throw 'Provisioning requires separately approved revised costs, identity/federation creation and reviewed what-if.'
}
if ((-not $BudgetEmail -and -not $NotifySubscriptionOwners) -or
    ($BudgetEmail -and $BudgetEmail -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$')) {
    throw 'Set AZURE_BUDGET_EMAIL securely or explicitly select -NotifySubscriptionOwners; never commit a personal notification destination.'
}
$account = Assert-AzureSubscription $SubscriptionId
if ($account.user.type -ne 'user') { throw 'Infrastructure setup requires the approved human administrator, not runtime/test/deployment CI.' }
if ((Invoke-Azure @('group', 'exists', '--name', $ResourceGroup, '--subscription', $SubscriptionId)) -ne 'true') {
    throw 'The approved existing resource group is missing; setup does not create or replace it.'
}
Write-Host 'Budget currency is subscription billing currency; confirm USD in the revised cost approval.'
$capabilities = ((Invoke-Azure @('cosmosdb', 'locations', 'show', '--location', $Location, '--subscription', $SubscriptionId, '--output', 'json') | Out-String) | ConvertFrom-Json)
Assert-CosmosCapabilities $capabilities
if ($IncludeApplication) {
    $locations = ((Invoke-Azure @('appservice', 'list-locations', '--sku', 'B1', '--linux-workers-enabled', '--subscription', $SubscriptionId, '--output', 'json') | Out-String) | ConvertFrom-Json)
    if (@($locations | Where-Object { $_.name -eq 'Central US' -or $_.name -eq 'centralus' }).Count -eq 0) { throw 'Linux B1 unavailable in Central US.' }
    $runtimes = Invoke-Azure @('webapp', 'list-runtimes', '--os', 'linux', '--output', 'json') | Out-String
    if ($runtimes -notmatch 'NODE[:|]22-lts') { throw 'Linux Node 22 LTS runtime unavailable.' }
}
$start = [DateTime]::UtcNow.ToString('yyyy-MM-01T00:00:00Z')
$end = [DateTime]::UtcNow.AddYears(5).ToString('yyyy-MM-01T00:00:00Z')
$priorDates = ((Invoke-Azure @('deployment', 'group', 'list', '--subscription', $SubscriptionId, '--resource-group', $ResourceGroup,
    '--query', "[?name=='friends-trivia'].properties.outputs.{start:budgetStart.value,end:budgetEnd.value}", '--output', 'json') | Out-String) | ConvertFrom-Json -NoEnumerate)
if (@($priorDates).Count -gt 0 -and $priorDates[0].start -and $priorDates[0].end) {
    $start = $priorDates[0].start
    $end = $priorDates[0].end
}
$arguments = @('--subscription', $SubscriptionId, '--resource-group', $ResourceGroup, '--name', 'friends-trivia',
    '--template-file', "$root\infra\azure\main.bicep", '--parameters', "location=$Location",
    "includeApplication=$($IncludeApplication.IsPresent.ToString().ToLowerInvariant())",
    "notifySubscriptionOwners=$($NotifySubscriptionOwners.IsPresent.ToString().ToLowerInvariant())",
    "budgetAmount=$BudgetAmount", "budgetEmail=$BudgetEmail", "budgetStartDate=$start", "budgetEndDate=$end")
# Provider-level ARM validation checks policy, permissions and resource/SKU quota before any creation.
Invoke-Azure (@('deployment', 'group', 'validate', '--validation-level', 'Provider') + $arguments + @('--output', 'none')) | Out-Null
Invoke-Azure (@('deployment', 'group', 'what-if') + $arguments) | Out-Host
if (-not $Provision) { return }
Invoke-Azure (@('deployment', 'group', 'create') + $arguments + @('--output', 'none')) | Out-Null
if ($IncludeApplication) {
    $outputs = Get-AzureOutputs $ResourceGroup $SubscriptionId
    $hostname = $outputs.defaultHostName.value
    if ($hostname -notmatch '^[a-zA-Z0-9.-]+\.azurewebsites\.net$') { throw 'Unexpected App Service hostname.' }
    Invoke-Azure @('webapp', 'config', 'appsettings', 'set', '--subscription', $SubscriptionId, '--resource-group', $ResourceGroup,
        '--name', $outputs.appName.value, '--settings', "PUBLIC_URL=https://$hostname", '--output', 'none') | Out-Null
}
& "$PSScriptRoot\AzureVerify.ps1" -SubscriptionId $SubscriptionId -ResourceGroup $ResourceGroup
Write-Host 'Next: review/approve AzureBootstrap IAM grants; configure isolated CI, then complete application acceptance before upload.'
