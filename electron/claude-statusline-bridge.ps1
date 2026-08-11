param(
  [Parameter(Mandatory = $true)]
  [string]$SnapshotPath
)

$ErrorActionPreference = "Stop"

function Convert-ToPercent($Value) {
  if ($null -eq $Value) { return $null }
  $parsed = 0.0
  if (-not [double]::TryParse(
      [string]$Value,
      [Globalization.NumberStyles]::Float,
      [Globalization.CultureInfo]::InvariantCulture,
      [ref]$parsed
    )) {
    return $null
  }
  return [Math]::Min(100.0, [Math]::Max(0.0, $parsed))
}

function Convert-ToTokenCount($Value) {
  if ($null -eq $Value) { return $null }
  $parsed = 0L
  if (-not [long]::TryParse(
      [string]$Value,
      [Globalization.NumberStyles]::Integer,
      [Globalization.CultureInfo]::InvariantCulture,
      [ref]$parsed
    )) {
    return $null
  }
  if ($parsed -lt 0) { return $null }
  return $parsed
}

function Convert-ToEpoch($Value) {
  if ($null -eq $Value) { return $null }
  $parsed = 0L
  if (-not [long]::TryParse(
      [string]$Value,
      [Globalization.NumberStyles]::Integer,
      [Globalization.CultureInfo]::InvariantCulture,
      [ref]$parsed
    )) {
    return $null
  }
  if ($parsed -le 0) { return $null }
  return $parsed
}

function Write-UsageStatus($FiveHourUsed, $WeeklyUsed, $ContextTotal) {
  $segments = @()
  if ($null -ne $FiveHourUsed) {
    $segments += ("5h {0:N0}%" -f $FiveHourUsed)
  }
  if ($null -ne $WeeklyUsed) {
    $segments += ("7d {0:N0}%" -f $WeeklyUsed)
  }
  if ($null -ne $ContextTotal -and $ContextTotal -gt 0) {
    $segments += ("context {0:N0}t" -f $ContextTotal)
  }
  if ($segments.Count -gt 0) {
    Write-Output ("TokenCat | " + ($segments -join " | "))
  } else {
    Write-Output "TokenCat"
  }
}

function Test-IsOlderWindow(
  $IncomingUsed,
  $IncomingReset,
  $ExistingUsed,
  $ExistingReset
) {
  if ($null -eq $IncomingUsed -and $null -eq $IncomingReset) {
    return $false
  }
  if ($null -ne $IncomingReset -and $null -ne $ExistingReset) {
    if ($IncomingReset -lt $ExistingReset) { return $true }
    if ($IncomingReset -gt $ExistingReset) { return $false }
  }
  return (
    $null -ne $IncomingUsed -and
    $null -ne $ExistingUsed -and
    $IncomingUsed -lt $ExistingUsed
  )
}

$temporaryPath = $null
$backupPath = $null
$lockStream = $null

