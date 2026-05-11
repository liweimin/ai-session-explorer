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
if ([string]::IsNullOrWhiteSpace($dataRepoRoot)) {
    $dataRepoRoot = $repoRoot
}
$usesExternalDataRepo = $dataRepoRoot -ne $repoRoot
$cacheRoot = Join-Path $repoRoot ".cache"
$stageRoot = Join-Path $cacheRoot ("push-stage-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
$usageGuideName = -join @([char]0x4F7F, [char]0x7528, [char]0x8BF4, [char]0x660E, ".", "m", "d")

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
    if ($usesExternalDataRepo) {
        return $false
    }
    return (
        $normalized -eq "data/session_index.jsonl" -or
        $normalized.StartsWith("data/sessions/") -or
        $normalized.StartsWith("data/archived_sessions/") -or
        $normalized.StartsWith("data/claude/") -or
        $normalized.StartsWith("data/session_summaries/")
    )
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

    $stashMessage = "auto-stash generated sync data before finish $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    $stashPaths = @(
        "data/session_index.jsonl",
        "data/sessions",
        "data/archived_sessions",
        "data/claude",
        "data/session_summaries"
    ) | Where-Object { Test-Path -LiteralPath (Join-Path $repoRoot $_) }

    $stashArgs = @("stash", "push", "--include-untracked", "-m", $stashMessage)
    if ($stashPaths.Count -gt 0) {
        $stashArgs += @("--")
        $stashArgs += $stashPaths
    }

    Invoke-Git -Arguments $stashArgs | Out-Null
    Write-Host "Temporarily stashed generated sync data so pull --rebase can proceed."

    $stashLines = @(git stash list --format="%gd %gs" --max-count=1)
    if ($LASTEXITCODE -ne 0) {
        throw "git stash list failed with exit code $LASTEXITCODE"
    }

    if ($stashLines.Count -gt 0 -and $stashLines[0] -match "^(stash@\{\d+\}) ") {
        return $Matches[1]
    }

    return $null
}

function Invoke-DataRepoPull {
    if (-not $usesExternalDataRepo) {
        return
    }

    Push-Location $dataRepoRoot
    try {
        Invoke-Git -Arguments @("pull", "--rebase", "origin", "main")
    }
    finally {
        Pop-Location
    }
}

function Invoke-DataRepoCommitAndPush {
    param(
        [string]$CommitMessage
    )

    if (-not $usesExternalDataRepo) {
        return $false
    }

    Push-Location $dataRepoRoot
    try {
        Invoke-Git -Arguments @("add", "-A")
        $status = git status --porcelain
        if (-not $status) {
            Write-Host "No data repository changes to commit."
            return $false
        }

        Invoke-Git -Arguments @("commit", "-m", $CommitMessage)
        Invoke-Git -Arguments @("push", "origin", "main")
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
    Invoke-Git -Arguments @("pull", "--rebase", "origin", "main")
    Invoke-DataRepoPull

    Sync-Directory -Source (Join-Path $stageRoot "sessions") -Target (Join-Path $dataRoot "sessions")
    Sync-Directory -Source (Join-Path $stageRoot "archived_sessions") -Target (Join-Path $dataRoot "archived_sessions")
    Sync-Directory -Source (Join-Path $stageRoot "claude\projects") -Target (Join-Path $dataRoot "claude\projects")
    Sync-Directory -Source (Join-Path $stageRoot "session_summaries") -Target (Join-Path $dataRoot "session_summaries")
    Merge-LineFile -Source (Join-Path $stageRoot "session_index.jsonl") -Target (Join-Path $dataRoot "session_index.jsonl")
    Merge-LineFile -Source (Join-Path $stageRoot "claude\history.jsonl") -Target (Join-Path $dataRoot "claude\history.jsonl")

    if ($usesExternalDataRepo) {
        [void](Invoke-DataRepoCommitAndPush -CommitMessage $Message)
        Write-Host "External data repository synced at $dataRepoRoot"
        exit 0
    }

    $addPaths = @(
        "data/session_index.jsonl",
        "data/sessions",
        "data/archived_sessions",
        "data/claude",
        "data/session_summaries",
        "Session-Explorer.html",
        "Open-SessionExplorer.bat",
        "Start-CodexWork.bat",
        "Finish-CodexWork.bat",
        "scripts/Export-CodexSessions.ps1",
        "scripts/Import-CodexSessions.ps1",
        "scripts/session-explorer-server.mjs",
        "scripts/Cleanup-LocalBloat.ps1",
        "scripts/Push-CodexSessions.ps1",
        "scripts/Pull-CodexSessions.ps1",
        "scripts/SessionDataConfig.ps1",
        "README.md",
        $usageGuideName,
        ".gitignore"
    ) | Where-Object { Test-Path -LiteralPath (Join-Path $repoRoot $_) }

    $addArgs = @("add", "-A")
    $addArgs += $addPaths
    Invoke-Git -Arguments $addArgs

    $status = git status --porcelain
    if (-not $status) {
        Write-Host "No session changes to commit."
        exit 0
    }

    Invoke-Git -Arguments @("commit", "-m", $Message)
    Invoke-Git -Arguments @("push", "origin", "main")
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
