Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Azure {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $result = & az @Arguments --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw "Azure command failed: $($Arguments[0]) $($Arguments[1])" }
    return $result
}
function Assert-AzureSubscription {
    param([string]$SubscriptionId)
    $account = (Invoke-Azure @('account', 'show', '--output', 'json') | Out-String) | ConvertFrom-Json
    if ($account.id -ne $SubscriptionId) { throw 'Active subscription differs from the selected subscription. Use az account set first.' }
    return $account
}
function Get-AzureOutputs {
    param([string]$ResourceGroup, [string]$SubscriptionId)
    return ((Invoke-Azure @('deployment', 'group', 'show', '--subscription', $SubscriptionId, '--resource-group', $ResourceGroup,
        '--name', 'friends-trivia', '--query', 'properties.outputs', '--output', 'json') | Out-String) | ConvertFrom-Json)
}
function Assert-CosmosCapabilities {
    param([Parameter(Mandatory)]$Capabilities)
    if ($Capabilities.name -ne 'Central US' -or $Capabilities.properties.status -ne 'Online' -or
        $Capabilities.properties.isSubscriptionRegionAccessAllowedForRegular -ne $true) {
        throw 'Central US regular Cosmos provisioning is unavailable/restricted. Do not provision partial infrastructure or enable zone redundancy.'
    }
}
function Assert-TestTarget {
    param([Parameter(Mandatory)]$Environment, [string]$ExpectedEndpoint, [string]$RunId)
    if ($Environment.COSMOS_DATABASE -ne 'friends-trivia-tests' -or
        $Environment.AZURE_STORAGE_CONTAINER -ne 'songs-tests' -or
        $Environment.COSMOS_ENDPOINT -ne $ExpectedEndpoint -or
        $ExpectedEndpoint -notmatch '^https://[a-z0-9-]+\.documents\.azure\.com:443/$' -or
        $Environment.COSMOS_GAMES_CONTAINER -ne 'games' -or $Environment.COSMOS_LIBRARY_CONTAINER -ne 'library' -or
        $RunId -notmatch '^[a-zA-Z0-9][a-zA-Z0-9-]{7,79}$') {
        throw 'Refusing unsafe test target: require exact expected account endpoint, test database/container allowlist and unique bounded run ID.'
    }
}
function Assert-GamesCompositeIndexes {
    param([Parameter(Mandatory)]$IndexingPolicy)
    $actual = foreach ($index in $IndexingPolicy.compositeIndexes) {
        ($index | ForEach-Object { "$($_.path):$($_.order)" }) -join '|'
    }
    foreach ($required in @(
        '/submission/elapsedMs:ascending|/submission/id:ascending',
        '/price:descending|/submission/playerId:ascending',
        '/price:ascending|/submission/playerId:ascending'
    )) {
        if ($required -notin $actual) { throw "Games composite index missing or ordered incorrectly: $required" }
    }
}
function Assert-CosmosLiveApproval {
    param([Parameter(Mandatory)]$Environment)
    if ($Environment.FRIENDS_TRIVIA_COSMOS_LIVE -ne 'approved-isolated-target' -or
        $Environment.COSMOS_TEST_TARGET_VERIFIED -ne 'approved-account-and-isolated-database') {
        throw 'Live Cosmos SDK tests require explicit paid/test approval and separately verified account/database flags; scripts never set them automatically.'
    }
    $account = ([Uri]$Environment.COSMOS_ENDPOINT).Host.Split('.')[0]
    $expectedResourceId = "/subscriptions/299e641c-a5ad-4736-a74e-31ee5da9aef6/resourceGroups/friendsTrivia-app/providers/Microsoft.DocumentDB/databaseAccounts/$account"
    if ($Environment.COSMOS_TEST_ACCOUNT_RESOURCE_ID -cne $expectedResourceId) {
        throw 'Live Cosmos SDK test account resource ID must match the approved subscription/group and exact endpoint account.'
    }
}
