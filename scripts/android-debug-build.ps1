$ErrorActionPreference = "Stop"

$jdk = "C:\Program Files\Java\jdk-21"
if (-not (Test-Path (Join-Path $jdk "bin\java.exe"))) {
  throw "JDK 21 not found at $jdk. Install JDK 21 or update scripts/android-debug-build.ps1."
}

$env:JAVA_HOME = $jdk
$env:Path = "$jdk\bin;$env:Path"
$env:GRADLE_OPTS = "-Dhttps.protocols=TLSv1.2,TLSv1.3 -Djava.net.preferIPv4Stack=true $env:GRADLE_OPTS"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $repoRoot
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  npx cap sync android
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $assetRoot = Join-Path (Join-Path $repoRoot "android") "app\src\main\assets\public"
  $assetText = (Get-ChildItem -LiteralPath $assetRoot -Recurse -File | Get-Content -Raw) -join "`n"
  foreach ($requiredText in @("自动讲话", "按住讲话", "点击录音", "语音回复速度")) {
    if ($assetText -notlike "*$requiredText*") { throw "Android assets are missing production voice UI text: $requiredText" }
  }
} finally {
  Pop-Location
}

Push-Location "$PSScriptRoot\..\android"
try {
  .\gradlew.bat assembleDebug
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
} finally {
  Pop-Location
}