try {
  $rawInput = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($rawInput)) {
    Write-Output "TokenCat"
    exit 0
  }

  $session = $rawInput | ConvertFrom-Json
  $fiveHourUsed = Convert-ToPercent $session.rate_limits.five_hour.used_percentage
  $fiveHourReset = Convert-ToEpoch $session.rate_limits.five_hour.resets_at
  $weeklyUsed = Convert-ToPercent $session.rate_limits.seven_day.used_percentage
  $weeklyReset = Convert-ToEpoch $session.rate_limits.seven_day.resets_at
  $contextInput = Convert-ToTokenCount $session.context_window.total_input_tokens
  $contextOutput = Convert-ToTokenCount $session.context_window.total_output_tokens
  $contextWindowSize = Convert-ToTokenCount $session.context_window.context_window_size
  $contextUsedPercent = Convert-ToPercent $session.context_window.used_percentage

  # Claude Code 2.1.132+ reports the current context rather than cumulative
  # session totals. Fall back to the component fields for older/partial input.
  if ($null -eq $contextInput) {
    $currentInput = Convert-ToTokenCount $session.context_window.current_usage.input_tokens
    $cacheCreation = Convert-ToTokenCount $session.context_window.current_usage.cache_creation_input_tokens
    $cacheRead = Convert-ToTokenCount $session.context_window.current_usage.cache_read_input_tokens
    if (
      $null -ne $currentInput -or
      $null -ne $cacheCreation -or
      $null -ne $cacheRead
    ) {
      $contextInput =
        $(if ($null -ne $currentInput) { $currentInput } else { 0 }) +
        $(if ($null -ne $cacheCreation) { $cacheCreation } else { 0 }) +
        $(if ($null -ne $cacheRead) { $cacheRead } else { 0 })
    }
  }
  if ($null -eq $contextOutput) {
    $contextOutput =
      Convert-ToTokenCount $session.context_window.current_usage.output_tokens
  }
  $hasIncomingContext = (
    ($null -ne $contextInput -or $null -ne $contextOutput) -and
    (
      $(if ($null -ne $contextInput) { $contextInput } else { 0 }) +
      $(if ($null -ne $contextOutput) { $contextOutput } else { 0 })
    ) -gt 0
  )
  if ($hasIncomingContext) {
    if ($null -eq $contextInput) { $contextInput = 0 }
    if ($null -eq $contextOutput) { $contextOutput = 0 }
    if ($null -eq $contextWindowSize -or $contextWindowSize -le 0) {
      $contextWindowSize = $null
    }
  }

  # rate_limits can be absent until the first Claude response. Keep the last
  # valid snapshot instead of replacing it with an empty one. Context tokens
  # can still be useful when a rate-limit window is independently absent.
  if (
    $null -eq $fiveHourUsed -and
    $null -eq $fiveHourReset -and
    $null -eq $weeklyUsed -and
    $null -eq $weeklyReset -and
    -not $hasIncomingContext
  ) {
    Write-Output "TokenCat"
    exit 0
  }

  $directory = [IO.Path]::GetDirectoryName($SnapshotPath)
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  $lockPath = $SnapshotPath + ".lock"
  for ($attempt = 0; $attempt -lt 20 -and $null -eq $lockStream; $attempt++) {
    try {
      $lockStream = [IO.File]::Open(
        $lockPath,
        [IO.FileMode]::OpenOrCreate,
        [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::None
      )
    } catch [IO.IOException] {
      Start-Sleep -Milliseconds 25
    }
  }
  if ($null -eq $lockStream) {
    Write-Output "TokenCat"
    exit 0
  }

  $existingFiveHourUsed = $null
  $existingFiveHourReset = $null
  $existingWeeklyUsed = $null
  $existingWeeklyReset = $null
  $existingUsageUpdatedAt = $null
  $existingContextInput = $null
  $existingContextOutput = $null
  $existingContextWindowSize = $null
  $existingContextUsedPercent = $null
  $existingContextObservedAt = $null
  if ([IO.File]::Exists($SnapshotPath)) {
    try {
      $existing = [IO.File]::ReadAllText($SnapshotPath) | ConvertFrom-Json
      $existingFiveHourUsed = Convert-ToPercent $existing.fiveHour.usedPercent
      $existingFiveHourReset = Convert-ToEpoch $existing.fiveHour.resetsAt
      $existingWeeklyUsed = Convert-ToPercent $existing.weekly.usedPercent
      $existingWeeklyReset = Convert-ToEpoch $existing.weekly.resetsAt
      if ($existing.usageUpdatedAt -is [string]) {
        $existingUsageUpdatedAt = $existing.usageUpdatedAt
      }
      $existingContextInput =
        Convert-ToTokenCount $existing.contextTokens.inputTokens
      $existingContextOutput =
        Convert-ToTokenCount $existing.contextTokens.outputTokens
      $existingContextWindowSize =
        Convert-ToTokenCount $existing.contextTokens.contextWindowSize
      $existingContextUsedPercent =
        Convert-ToPercent $existing.contextTokens.usedPercent
      if ($existing.contextTokens.observedAt -is [string]) {
        $existingContextObservedAt = $existing.contextTokens.observedAt
      }
    } catch {
      # A malformed external snapshot is replaced by the validated input.
    }
  }
  if ($null -eq $existingFiveHourUsed -or $null -eq $existingFiveHourReset) {
    $existingFiveHourUsed = $null
    $existingFiveHourReset = $null
  }
  if ($null -eq $existingWeeklyUsed -or $null -eq $existingWeeklyReset) {
    $existingWeeklyUsed = $null
    $existingWeeklyReset = $null
  }

  # Different Claude sessions can report the same allowance at different
  # points in time. Never let an older reset window or a lower percentage in
  # the same window overwrite a newer observation.
  $olderFiveHour = Test-IsOlderWindow `
    $fiveHourUsed `
    $fiveHourReset `
    $existingFiveHourUsed `
    $existingFiveHourReset
  $olderWeekly = Test-IsOlderWindow `
    $weeklyUsed `
    $weeklyReset `
    $existingWeeklyUsed `
    $existingWeeklyReset

  $incomingFiveHour = (
    $null -ne $fiveHourUsed -and
    $null -ne $fiveHourReset
  )
  $incomingWeekly = (
    $null -ne $weeklyUsed -and
    $null -ne $weeklyReset
  )
  $acceptFiveHour = $incomingFiveHour -and -not $olderFiveHour
  $acceptWeekly = $incomingWeekly -and -not $olderWeekly
  $changedFiveHour = $acceptFiveHour -and (
    ($null -ne $fiveHourUsed -and $fiveHourUsed -ne $existingFiveHourUsed) -or
    ($null -ne $fiveHourReset -and $fiveHourReset -ne $existingFiveHourReset)
  )
  $changedWeekly = $acceptWeekly -and (
    ($null -ne $weeklyUsed -and $weeklyUsed -ne $existingWeeklyUsed) -or
    ($null -ne $weeklyReset -and $weeklyReset -ne $existingWeeklyReset)
  )
  $changedContext = $hasIncomingContext -and (
    $contextInput -ne $existingContextInput -or
    $contextOutput -ne $existingContextOutput -or
    $contextWindowSize -ne $existingContextWindowSize -or
    $contextUsedPercent -ne $existingContextUsedPercent
  )

  if (-not $changedFiveHour -and -not $changedWeekly -and -not $changedContext) {
    $existingContextTotal = $null
    if (
      $null -ne $existingContextInput -and
      $null -ne $existingContextOutput
    ) {
      $existingContextTotal =
        $existingContextInput + $existingContextOutput
    }
    Write-UsageStatus `
      $existingFiveHourUsed `
      $existingWeeklyUsed `
      $existingContextTotal
    exit 0
  }

  if (-not $acceptFiveHour) {
    $fiveHourUsed = $existingFiveHourUsed
    $fiveHourReset = $existingFiveHourReset
  } else {
    if ($null -eq $fiveHourUsed) { $fiveHourUsed = $existingFiveHourUsed }
    if ($null -eq $fiveHourReset) { $fiveHourReset = $existingFiveHourReset }
  }
  if (-not $acceptWeekly) {
    $weeklyUsed = $existingWeeklyUsed
    $weeklyReset = $existingWeeklyReset
  } else {
    if ($null -eq $weeklyUsed) { $weeklyUsed = $existingWeeklyUsed }
    if ($null -eq $weeklyReset) { $weeklyReset = $existingWeeklyReset }
  }

  $usageUpdatedAt = $existingUsageUpdatedAt
  if ($changedFiveHour -or $changedWeekly) {
    $usageUpdatedAt = [DateTimeOffset]::UtcNow.ToString("o")
  }

  if ($hasIncomingContext) {
    $contextObservedAt = [DateTimeOffset]::UtcNow.ToString("o")
  } else {
    $contextInput = $existingContextInput
    $contextOutput = $existingContextOutput
    $contextWindowSize = $existingContextWindowSize
    $contextUsedPercent = $existingContextUsedPercent
    $contextObservedAt = $existingContextObservedAt
  }
  $contextSnapshot = $null
  if ($null -ne $contextInput -and $null -ne $contextOutput) {
    $contextSnapshot = [ordered]@{
      inputTokens = $contextInput
      outputTokens = $contextOutput
      contextWindowSize = $contextWindowSize
      usedPercent = $contextUsedPercent
      observedAt = $contextObservedAt
    }
  }

  $snapshot = [ordered]@{
    fiveHour = [ordered]@{
      usedPercent = $fiveHourUsed
      resetsAt = $fiveHourReset
    }
    weekly = [ordered]@{
      usedPercent = $weeklyUsed
      resetsAt = $weeklyReset
    }
    usageUpdatedAt = $usageUpdatedAt
    contextTokens = $contextSnapshot
    updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
  }

  $temporaryPath = Join-Path $directory (
    "." + [IO.Path]::GetFileName($SnapshotPath) + "." +
    [Guid]::NewGuid().ToString("N") + ".tmp"
  )
  $json = $snapshot | ConvertTo-Json -Compress -Depth 4
  [IO.File]::WriteAllText(
    $temporaryPath,
    $json,
    [Text.UTF8Encoding]::new($false)
  )

  if ([IO.File]::Exists($SnapshotPath)) {
    $backupPath = $temporaryPath + ".bak"
    [IO.File]::Replace($temporaryPath, $SnapshotPath, $backupPath, $true)
    [IO.File]::Delete($backupPath)
    $backupPath = $null
  } else {
    [IO.File]::Move($temporaryPath, $SnapshotPath)
  }
  $temporaryPath = $null

  $contextTotal = $null
  if ($null -ne $contextInput -and $null -ne $contextOutput) {
    $contextTotal = $contextInput + $contextOutput
  }
  Write-UsageStatus $fiveHourUsed $weeklyUsed $contextTotal
} catch {
  # Status lines should never interrupt Claude Code. Do not echo the input or
  # exception because either can contain local/session information.
  Write-Output "TokenCat"
  exit 0
} finally {
  if ($null -ne $temporaryPath -and [IO.File]::Exists($temporaryPath)) {
    [IO.File]::Delete($temporaryPath)
  }
  if ($null -ne $backupPath -and [IO.File]::Exists($backupPath)) {
    [IO.File]::Delete($backupPath)
  }
  if ($null -ne $lockStream) {
    $lockStream.Dispose()
  }
}
