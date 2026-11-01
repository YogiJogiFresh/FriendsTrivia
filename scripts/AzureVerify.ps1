[CmdletBinding()]
param(
    [string]$SubscriptionId = '299e641c-a5ad-4736-a74e-31ee5da9aef6',
    [string]$ResourceGroup = 'friendsTrivia-app'
)
. "$PSScriptRoot\AzureCommon.ps1"
Assert-AzureSubscription $SubscriptionId | Out-Null
$outputs = Get-AzureOutputs $ResourceGroup $SubscriptionId
$cosmos = ((Invoke-Azure @('cosmosdb', 'show', '--subscription', $SubscriptionId, '--resource-group', $ResourceGroup,
    '--name', $outputs.cosmosAccount.value, '--output', 'json') | Out-String) | ConvertFrom-Json)
if (-not $cosmos.disableLocalAuth -or @($cosmos.capabilities | Where-Object name -eq 'EnableServerless').Count -ne 1 -or
    @($cosmos.locations).Count -ne 1 -or $cosmos.locations[0].locationName -ne 'Central US' -or $cosmos.locations[0].isZoneRedundant) {
    throw 'Cosmos runtime configuration does not match approved serverless/single-region/no-key design.'
}
if ($cosmos.documentEndpoint -ne $outputs.productionEnvironment.value.COSMOS_ENDPOINT -or
    $cosmos.documentEndpoint -ne $outputs.testEnvironment.value.COSMOS_ENDPOINT) { throw 'Cosmos outputs differ from actual endpoint.' }
foreach ($database in @('friends-trivia', 'friends-trivia-tests')) {
    foreach ($container in @('games', 'library')) {
        $actual = ((Invoke-Azure @('cosmosdb', 'sql', 'container', 'show', '--subscription', $SubscriptionId,
            '--resource-group', $ResourceGroup, '--account-name', $cosmos.name, '--database-name', $database,
            '--name', $container, '--output', 'json') | Out-String) | ConvertFrom-Json)
        if (($actual.resource.partitionKey.paths -join ',') -ne '/pk') { throw "$database/$container has wrong partition key." }
        if ($container -eq 'games') { Assert-GamesCompositeIndexes $actual.resource.indexingPolicy }
    }
}
$storage = ((Invoke-Azure @('storage', 'account', 'show', '--subscription', $SubscriptionId,
    '--resource-group', $ResourceGroup, '--name', $outputs.storageAccount.value, '--output', 'json') | Out-String) | ConvertFrom-Json)
if ($storage.allowSharedKeyAccess -ne $false -or $storage.allowBlobPublicAccess -ne $false -or $storage.sku.name -ne 'Standard_LRS') {
    throw 'Storage must be private LRS with shared-key authorization disabled.'
}
if ($storage.primaryEndpoints.blob -ne $outputs.productionEnvironment.value.AZURE_STORAGE_ACCOUNT_URL) { throw 'Blob output differs from actual endpoint.' }
foreach ($container in @('songs', 'songs-tests')) {
    $actual = ((Invoke-Azure @('storage', 'container-rm', 'show', '--subscription', $SubscriptionId, '--resource-group', $ResourceGroup,
        '--storage-account', $storage.name, '--name', $container, '--output', 'json') | Out-String) | ConvertFrom-Json)
    if ($actual.publicAccess -ne 'None') { throw "$container is not private." }
}
foreach ($name in @('runtime', 'deploy', 'test')) {
    $identityName = $outputs."${name}IdentityName".value
    $actual = ((Invoke-Azure @('identity', 'show', '--subscription', $SubscriptionId, '--resource-group', $ResourceGroup,
        '--name', $identityName, '--output', 'json') | Out-String) | ConvertFrom-Json)
    if ($actual.clientId -ne $outputs."${name}ClientId".value -or $actual.principalId -ne $outputs."${name}ObjectId".value) {
        throw "$name identity output differs from actual identity."
    }
}
if ($outputs.appName.value) {
    $app = ((Invoke-Azure @('webapp', 'show', '--subscription', $SubscriptionId, '--resource-group', $ResourceGroup,
        '--name', $outputs.appName.value, '--output', 'json') | Out-String) | ConvertFrom-Json)
    $plan = ((Invoke-Azure @('appservice', 'plan', 'show', '--ids', $app.serverFarmId, '--output', 'json') | Out-String) | ConvertFrom-Json)
    $planProperties = if ($plan.PSObject.Properties['properties']) { $plan.properties } else { $plan }
    if ($plan.sku.name -ne 'B1' -or $plan.sku.capacity -ne 1 -or -not $planProperties.reserved -or -not $app.httpsOnly) { throw 'App must be one Linux B1 HTTPS instance.' }
    $config = ((Invoke-Azure @('webapp', 'config', 'show', '--subscription', $SubscriptionId, '--resource-group', $ResourceGroup,
        '--name', $app.name, '--output', 'json') | Out-String) | ConvertFrom-Json)
    if ($config.linuxFxVersion -ne 'NODE|22-lts' -or $config.numberOfWorkers -ne 1 -or -not $config.alwaysOn -or -not $config.webSocketsEnabled) { throw 'App must use one Node22 worker with Always On and WebSockets.' }
    $auth = ((Invoke-Azure @('rest', '--method', 'get',
        '--url', "https://management.azure.com$($app.id)/config/authsettingsV2?api-version=2023-12-01",
        '--query', 'properties.platform', '--output', 'json') | Out-String) | ConvertFrom-Json)
    if ($auth.enabled -ne $false) { throw 'Easy Auth must remain disabled for the public application.' }
    $settings = ((Invoke-Azure @('webapp', 'config', 'appsettings', 'list', '--subscription', $SubscriptionId, '--resource-group', $ResourceGroup,
        '--name', $app.name, '--output', 'json') | Out-String) | ConvertFrom-Json)
    foreach ($key in $outputs.productionEnvironment.value.PSObject.Properties.Name) {
        $setting = @($settings | Where-Object name -eq $key)
        if ($setting.Count -ne 1 -or $setting[0].value -ne $outputs.productionEnvironment.value.$key) { throw "App setting $key differs from verified output." }
    }
}
Write-Host 'Actual resources and required environment outputs verified. This check does not certify IAM propagation or Cosmos/Blob SDK acceptance.'
$outputs.productionEnvironment.value
$outputs.testEnvironment.value
