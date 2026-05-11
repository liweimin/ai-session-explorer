param(
    [string]$CodexHome = "$HOME\.codex",
    [string]$ClaudeHome = "$HOME\.claude",
    [switch]$SkipClaudeCode,
    [switch]$SkipBackup
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "SessionDataConfig.ps1")
$dataRoot = Get-SessionDataRoot -RepoRoot $repoRoot
$backupRoot = Join-Path $repoRoot "_backups"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = Join-Path $backupRoot "import-$timestamp"

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

function Backup-IfPresent {
    param(
        [string]$PathToBackup,
        [string]$BackupTarget
    )

    if (-not (Test-Path $PathToBackup)) {
        return
    }

    $backupParent = Split-Path -Parent $BackupTarget
    New-Item -ItemType Directory -Force $backupParent | Out-Null
    Copy-Item -Recurse -Force $PathToBackup $BackupTarget
}

if (-not $SkipBackup) {
    Backup-IfPresent -PathToBackup (Join-Path $CodexHome "sessions") -BackupTarget (Join-Path $backupDir "sessions")
    Backup-IfPresent -PathToBackup (Join-Path $CodexHome "archived_sessions") -BackupTarget (Join-Path $backupDir "archived_sessions")
    Backup-IfPresent -PathToBackup (Join-Path $CodexHome "session_index.jsonl") -BackupTarget (Join-Path $backupDir "session_index.jsonl")
    if (-not $SkipClaudeCode) {
        Backup-IfPresent -PathToBackup (Join-Path $ClaudeHome "projects") -BackupTarget (Join-Path $backupDir "claude\projects")
        Backup-IfPresent -PathToBackup (Join-Path $ClaudeHome "history.jsonl") -BackupTarget (Join-Path $backupDir "claude\history.jsonl")
    }
    Write-Host "Backup completed to $backupDir"
}

Sync-Directory -Source (Join-Path $dataRoot "sessions") -Target (Join-Path $CodexHome "sessions")
Sync-Directory -Source (Join-Path $dataRoot "archived_sessions") -Target (Join-Path $CodexHome "archived_sessions")
Sync-File -Source (Join-Path $dataRoot "session_index.jsonl") -Target (Join-Path $CodexHome "session_index.jsonl")

if (-not $SkipClaudeCode) {
    $claudeDataRoot = Join-Path $dataRoot "claude"
    Sync-Directory -Source (Join-Path $claudeDataRoot "projects") -Target (Join-Path $ClaudeHome "projects")
    Sync-File -Source (Join-Path $claudeDataRoot "history.jsonl") -Target (Join-Path $ClaudeHome "history.jsonl")
}

Write-Host "Codex import completed from $dataRoot to $CodexHome"
if (-not $SkipClaudeCode) {
    Write-Host "Claude Code import completed from $(Join-Path $dataRoot 'claude') to $ClaudeHome"
}
