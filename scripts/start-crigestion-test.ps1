param(
  [ValidateRange(1, 65535)]
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$testEnvFile = Join-Path $root ".env.test.local"
$source = ""
$value = $env:TEST_DATABASE_URL

if ($value) {
  $source = "TEST_DATABASE_URL"
} elseif (Test-Path -LiteralPath $testEnvFile) {
  $line = Get-Content -LiteralPath $testEnvFile |
    Where-Object { $_ -match '^DATABASE_URL=' } |
    Select-Object -First 1
  if (-not $line) { throw "TEST_DATABASE_URL_MISSING" }
  $value = ($line -split '=', 2)[1].Trim().Trim('"').Trim("'")
  $source = ".env.test.local"
} else {
  $localEnvFile = Join-Path $root ".env.local"
  if (-not (Test-Path -LiteralPath $localEnvFile)) { throw "TEST_DATABASE_ENV_FILE_MISSING" }
  $line = Get-Content -LiteralPath $localEnvFile |
    Where-Object { $_ -match '^DATABASE_URL=' } |
    Select-Object -First 1
  if (-not $line) { throw "TEST_DATABASE_URL_MISSING" }
  $value = ($line -split '=', 2)[1].Trim().Trim('"').Trim("'")
  $source = "local-safe-fallback"
}

$builder = [System.UriBuilder]::new($value)
if ($builder.Scheme -notin @("postgres", "postgresql")) { throw "TEST_DATABASE_URL_INVALID" }
if ($builder.Host -notin @("localhost", "127.0.0.1", "::1", "[::1]")) { throw "TEST_DATABASE_HOST_NOT_LOCAL" }

if ($source -eq "local-safe-fallback") {
  if ($builder.Path.Trim('/') -ne "crigestion") { throw "TEST_DATABASE_SOURCE_INVALID" }
  $builder.Path = "/crigestion_test"
} elseif ($builder.Path.Trim('/') -ne "crigestion_test") {
  throw "TEST_DATABASE_NAME_INVALID"
}

$env:DATABASE_URL = $builder.Uri.AbsoluteUri
$env:APP_ENV = "test"
$env:APP_BASE_URL = "http://localhost:$Port"
$env:VERIFACTU_ENABLED = "true"
$env:VERIFACTU_ENVIRONMENT = "TEST"
$env:VERIFACTU_WORKER_ENVIRONMENT = "TEST"
$env:VERIFACTU_WORKER_ALLOW_PRODUCTION = "false"

Write-Host "CriGestion TEST -> base crigestion_test local, puerto $Port ($source)"
& npm.cmd run dev -- -p $Port
exit $LASTEXITCODE
