param(
    [string]$CodexHome = "$HOME\.codex",
    [string]$ClaudeHome = "$HOME\.claude",
    [string]$TargetRoot = "",
    [switch]$SkipClaudeCode
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "SessionDataConfig.ps1")
$dataRoot = if ([string]::IsNullOrWhiteSpace($TargetRoot)) {
    Get-SessionDataRoot -RepoRoot $repoRoot
}
else {
    $TargetRoot
}

function Sync-Directory {
    param(
        [string]$Source,
        [string]$Target
    )

    if (-not (Test-Path $Source)) {
        Write-Host "Skip missing directory: $Source"
        return
    }

    New-Item -ItemType Directory -Force $Target | Out-Null
    & robocopy $Source $Target /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP /XO | Out-Null
    $exitCode = $LASTEXITCODE
    if ($exitCode -gt 7) {
        throw "robocopy failed for '$Source' -> '$Target' with exit code $exitCode"
    }
}

function Sync-File {
    param(
        [string]$Source,
        [string]$Target
    )

    if (-not (Test-Path $Source)) {
        Write-Host "Skip missing file: $Source"
        return
    }

    $targetDir = Split-Path -Parent $Target
    New-Item -ItemType Directory -Force $targetDir | Out-Null
    Copy-Item -Force $Source $Target
}

Sync-Directory -Source (Join-Path $CodexHome "sessions") -Target (Join-Path $dataRoot "sessions")
Sync-Directory -Source (Join-Path $CodexHome "archived_sessions") -Target (Join-Path $dataRoot "archived_sessions")
Sync-File -Source (Join-Path $CodexHome "session_index.jsonl") -Target (Join-Path $dataRoot "session_index.jsonl")

if (-not $SkipClaudeCode) {
    $claudeDataRoot = Join-Path $dataRoot "claude"
    Sync-Directory -Source (Join-Path $ClaudeHome "projects") -Target (Join-Path $claudeDataRoot "projects")
    Sync-File -Source (Join-Path $ClaudeHome "history.jsonl") -Target (Join-Path $claudeDataRoot "history.jsonl")
}

Write-Host "Codex export completed from $CodexHome to $dataRoot"
if (-not $SkipClaudeCode) {
    Write-Host "Claude Code export completed from $ClaudeHome to $(Join-Path $dataRoot 'claude')"
}
