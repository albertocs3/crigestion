param(
  [string]$EnvironmentFile = ".env.vitest.local",
  [int]$Port = 3200
)

$ErrorActionPreference = "Stop"

if ($Port -lt 1024 -or $Port -gt 65535) {
  throw "LOCAL_SMOKE_PORT_INVALID"
}

$environmentPath = (Resolve-Path -LiteralPath $EnvironmentFile).Path
$existingListener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existingListener) {
  throw "LOCAL_SMOKE_PORT_IN_USE"
}

$smokeId = [Guid]::NewGuid().ToString("N")
$stdoutPath = Join-Path ([IO.Path]::GetTempPath()) "crigestion-smoke-$smokeId.out.log"
$stderrPath = Join-Path ([IO.Path]::GetTempPath()) "crigestion-smoke-$smokeId.err.log"
$server = $null
Add-Type -AssemblyName System.Net.Http
$httpClient = New-Object System.Net.Http.HttpClient

$env:NODE_ENV = "test"
# The disposable CI database is intentionally not the canonical operational
# TEST database. Use the local profile so the smoke checks artifact startup and
# connectivity without weakening the runtime isolation enforced for APP_ENV=test.
$env:APP_ENV = "development"
$env:APP_BASE_URL = "http://127.0.0.1:$Port"
$env:VERIFACTU_ENABLED = "false"

try {
  $server = Start-Process -FilePath "node" -ArgumentList @(
    "--env-file=$environmentPath",
    "./node_modules/next/dist/bin/next",
    "start",
    "-H",
    "127.0.0.1",
    "-p",
    $Port.ToString()
  ) -WorkingDirectory $PSScriptRoot\.. -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru

  $health = $null
  for ($attempt = 1; $attempt -le 30; $attempt += 1) {
    if ($server.HasExited) {
      break
    }
    try {
      $response = $httpClient.GetAsync("http://127.0.0.1:$Port/api/health").GetAwaiter().GetResult()
      $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      if ($content) {
        $health = $content | ConvertFrom-Json
        $health | Add-Member -NotePropertyName httpStatus -NotePropertyValue ([int]$response.StatusCode)
        break
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }

  if ($null -eq $health) {
    Get-Content -LiteralPath $stdoutPath -ErrorAction SilentlyContinue
    Get-Content -LiteralPath $stderrPath -ErrorAction SilentlyContinue
    throw "LOCAL_SMOKE_HEALTH_UNAVAILABLE"
  }
  if (
    $health.httpStatus -ne 200 -or
    $health.status -ne "ok" -or
    $health.database -ne "ok" -or
    $health.verifactu -ne "disabled" -or
    $health.worker -ne "not_required"
  ) {
    $health | Select-Object httpStatus, status, database, verifactu, worker | ConvertTo-Json -Compress
    throw "LOCAL_SMOKE_HEALTH_UNEXPECTED"
  }

  $health | Select-Object httpStatus, status, database, verifactu, worker | ConvertTo-Json -Compress
} finally {
  $httpClient.Dispose()
  if ($null -ne $server -and -not $server.HasExited) {
    Stop-Process -Id $server.Id
    $server.WaitForExit(5000) | Out-Null
    if (-not $server.HasExited) {
      Stop-Process -Id $server.Id -Force
      $server.WaitForExit()
    }
  }
  Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
}
