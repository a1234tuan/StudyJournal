$ErrorActionPreference = "Stop"

function Get-Sha256Hex([string]$Path) {
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($sha256.ComputeHash([System.IO.File]::ReadAllBytes($Path)))).Replace("-", "")
  } finally {
    $sha256.Dispose()
  }
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$androidRoot = Join-Path $repoRoot "android"
$distIndex = Join-Path $repoRoot "dist\index.html"
$assetRoot = Join-Path $androidRoot "app\src\main\assets\public"
$assetIndex = Join-Path $assetRoot "index.html"
$capacitorCli = Join-Path $repoRoot "node_modules\.bin\cap.cmd"
$androidStrings = Join-Path $androidRoot "app\src\main\res\values\strings.xml"

if (-not (Test-Path -LiteralPath $capacitorCli -PathType Leaf)) {
  throw "Capacitor CLI was not found at $capacitorCli. Run npm install first."
}
if (-not (Test-Path -LiteralPath $androidStrings -PathType Leaf)) {
  throw "Android string resources were not found at $androidStrings."
}
$androidStringsText = Get-Content -LiteralPath $androidStrings -Raw
if ($androidStringsText -notmatch '<string name="default_web_client_id">[^<]+\.apps\.googleusercontent\.com</string>' -or $androidStringsText -match 'WILL_BE_OVERRIDDEN') {
  throw "Android Google sign-in is missing a valid default_web_client_id. Native login would build but fail at runtime."
}
foreach ($requiredFirebaseResource in @("google_app_id", "google_api_key", "gcm_defaultSenderId", "project_id")) {
  if ($androidStringsText -notmatch ('<string name="' + [regex]::Escape($requiredFirebaseResource) + '">[^<]+</string>')) {
    throw "Android Firebase initialization is missing the public resource $requiredFirebaseResource."
  }
}

Push-Location $repoRoot
try {
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  if (-not (Test-Path -LiteralPath $distIndex -PathType Leaf)) {
    throw "Production renderer index was not created at $distIndex."
  }

  & $capacitorCli sync android
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}

if (-not (Test-Path -LiteralPath $assetIndex -PathType Leaf)) {
  throw "Android renderer index was not copied to $assetIndex."
}
if ((Get-Sha256Hex $distIndex) -ne (Get-Sha256Hex $assetIndex)) {
  throw "Android assets index.html does not match the current production dist."
}

$assetText = (Get-ChildItem -LiteralPath $assetRoot -Recurse -File -Include *.html,*.js,*.css | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw }) -join "`n"
foreach ($requiredText in @("自动讲话", "按住讲话", "点击录音", "语音回复速度")) {
  if ($assetText -notlike "*$requiredText*") {
    throw "Android assets are missing production voice UI text: $requiredText"
  }
}

Write-Host "Verified Android web assets: $assetRoot"
Write-Host "Verified Android native Google OAuth client resource."
