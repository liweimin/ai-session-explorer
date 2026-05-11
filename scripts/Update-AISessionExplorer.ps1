param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot

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

Push-Location $repoRoot
try {
    $status = git status --porcelain
    if ($status) {
        throw "Tool repository has local changes. Commit, stash, or discard them before updating the tool."
    }

    Invoke-Git -Arguments @("pull", "--ff-only", "origin", (Get-CurrentGitBranch))
    Write-Host "AI Session Explorer tool updated."
}
finally {
    Pop-Location
}
