[CmdletBinding()]
param(
    [string]$RunId = $env:FRIENDS_TRIVIA_TEST_RUN_ID,
    [switch]$Run,
    [switch]$ValidateTarget
)
$ErrorActionPreference = 'Stop'
if (-not $Run -and -not $ValidateTarget) {
    Write-Host 'Dry run: no Blob credentials, data access or cleanup.'
    Write-Host 'Requires approved/verified Blob test flags, matching account endpoint/resource ID, songs-tests and a unique run ID.'
    Write-Host '-ValidateTarget checks supplied gates offline; -Run executes isolated Blob persistence/range acceptance only.'
    return
}
$root = Split-Path $PSScriptRoot -Parent
$guard = Join-Path $root 'apps\server\dist\cloud\blobTestTarget.js'
if (-not (Test-Path -LiteralPath $guard -PathType Leaf)) {
    throw 'Build shared/server before validating Blob test gates; do not substitute mocked acceptance.'
}
$major = & node -p 'process.versions.node.split(".")[0]'
if ($LASTEXITCODE -ne 0 -or [int]$major -ne 22) { throw 'Live Blob validation requires Node22.' }
$previousRunId = $env:FRIENDS_TRIVIA_TEST_RUN_ID
try {
    $env:FRIENDS_TRIVIA_TEST_RUN_ID = $RunId
    $code = "const {pathToFileURL}=await import('node:url'); const {validateBlobTestTarget}=await import(pathToFileURL(process.argv[1]).href); validateBlobTestTarget(process.env);"
    & node --input-type=module -e $code $guard
    if ($LASTEXITCODE -ne 0) { throw 'Blob target gates failed before credentials or data access.' }
    if (-not $Run) { Write-Host 'Supplied Blob gates validated offline; actual resources and approval are not inferred.'; return }
    Push-Location (Join-Path $root 'apps\server')
    try {
        & npm exec -- vitest run src/cloud/blob.live.test.ts --testTimeout 120000 --hookTimeout 120000
        if ($LASTEXITCODE -ne 0) { throw 'Live Blob acceptance failed; inspect its retained run fence and run-owned cleanup before retry.' }
    } finally { Pop-Location }
} finally { $env:FRIENDS_TRIVIA_TEST_RUN_ID = $previousRunId }
