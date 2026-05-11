param(
    [string]$CodexHome = "$HOME\.codex",
    [string]$ClaudeHome = "$HOME\.claude"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "SessionDataConfig.ps1")
$dataRoot = Get-SessionDataRoot -RepoRoot $repoRoot
$dataRepoRoot = Get-SessionDataRepoRoot -DataRoot $dataRoot
if ([string]::IsNullOrWhiteSpace($dataRepoRoot) -or $dataRepoRoot -eq $repoRoot) {
    throw "SESSION_DATA_ROOT must be inside a separate private Git data repository. Current value: $dataRoot"
}
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

Push-Location $dataRepoRoot
try {
    Invoke-Git -Arguments @("pull", "--ff-only", "origin", (Get-CurrentGitBranch))
}
finally {
    Pop-Location
}

& $psExe -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Cleanup-LocalBloat.ps1") -RepoRoot $repoRoot
& $psExe -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Import-CodexSessions.ps1") -CodexHome $CodexHome -ClaudeHome $ClaudeHome -SkipBackup
