param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$rootPackage = Join-Path $root "package.json"
$desktopPackage = Join-Path $root "apps\desktop\package.json"
$releaseDirectory = Join-Path $root "apps\desktop\release"
$desktopJson = Get-Content $desktopPackage -Raw | ConvertFrom-Json
$currentVersion = $desktopJson.version
$parts = $currentVersion -split '\.'
$major = [int]$parts[0]
$minor = [int]$parts[1]
$patch = [int]$parts[2]

Write-Host "`nCurrent version: $currentVersion" -ForegroundColor Cyan
Write-Host "[1] patch -> $major.$minor.$($patch + 1)"
Write-Host "[2] minor -> $major.$($minor + 1).0"
Write-Host "[3] major -> $($major + 1).0.0"
$choice = Read-Host "Select version bump (1/2/3)"

switch ($choice) {
  "1" { $patch++ }
  "2" { $minor++; $patch = 0 }
  "3" { $major++; $minor = 0; $patch = 0 }
  default { throw "Invalid version selection" }
}

$newVersion = "$major.$minor.$patch"
foreach ($packagePath in @($rootPackage, $desktopPackage)) {
  $content = Get-Content $packagePath -Raw
  $content = $content -replace '"version":\s*"[^"]+"', "`"version`": `"$newVersion`""
  Set-Content $packagePath -Value $content -NoNewline
}

Push-Location $root
try {
  npm install --package-lock-only
  if ($LASTEXITCODE -ne 0) { throw "Lockfile update failed" }
  Push-Location (Join-Path $root "apps\desktop")
  try {
    npm install --package-lock-only --workspaces=false
    if ($LASTEXITCODE -ne 0) { throw "Desktop lockfile update failed" }
  } finally {
    Pop-Location
  }
  npm run desktop:build
  if ($LASTEXITCODE -ne 0) { throw "Desktop build failed" }

  $installer = Join-Path $releaseDirectory "FriendsTrivia-Setup-$newVersion.exe"
  $latest = Join-Path $releaseDirectory "latest.yml"
  $blockmap = "$installer.blockmap"
  if (-not (Test-Path $installer)) { throw "Installer not found: $installer" }

  $arguments = @(
    "release", "create", "v$newVersion",
    $installer, $latest, $blockmap,
    "--repo", "YogiJogiFresh/FriendsTrivia",
    "--title", "FriendsTrivia v$newVersion",
    "--generate-notes"
  )
  & gh @arguments
  if ($LASTEXITCODE -ne 0) { throw "GitHub release creation failed" }
} finally {
  Pop-Location
}

Write-Host "`nPublished FriendsTrivia v$newVersion." -ForegroundColor Green
