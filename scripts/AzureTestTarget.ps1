[CmdletBinding()]
param(
    [string]$ExpectedEndpoint = $env:COSMOS_TEST_EXPECTED_ENDPOINT,
    [string]$RunId = $env:FRIENDS_TRIVIA_TEST_RUN_ID,
    [switch]$Run,
    [switch]$ValidateTarget
)
. "$PSScriptRoot\AzureCommon.ps1"
if (-not $Run -and -not $ValidateTarget) {
    Write-Host 'Dry run: no data access or cleanup. Cosmos SDK acceptance ONLY; Blob acceptance is not implemented by this runner.'
    Write-Host 'Requires Node22, approved Azure CLI/OIDC test identity, exact isolated endpoint/database/containers/run ID and matching COSMOS_TEST_ACCOUNT_RESOURCE_ID.'
    Write-Host 'After separate approval and actual target verification, supply FRIENDS_TRIVIA_COSMOS_LIVE=approved-isolated-target and COSMOS_TEST_TARGET_VERIFIED=approved-account-and-isolated-database yourself; this script never sets approval flags.'
    Write-Host '-ValidateTarget checks supplied gates without authentication/data access. -Run invokes the Cosmos-only live SDK test.'
    return
}
$target = [pscustomobject]@{
    COSMOS_ENDPOINT = $env:COSMOS_ENDPOINT
    COSMOS_DATABASE = $env:COSMOS_DATABASE
    COSMOS_GAMES_CONTAINER = $env:COSMOS_GAMES_CONTAINER
    COSMOS_LIBRARY_CONTAINER = $env:COSMOS_LIBRARY_CONTAINER
    AZURE_STORAGE_CONTAINER = $env:AZURE_STORAGE_CONTAINER
    FRIENDS_TRIVIA_COSMOS_LIVE = $env:FRIENDS_TRIVIA_COSMOS_LIVE
    COSMOS_TEST_TARGET_VERIFIED = $env:COSMOS_TEST_TARGET_VERIFIED
    COSMOS_TEST_ACCOUNT_RESOURCE_ID = $env:COSMOS_TEST_ACCOUNT_RESOURCE_ID
}
Assert-TestTarget $target $ExpectedEndpoint $RunId
Assert-CosmosLiveApproval $target
if (-not $Run) { Write-Host 'Supplied Cosmos-only test gates validated offline; this does not verify Azure resources or grant approval.'; return }
$major = & node -p 'process.versions.node.split(".")[0]'
if ($LASTEXITCODE -ne 0 -or [int]$major -ne 22) { throw 'Real Azure tests require Node22; local SQLite development does not.' }
# This Cosmos-only runner uses AzureCliCredential and cleans up only this run's owned documents.
$test = "$PSScriptRoot\..\apps\server\src\cloud\cosmos.live.test.ts"
if (-not (Test-Path $test -PathType Leaf)) { throw 'Live acceptance runner not implemented yet. Do not replace this gate with mocked tests.' }
Push-Location "$PSScriptRoot\..\apps\server"
$previousRunId = $env:FRIENDS_TRIVIA_TEST_RUN_ID
try {
    $env:FRIENDS_TRIVIA_TEST_RUN_ID = $RunId
    & npm exec -- vitest run src/cloud/cosmos.live.test.ts --testTimeout 360000 --hookTimeout 120000
    if ($LASTEXITCODE -ne 0) { throw 'Live Cosmos SDK acceptance failed; inspect run-owned document cleanup status before retry. Blob acceptance is separate.' }
} finally {
    $env:FRIENDS_TRIVIA_TEST_RUN_ID = $previousRunId
    Pop-Location
}
