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

function Get-DirtyRepoPaths {
    $statusLines = git status --porcelain=v1
    if ($LASTEXITCODE -ne 0) {
        throw "git status --porcelain=v1 failed with exit code $LASTEXITCODE"
    }

    $paths = New-Object System.Collections.Generic.List[string]
    foreach ($line in $statusLines) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        $path = if ($line.Length -gt 3) { $line.Substring(3).Trim() } else { "" }
        if ([string]::IsNullOrWhiteSpace($path)) {
            continue
        }

        if ($path -like "* -> *") {
            $path = ($path -split " -> ", 2)[1]
        }

        [void]$paths.Add(($path -replace "\\", "/"))
    }

    return $paths
}

function Test-IsManagedGeneratedPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $normalized = $Path -replace "\\", "/"
    return $false
}

function Test-IsIgnoredLocalPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $normalized = $Path -replace "\\", "/"
    return (
        $normalized -eq ".env.local" -or
        $normalized -eq ".env.local.example.local" -or
        $normalized.StartsWith(".venv/") -or
        $normalized -eq ".venv" -or
        $normalized.StartsWith("output/") -or
        $normalized -eq "output"
    )
}

function Protect-RepoBeforePull {
    $dirtyPaths = @(Get-DirtyRepoPaths)
    if ($dirtyPaths.Count -eq 0) {
        return
    }

    $unexpectedPaths = @($dirtyPaths | Where-Object { -not (Test-IsManagedGeneratedPath $_) -and -not (Test-IsIgnoredLocalPath $_) })
    if ($unexpectedPaths.Count -gt 0) {
        $joined = $unexpectedPaths -join ", "
        throw "Finish detected unstaged changes outside sync-managed data: $joined. Please commit, stash, or revert them first."
    }

    return
}

function Invoke-DataRepoPull {
    Push-Location $dataRepoRoot
    try {
        Invoke-Git -Arguments @("pull", "--rebase", "origin", (Get-CurrentGitBranch))
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
$autoStashRef = $null
try {
    $autoStashRef = Protect-RepoBeforePull
    Invoke-Git -Arguments @("pull", "--rebase", "origin", (Get-CurrentGitBranch))
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
    if ($autoStashRef) {
        & git stash drop $autoStashRef | Out-Null
    }
    Pop-Location
    if (Test-Path $stageRoot) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
}
