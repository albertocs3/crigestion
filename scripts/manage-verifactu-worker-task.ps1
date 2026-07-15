[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Install", "Uninstall", "Status")]
  [string]$Action
)

$ErrorActionPreference = "Stop"
$taskName = "CriGestion-VeriFactu-TEST"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$baseEnvFile = Join-Path $projectRoot ".env.local"
$testEnvFile = Join-Path $projectRoot ".env.test.local"
$workerEnvFile = Join-Path $projectRoot ".env.worker.local"

function Get-EnvironmentLine([string]$Path, [string]$Name) {
  $prefix = "$Name="
  return Get-Content -LiteralPath $Path |
    Where-Object { $_.StartsWith($prefix, [StringComparison]::Ordinal) } |
    Select-Object -Last 1
}

function Get-SafeEnvironmentValue([string]$Name) {
  if (-not (Test-Path -LiteralPath $workerEnvFile)) { throw "VERIFACTU_WORKER_ENV_FILE_NOT_FOUND" }
  $prefix = "$Name="
  $line = Get-EnvironmentLine $workerEnvFile $Name
  if (-not $line) { return $null }
  return $line.Substring($prefix.Length).Trim().Trim('"').Trim("'")
}

function New-WorkerEnvironmentFile {
  if (-not (Test-Path -LiteralPath $baseEnvFile) -or -not (Test-Path -LiteralPath $testEnvFile)) {
    throw "VERIFACTU_WORKER_ENV_SOURCE_NOT_FOUND"
  }
  $databaseLine = Get-EnvironmentLine $testEnvFile "DATABASE_URL"
  if (-not $databaseLine) { throw "VERIFACTU_WORKER_DATABASE_URL_MISSING" }
  $secretNames = @(
    "VERIFACTU_PAYLOAD_ACTIVE_KEY_ID", "VERIFACTU_PAYLOAD_KEYS",
    "VERIFACTU_CREDENTIAL_ACTIVE_KEY_ID", "VERIFACTU_CREDENTIAL_KEYS",
    "VERIFACTU_RESPONSE_ACTIVE_KEY_ID", "VERIFACTU_RESPONSE_KEYS"
  )
  $secretLines = foreach ($name in $secretNames) {
    $line = Get-EnvironmentLine $baseEnvFile $name
    if (-not $line) { throw "VERIFACTU_WORKER_KEYRING_MISSING" }
    $line
  }
  $lines = @(
    'APP_ENV="test"',
    $databaseLine,
    'VERIFACTU_ENABLED="true"',
    'VERIFACTU_ENVIRONMENT="TEST"',
    'VERIFACTU_WORKER_ENVIRONMENT="TEST"',
    'VERIFACTU_WORKER_ALLOW_PRODUCTION="false"',
    'VERIFACTU_WORKER_DEPLOYMENT_ID="windows-test"',
    'VERIFACTU_WORKER_EXPECTED_DATABASE="crigestion_test"',
    'VERIFACTU_WORKER_POLL_MS="2000"',
    'VERIFACTU_WORKER_HEARTBEAT_MS="5000"',
    'VERIFACTU_WORKER_LEASE_MS="90000"',
    'VERIFACTU_WORKER_HEALTH_STALE_SECONDS="180"'
  ) + $secretLines
  $temporary = "$workerEnvFile.$([Guid]::NewGuid().ToString('N')).tmp"
  try {
    [System.IO.File]::WriteAllLines($temporary, $lines, [System.Text.UTF8Encoding]::new($false))
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @("S-1-5-18", "S-1-5-32-544", [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)) {
      $identity = [System.Security.Principal.SecurityIdentifier]::new($sid)
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, "FullControl", "Allow")
      $acl.AddAccessRule($rule)
    }
    ([System.IO.FileInfo]::new($temporary)).SetAccessControl($acl)
    Move-Item -LiteralPath $temporary -Destination $workerEnvFile -Force
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  }
}

