$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\AzureCommon.ps1"
$lock = Get-Content "$PSScriptRoot\..\package-lock.json" -Raw | ConvertFrom-Json -AsHashtable
foreach ($package in @('node_modules/@rollup/rollup-linux-x64-gnu', 'node_modules/@rollup/rollup-win32-x64-msvc')) {
    $entry = $lock.packages[$package]
    if ($null -eq $entry -or $entry.version -ne $lock.packages['node_modules/rollup'].version) {
        throw "Missing/mismatched native Rollup lock entry: $package. Restore platform metadata without changing existing package versions."
    }
}
function Assert-Rejected {
    param([scriptblock]$Action)
    $rejected = $false
    try { & $Action } catch {
        if ($_.Exception.Message -like '*unexpectedly invoked Azure*') { throw }
        $rejected = $true
    }
    if (-not $rejected) { throw 'Guard accepted an unsafe action.' }
}
$available = [pscustomobject]@{ name = 'Central US'; properties = [pscustomobject]@{ status = 'Online'; isSubscriptionRegionAccessAllowedForRegular = $true } }
Assert-CosmosCapabilities $available
$available.properties.isSubscriptionRegionAccessAllowedForRegular = $false
Assert-Rejected { Assert-CosmosCapabilities $available }
$target = [pscustomobject]@{
    COSMOS_ENDPOINT = 'https://example.documents.azure.com:443/'
    COSMOS_DATABASE = 'friends-trivia-tests'
    COSMOS_GAMES_CONTAINER = 'games'
    COSMOS_LIBRARY_CONTAINER = 'library'
    AZURE_STORAGE_CONTAINER = 'songs-tests'
}
Assert-TestTarget $target $target.COSMOS_ENDPOINT 'run-12345678'
Assert-Rejected { Assert-TestTarget $target 'https://other.documents.azure.com:443/' 'run-12345678' }
Assert-Rejected { Assert-TestTarget $target $target.COSMOS_ENDPOINT '../unsafe' }
$target.COSMOS_DATABASE = 'friends-trivia'
Assert-Rejected { Assert-TestTarget $target $target.COSMOS_ENDPOINT 'run-12345678' }
$target.COSMOS_DATABASE = 'friends-trivia-tests'
$target.AZURE_STORAGE_CONTAINER = 'songs'
Assert-Rejected { Assert-TestTarget $target $target.COSMOS_ENDPOINT 'run-12345678' }
$approval = [pscustomobject]@{
    COSMOS_ENDPOINT = 'https://example.documents.azure.com:443/'
    FRIENDS_TRIVIA_COSMOS_LIVE = 'approved-isolated-target'
    COSMOS_TEST_TARGET_VERIFIED = 'approved-account-and-isolated-database'
    COSMOS_TEST_ACCOUNT_RESOURCE_ID = '/subscriptions/299e641c-a5ad-4736-a74e-31ee5da9aef6/resourceGroups/friendsTrivia-app/providers/Microsoft.DocumentDB/databaseAccounts/example'
}
Assert-CosmosLiveApproval $approval
$approval.FRIENDS_TRIVIA_COSMOS_LIVE = ''
Assert-Rejected { Assert-CosmosLiveApproval $approval }
$approval.FRIENDS_TRIVIA_COSMOS_LIVE = 'approved-isolated-target'
$approval.COSMOS_TEST_TARGET_VERIFIED = ''
Assert-Rejected { Assert-CosmosLiveApproval $approval }
$approval.COSMOS_TEST_TARGET_VERIFIED = 'approved-account-and-isolated-database'
$approval.COSMOS_TEST_ACCOUNT_RESOURCE_ID += '-other'
Assert-Rejected { Assert-CosmosLiveApproval $approval }
function az { throw 'Dry run or approval guard unexpectedly invoked Azure.' }
& "$PSScriptRoot\AzureSetup.ps1"
& "$PSScriptRoot\AzureBootstrap.ps1"
& "$PSScriptRoot\AzureMigrate.ps1"
& "$PSScriptRoot\AzureTestTarget.ps1"
& "$PSScriptRoot\AzureBlobTestTarget.ps1"
& "$PSScriptRoot\AzureDeploy.ps1" -AppName 'test-app'
Assert-Rejected { & "$PSScriptRoot\AzureSetup.ps1" -Provision }
Assert-Rejected { & "$PSScriptRoot\AzureSetup.ps1" -Provision -ResourceCostApproved }
Assert-Rejected { & "$PSScriptRoot\AzureSetup.ps1" -Provision -ResourceCostApproved -IdentitySetupApproved }
Assert-Rejected { & "$PSScriptRoot\AzureBootstrap.ps1" -Bootstrap }
Assert-Rejected { & "$PSScriptRoot\AzureBootstrap.ps1" -Bootstrap -GrantApproved }
Assert-Rejected { & "$PSScriptRoot\AzureDeploy.ps1" -AppName test-app -Deploy }
Assert-Rejected { & "$PSScriptRoot\AzureMigrate.ps1" -Migrate }
Assert-Rejected { & "$PSScriptRoot\AzureBlobTestTarget.ps1" -ValidateTarget -RunId '' }
Assert-Rejected { & "$PSScriptRoot\AzureBlobTestTarget.ps1" -Run -RunId '' }
$global:AzureCheckCalls = [System.Collections.Generic.List[string]]::new()
$global:AzureCheckFailValidation = $false
function az {
    $global:LASTEXITCODE = 0
    $global:AzureCheckCalls.Add(($args -join ' '))
    switch ($args[0]) {
        account { '{"id":"299e641c-a5ad-4736-a74e-31ee5da9aef6","user":{"type":"user"}}' }
        group { 'true' }
        cosmosdb { '{"name":"Central US","properties":{"status":"Online","isSubscriptionRegionAccessAllowedForRegular":true}}' }
        appservice { '[{"name":"Central US"}]' }
        webapp { '["NODE:22-lts"]' }
        deployment {
            if ($args[2] -eq 'list') { '[]' }
            elseif ($args[2] -eq 'validate' -and $global:AzureCheckFailValidation) { $global:LASTEXITCODE = 1 }
            elseif ($args[2] -notin @('validate', 'what-if')) { throw "Unexpected mutating command: $args" }
        }
        default { throw "Unexpected Azure command: $args" }
    }
}
& "$PSScriptRoot\AzureSetup.ps1" -WhatIf -NotifySubscriptionOwners -IncludeApplication
if (-not @($global:AzureCheckCalls | Where-Object { $_ -match 'deployment group validate .*--validation-level Provider' }).Count -or
    -not @($global:AzureCheckCalls | Where-Object { $_ -match 'deployment group what-if' }).Count -or
    @($global:AzureCheckCalls | Where-Object { $_ -match ' group create|settings set|role.*create' }).Count) {
    throw 'Preview must perform provider validation and what-if only, never mutation.'
}
$global:AzureCheckCalls.Clear()
$global:AzureCheckFailValidation = $true
Assert-Rejected { & "$PSScriptRoot\AzureSetup.ps1" -Provision -NotifySubscriptionOwners -IncludeApplication -ResourceCostApproved -IdentitySetupApproved -WhatIfReviewed }
if (@($global:AzureCheckCalls | Where-Object { $_ -match 'deployment group (create|what-if)' }).Count) { throw 'Provider/quota failure must block creation and further preview.' }
$global:AzureVerifyBrokenPartition = $false
$global:AzureVerifyBrokenIndex = $false
$global:AzureVerifyApplication = $false
$global:AzureVerifyFlatPlan = $false
$global:AzureVerifyNonLinuxPlan = $false
$global:AzureVerifyLoginEnabled = $false
$global:AzureVerifyNoWebSockets = $false
$global:AzureCheckIndexPolicy = @'
{"compositeIndexes":[[{"path":"/submission/elapsedMs","order":"ascending"},{"path":"/submission/id","order":"ascending"}],[{"path":"/price","order":"descending"},{"path":"/submission/playerId","order":"ascending"}],[{"path":"/price","order":"ascending"},{"path":"/submission/playerId","order":"ascending"}]]}
'@ | ConvertFrom-Json
Assert-GamesCompositeIndexes $global:AzureCheckIndexPolicy
Assert-Rejected { Assert-GamesCompositeIndexes ([pscustomobject]@{ compositeIndexes = @() }) }
$wrongOrder = $global:AzureCheckIndexPolicy | ConvertTo-Json -Depth 10 | ConvertFrom-Json
$wrongOrder.compositeIndexes[1][0].order = 'ascending'
Assert-Rejected { Assert-GamesCompositeIndexes $wrongOrder }
function az {
    $global:LASTEXITCODE = 0
    switch ($args[0]) {
        account { '{"id":"299e641c-a5ad-4736-a74e-31ee5da9aef6"}' }
        deployment {
            @{
                cosmosAccount = @{ value = 'example' }
                storageAccount = @{ value = 'storage' }
                appName = @{ value = $(if ($global:AzureVerifyApplication) { 'verify-app' } else { '' }) }
                productionEnvironment = @{ value = @{ COSMOS_ENDPOINT = 'https://example.documents.azure.com:443/'; AZURE_STORAGE_ACCOUNT_URL = 'https://storage.blob.core.windows.net/' } }
                testEnvironment = @{ value = @{ COSMOS_ENDPOINT = 'https://example.documents.azure.com:443/' } }
                runtimeIdentityName = @{ value = 'runtime' }; runtimeClientId = @{ value = 'runtime-client' }; runtimeObjectId = @{ value = 'runtime-object' }
                deployIdentityName = @{ value = 'deploy' }; deployClientId = @{ value = 'deploy-client' }; deployObjectId = @{ value = 'deploy-object' }
                testIdentityName = @{ value = 'test' }; testClientId = @{ value = 'test-client' }; testObjectId = @{ value = 'test-object' }
            } | ConvertTo-Json -Depth 10
        }
        cosmosdb {
            if ($args[1] -eq 'show') {
                '{"name":"example","disableLocalAuth":true,"capabilities":[{"name":"EnableServerless"}],"locations":[{"locationName":"Central US","isZoneRedundant":false}],"documentEndpoint":"https://example.documents.azure.com:443/"}'
            } else {
                $path = if ($global:AzureVerifyBrokenPartition) { '/wrong' } else { '/pk' }
                $policy = if ($global:AzureVerifyBrokenIndex) { @{ compositeIndexes = @() } } else { $global:AzureCheckIndexPolicy }
                @{ resource = @{ partitionKey = @{ paths = @($path) }; indexingPolicy = $policy } } | ConvertTo-Json -Depth 10
            }
        }
        storage {
            if ($args[1] -eq 'account') {
                '{"name":"storage","allowSharedKeyAccess":false,"allowBlobPublicAccess":false,"sku":{"name":"Standard_LRS"},"primaryEndpoints":{"blob":"https://storage.blob.core.windows.net/"}}'
            } else { '{"publicAccess":"None"}' }
        }
        identity {
            $index = [Array]::IndexOf([object[]]$args, '--name')
            $name = $args[$index + 1]
            @{ clientId = "$name-client"; principalId = "$name-object" } | ConvertTo-Json
        }
        appservice {
            $plan = @{ sku = @{ name = 'B1'; capacity = 1 } }
            $reserved = -not $global:AzureVerifyNonLinuxPlan
            if ($global:AzureVerifyFlatPlan) { $plan.reserved = $reserved }
            else { $plan.properties = @{ reserved = $reserved } }
            $plan | ConvertTo-Json -Depth 5
        }
        webapp {
            if ($args[1] -eq 'show') { '{"id":"/app-id","name":"verify-app","serverFarmId":"plan-id","httpsOnly":true}' }
            elseif ($args[2] -eq 'appsettings') {
                '[{"name":"COSMOS_ENDPOINT","value":"https://example.documents.azure.com:443/"},{"name":"AZURE_STORAGE_ACCOUNT_URL","value":"https://storage.blob.core.windows.net/"}]'
            } else {
                @{ linuxFxVersion='NODE|22-lts';numberOfWorkers=1;alwaysOn=$true;webSocketsEnabled=(-not $global:AzureVerifyNoWebSockets) } | ConvertTo-Json
            }
        }
        rest { @{ enabled=$global:AzureVerifyLoginEnabled } | ConvertTo-Json }
        default { throw "Unexpected verification Azure command: $args" }
    }
}
& "$PSScriptRoot\AzureVerify.ps1" | Out-Null
$global:AzureVerifyBrokenPartition = $true
Assert-Rejected { & "$PSScriptRoot\AzureVerify.ps1" }
$global:AzureVerifyBrokenPartition = $false
$global:AzureVerifyBrokenIndex = $true
Assert-Rejected { & "$PSScriptRoot\AzureVerify.ps1" }
$global:AzureVerifyBrokenIndex = $false
$global:AzureVerifyApplication = $true
& "$PSScriptRoot\AzureVerify.ps1" | Out-Null
$global:AzureVerifyFlatPlan = $true
& "$PSScriptRoot\AzureVerify.ps1" | Out-Null
$global:AzureVerifyNonLinuxPlan = $true
Assert-Rejected { & "$PSScriptRoot\AzureVerify.ps1" }
$global:AzureVerifyFlatPlan = $false
Assert-Rejected { & "$PSScriptRoot\AzureVerify.ps1" }
$global:AzureVerifyNonLinuxPlan = $false
$global:AzureVerifyLoginEnabled = $true
Assert-Rejected { & "$PSScriptRoot\AzureVerify.ps1" }
$global:AzureVerifyLoginEnabled = $false
$global:AzureVerifyNoWebSockets = $true
Assert-Rejected { & "$PSScriptRoot\AzureVerify.ps1" }
$global:AzureDeploymentHealthCalls = 0
$global:AzureDeploymentUploaded = $false
$global:AzureDeploymentSameBoot = $false
function az {
    $global:LASTEXITCODE = 0
    if ($args[0] -eq 'account') { '{"id":"299e641c-a5ad-4736-a74e-31ee5da9aef6","user":{"type":"user"}}' }
    elseif ($args[0] -eq 'webapp' -and $args[1] -eq 'show') { 'test-app.azurewebsites.net' }
    elseif ($args[0] -eq 'webapp' -and $args[1] -eq 'deploy') {
        if (($args -join ' ') -notmatch '--track-status false') { throw 'Deployment must verify the actual boot, not stale startup tracking.' }
        $global:AzureDeploymentUploaded = $true
    } else { throw "Unexpected deployment command: $args" }
}
function Invoke-WebRequest {
    $global:AzureDeploymentHealthCalls++
    $boot = if ($global:AzureDeploymentSameBoot -or $global:AzureDeploymentHealthCalls -lt 3) { '11111111-1111-4111-8111-111111111111' } else { '22222222-2222-4222-8222-222222222222' }
    [pscustomobject]@{ StatusCode = 200; Content = "{`"status`":`"ok`",`"bootId`":`"$boot`"}" }
}
function Start-Sleep {}
$deploymentFixture = Join-Path ([IO.Path]::GetTempPath()) "friends-trivia-deploy-check-$([guid]::NewGuid()).zip"
try {
    [IO.File]::WriteAllBytes($deploymentFixture, [byte[]]@())
    & "$PSScriptRoot\AzureDeploy.ps1" -AppName 'test-app' -Artifact $deploymentFixture -Deploy -ReleaseApproved
    if (-not $global:AzureDeploymentUploaded -or $global:AzureDeploymentHealthCalls -ne 3) {
        throw 'Deployment accepted an old worker or failed to verify the new boot.'
    }
    $global:AzureDeploymentSameBoot = $true
    $global:AzureDeploymentHealthCalls = 0
    Assert-Rejected { & "$PSScriptRoot\AzureDeploy.ps1" -AppName 'test-app' -Artifact $deploymentFixture -Deploy -ReleaseApproved }
    if ($global:AzureDeploymentHealthCalls -ne 25) { throw 'Stale-worker rejection must be bounded.' }
} finally {
    Remove-Item -LiteralPath $deploymentFixture -ErrorAction SilentlyContinue
    Remove-Item Function:Invoke-WebRequest, Function:Start-Sleep
}
foreach ($file in Get-ChildItem "$PSScriptRoot\Azure*.ps1") {
    $tokens = $null; $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -ne 0) { throw "$($file.Name): $errors" }
}
$template = Get-Content "$PSScriptRoot\..\infra\azure\main.bicep" -Raw
foreach ($required in @('EnableServerless', 'disableLocalAuth: true', 'allowSharedKeyAccess: false', "paths: ['/pk']", "capacity: 1", "NODE|22-lts", "name: 'authsettingsV2'", 'enabled: false')) {
    if (-not $template.Contains($required)) { throw "Infrastructure requirement missing: $required" }
}
foreach ($index in $global:AzureCheckIndexPolicy.compositeIndexes) {
    $entries = ($index | ForEach-Object { [regex]::Escape("{ path: '$($_.path)', order: '$($_.order)' }") }) -join '\s+'
    if ($template -notmatch "\[\s+$entries\s+\]") { throw 'Required games composite index absent from infrastructure template.' }
}
foreach ($file in @("$PSScriptRoot\..\infra\azure\main.bicep", "$PSScriptRoot\..\infra\azure\access.bicep", "$PSScriptRoot\..\.github\workflows\azure-deploy.yml")) {
    if (Test-Path $file) {
        if ((Get-Content $file -Raw) -match '(?i)postgres|ADMIN_PASSWORD') { throw 'Retired cloud SQL/password configuration remains.' }
    }
}
Write-Host 'Azure parsing, regional/test isolation guards, no-action dry runs and explicit approval gates passed.'
