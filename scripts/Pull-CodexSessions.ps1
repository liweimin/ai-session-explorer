param(
    [string]$CodexHome = "$HOME\.codex",
    [string]$ClaudeHome = "$HOME\.claude"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "SessionDataConfig.ps1")
$dataRoot = Get-SessionDataRoot -RepoRoot $repoRoot
$dataRepoRoot = Get-SessionDataRepoRoot -DataRoot $dataRoot
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

Push-Location $repoRoot
try {
    Invoke-Git -Arguments @("pull", "--ff-only", "origin", "main")
}
finally {
    Pop-Location
}

if (-not [string]::IsNullOrWhiteSpace($dataRepoRoot) -and $dataRepoRoot -ne $repoRoot) {
    Push-Location $dataRepoRoot
    try {
        Invoke-Git -Arguments @("pull", "--ff-only", "origin", "main")
    }
    finally {
        Pop-Location
    }
}

& $psExe -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Cleanup-LocalBloat.ps1") -RepoRoot $repoRoot
& $psExe -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Import-CodexSessions.ps1") -CodexHome $CodexHome -ClaudeHome $ClaudeHome -SkipBackup