function Assert-TestConfiguration {
  if ((Get-SafeEnvironmentValue "VERIFACTU_ENABLED") -ne "true") {
    throw "VERIFACTU_WORKER_DISABLED"
  }
  if ((Get-SafeEnvironmentValue "APP_ENV") -eq "production") {
    throw "VERIFACTU_WORKER_TEST_SERVICE_ENVIRONMENT_INVALID"
  }
  if ((Get-SafeEnvironmentValue "APP_ENV") -ne "test") {
    throw "VERIFACTU_WORKER_TEST_SERVICE_ENVIRONMENT_INVALID"
  }
  if ((Get-SafeEnvironmentValue "VERIFACTU_WORKER_ENVIRONMENT") -ne "TEST") {
    throw "VERIFACTU_WORKER_TASK_REQUIRES_TEST"
  }
  if ((Get-SafeEnvironmentValue "VERIFACTU_ENVIRONMENT").ToUpperInvariant() -ne "TEST") {
    throw "VERIFACTU_WORKER_ENVIRONMENT_MISMATCH"
  }
  if ((Get-SafeEnvironmentValue "VERIFACTU_WORKER_ALLOW_PRODUCTION") -eq "true") {
    throw "VERIFACTU_WORKER_PRODUCTION_NOT_ALLOWED"
  }
  $expectedDatabase = Get-SafeEnvironmentValue "VERIFACTU_WORKER_EXPECTED_DATABASE"
  if ($expectedDatabase -ne "crigestion_test") {
    throw "VERIFACTU_WORKER_EXPECTED_DATABASE_INVALID"
  }
  $databaseUrl = Get-SafeEnvironmentValue "DATABASE_URL"
  try { $databaseUri = [System.UriBuilder]::new($databaseUrl) }
  catch { throw "VERIFACTU_WORKER_DATABASE_URL_INVALID" }
  if ($databaseUri.Scheme -notin @("postgres", "postgresql") -or
      $databaseUri.Host -notin @("localhost", "127.0.0.1", "::1", "[::1]") -or
      $databaseUri.Path.Trim('/') -ne $expectedDatabase) {
    throw "VERIFACTU_WORKER_DATABASE_URL_INVALID"
  }
}

switch ($Action) {
  "Install" {
    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existingTask -and $existingTask.State -eq "Running") {
      Stop-ScheduledTask -TaskName $taskName
      $deadline = [DateTime]::UtcNow.AddSeconds(15)
      do {
        Start-Sleep -Milliseconds 250
        $existingTask = Get-ScheduledTask -TaskName $taskName
      } while ($existingTask.State -eq "Running" -and [DateTime]::UtcNow -lt $deadline)
      if ($existingTask.State -eq "Running") { throw "VERIFACTU_WORKER_TASK_STOP_TIMEOUT" }
    }
    $processDeadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      $externalWorker = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like "*scripts/run-verifactu-worker.ts*" } |
        Select-Object -First 1
      if ($externalWorker) { Start-Sleep -Milliseconds 250 }
    } while ($externalWorker -and [DateTime]::UtcNow -lt $processDeadline)
    if ($externalWorker) { throw "VERIFACTU_WORKER_EXTERNAL_INSTANCE_RUNNING" }
    New-WorkerEnvironmentFile
    Assert-TestConfiguration
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
    $taskAction = New-ScheduledTaskAction `
      -Execute $nodeExecutable `
      -Argument '--env-file=.env.worker.local --conditions=react-server --import tsx scripts/run-verifactu-worker.ts --test-only' `
      -WorkingDirectory $projectRoot
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
    $watchdogTrigger = New-ScheduledTaskTrigger `
      -Once `
      -At (Get-Date).AddMinutes(1) `
      -RepetitionInterval (New-TimeSpan -Minutes 1)
    $settings = New-ScheduledTaskSettingsSet `
      -MultipleInstances IgnoreNew `
      -RestartCount 999 `
      -RestartInterval (New-TimeSpan -Minutes 1) `
      -StartWhenAvailable `
      -ExecutionTimeLimit ([TimeSpan]::Zero)
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger @($logonTrigger, $watchdogTrigger) -Settings $settings -Principal $principal -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
  }
  "Uninstall" {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
      Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
  }
  "Status" {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $task) {
      [pscustomobject]@{ TaskName = $taskName; State = "NOT_INSTALLED" }
      exit 1
    }
    $info = Get-ScheduledTaskInfo -TaskName $taskName
    [pscustomobject]@{
      TaskName = $taskName
      State = $task.State
      LastRunTime = $info.LastRunTime
      LastTaskResult = $info.LastTaskResult
      NextRunTime = $info.NextRunTime
    }
  }
}
