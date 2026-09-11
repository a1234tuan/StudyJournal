$ErrorActionPreference = "Stop"

$jdk = "C:\Program Files\Java\jdk-21"
if (-not (Test-Path (Join-Path $jdk "bin\java.exe"))) {
  throw "JDK 21 not found at $jdk. Install JDK 21 or update scripts/android-debug-build.ps1."
}

$env:JAVA_HOME = $jdk
$env:Path = "$jdk\bin;$env:Path"
$env:GRADLE_OPTS = "-Dhttps.protocols=TLSv1.2,TLSv1.3 -Djava.net.preferIPv4Stack=true $env:GRADLE_OPTS"

& (Join-Path $PSScriptRoot "android-sync.ps1")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Push-Location "$PSScriptRoot\..\android"
try {
  .\gradlew.bat assembleDebug
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
} finally {
  Pop-Location
}
