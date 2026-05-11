param(
    [string]$CodexHome = "$HOME\.codex",
    [string]$ClaudeHome = "$HOME\.claude",
    [string]$Message = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "SessionDataConfig.ps1")
$dataRoot = Get-SessionDataRoot -RepoRoot $repoRoot
$dataRepoRoot = Get-SessionDataRepoRoot -DataRoot $dataRoot
if ([string]::IsNullOrWhiteSpace($dataRepoRoot) -or $dataRepoRoot -eq $repoRoot) {
    throw "SESSION_DATA_ROOT must be inside a separate private Git data repository. Current value: $dataRoot"
}
$cacheRoot = Join-Path $repoRoot ".cache"
$stageRoot = Join-Path $cacheRoot ("push-stage-" + (Get-Date -Format "yyyyMMdd-HHmmss"))

$psExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { "pwsh" } else { "powershell" }

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    & git @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function Get-CurrentGitBranch {
    $branch = git branch --show-current
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($branch)) {
        throw "git branch --show-current failed or returned an empty branch"
    }
    return $branch.Trim()
}

function Invoke-DataRepoPull {
    Push-Location $dataRepoRoot
    $stashCreated = $false
    try {
        $status = git status --porcelain
        if ($status) {
            Invoke-Git -Arguments @("stash", "push", "--include-untracked", "-m", "auto-stash ai session data before finish pull")
            $stashCreated = $true
            Write-Host "Temporarily stashed existing data repository changes before pull."
        }
        Invoke-Git -Arguments @("pull", "--rebase", "origin", (Get-CurrentGitBranch))
        if ($stashCreated) {
            Invoke-Git -Arguments @("stash", "pop")
            Write-Host "Restored existing data repository changes after pull."
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-DataRepoCommitAndPush {
    param(
        [string]$CommitMessage
    )

    Push-Location $dataRepoRoot
    try {
        Invoke-Git -Arguments @("add", "-A")
        $status = git status --porcelain
        if (-not $status) {
            Write-Host "No data repository changes to commit."
            return $false
        }

        Invoke-Git -Arguments @("commit", "-m", $CommitMessage)
        Invoke-Git -Arguments @("push", "origin", (Get-CurrentGitBranch))
        return $true
    }
    finally {
        Pop-Location
    }
}

function Sync-Directory {
    param(
        [string]$Source,
        [string]$Target
    )

    if (-not (Test-Path $Source)) {
        return
    }

    New-Item -ItemType Directory -Force $Target | Out-Null
    & robocopy $Source $Target /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP /XO | Out-Null
    $exitCode = $LASTEXITCODE
    if ($exitCode -gt 7) {
        throw "robocopy failed for '$Source' -> '$Target' with exit code $exitCode"
    }
}

function Merge-LineFile {
    param(
        [string]$Source,
        [string]$Target
    )

    if (-not (Test-Path $Source)) {
        return
    }

    $targetDir = Split-Path -Parent $Target
    New-Item -ItemType Directory -Force $targetDir | Out-Null

    $lines = New-Object System.Collections.Generic.List[string]
    $seen = New-Object System.Collections.Generic.HashSet[string]

    foreach ($path in @($Target, $Source)) {
        if (-not (Test-Path $path)) {
            continue
        }

        foreach ($line in Get-Content $path) {
            if ($seen.Add($line)) {
                [void]$lines.Add($line)
            }
        }
    }

    Set-Content -Path $Target -Value $lines -Encoding utf8
}

New-Item -ItemType Directory -Force $cacheRoot | Out-Null
& $psExe -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Export-CodexSessions.ps1") -CodexHome $CodexHome -ClaudeHome $ClaudeHome -TargetRoot $stageRoot
Sync-Directory -Source (Join-Path $cacheRoot "session-explorer\summaries") -Target (Join-Path $stageRoot "session_summaries")
Sync-Directory -Source (Join-Path $dataRoot "session_summaries") -Target (Join-Path $stageRoot "session_summaries")

if ([string]::IsNullOrWhiteSpace($Message)) {
    $Message = "Sync AI coding sessions $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
}

Push-Location $repoRoot
try {
    Invoke-DataRepoPull

    Sync-Directory -Source (Join-Path $stageRoot "sessions") -Target (Join-Path $dataRoot "sessions")
    Sync-Directory -Source (Join-Path $stageRoot "archived_sessions") -Target (Join-Path $dataRoot "archived_sessions")
    Sync-Directory -Source (Join-Path $stageRoot "claude\projects") -Target (Join-Path $dataRoot "claude\projects")
    Sync-Directory -Source (Join-Path $stageRoot "session_summaries") -Target (Join-Path $dataRoot "session_summaries")
    Merge-LineFile -Source (Join-Path $stageRoot "session_index.jsonl") -Target (Join-Path $dataRoot "session_index.jsonl")
    Merge-LineFile -Source (Join-Path $stageRoot "claude\history.jsonl") -Target (Join-Path $dataRoot "claude\history.jsonl")

    [void](Invoke-DataRepoCommitAndPush -CommitMessage $Message)
    Write-Host "External data repository synced at $dataRepoRoot"
    exit 0
}
finally {
    Pop-Location
    if (Test-Path $stageRoot) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
}
