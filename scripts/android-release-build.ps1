$ErrorActionPreference = "Stop"

$jdk = "C:\Program Files\Java\jdk-21"
if (-not (Test-Path (Join-Path $jdk "bin\java.exe"))) {
  throw "JDK 21 not found at $jdk. Install JDK 21 or update scripts/android-release-build.ps1."
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$androidRoot = Join-Path $repoRoot "android"
$keystoreProperties = Join-Path $androidRoot "keystore.properties"

if (-not (Test-Path $keystoreProperties)) {
  throw "Missing android\keystore.properties. Create a release keystore before building a release APK."
}

# Always rebuild the web renderer and copy it into Android assets. Running this
# script directly must never package stale app assets from a previous build.
Push-Location $repoRoot
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  npx cap sync android
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}

$env:JAVA_HOME = $jdk
$env:Path = "$jdk\bin;$env:Path"
$env:GRADLE_OPTS = "-Dhttps.protocols=TLSv1.2,TLSv1.3 -Djava.net.preferIPv4Stack=true $env:GRADLE_OPTS"

Push-Location $androidRoot
try {
  .\gradlew.bat assembleRelease
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
} finally {
  Pop-Location
}

$sourceApk = Join-Path $androidRoot "app\build\outputs\apk\release\app-release.apk"
if (-not (Test-Path $sourceApk)) {
  throw "Release APK was not created at $sourceApk."
}

$releaseDir = Join-Path $repoRoot "dev-dist\release"
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null

$targetApk = Join-Path $releaseDir "学习日志.apk"
Copy-Item -Force -Path $sourceApk -Destination $targetApk

$buildToolsRoot = Join-Path $env:LOCALAPPDATA "Android\Sdk\build-tools"
$aapt = Get-ChildItem -LiteralPath $buildToolsRoot -Directory |
  Sort-Object { [version]$_.Name } -Descending |
  ForEach-Object { Join-Path $_.FullName "aapt.exe" } |
  Where-Object { Test-Path -LiteralPath $_ } |
  Select-Object -First 1
if (-not $aapt) {
  throw "Android aapt.exe was not found under $buildToolsRoot."
}

$badgingOutput = & $aapt dump badging $targetApk
$aaptExitCode = $LASTEXITCODE
$badging = (($badgingOutput | Where-Object { $_ -match "^package:" } | Select-Object -First 1) -join "")
if ($aaptExitCode -ne 0 -or $badging -notmatch "versionCode='14'" -or $badging -notmatch "versionName='0.2.3'") {
  throw "Release APK version check failed. Expected versionCode 14 and versionName 0.2.3; got: $badging"
}
Write-Host "Verified APK version: versionCode 14, versionName 0.2.3"

$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $hashBytes = $sha256.ComputeHash([System.IO.File]::ReadAllBytes($targetApk))
  $hashValue = ([System.BitConverter]::ToString($hashBytes)).Replace("-", "")
} finally {
  $sha256.Dispose()
}
$hashValue | Set-Content -Encoding ASCII -Path "$targetApk.sha256"

Write-Host "Release APK: $targetApk"
Write-Host "SHA256: $hashValue"
