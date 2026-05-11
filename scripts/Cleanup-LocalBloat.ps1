param(
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"

$repoRootResolved = (Resolve-Path -LiteralPath $RepoRoot).Path

function Remove-RepoPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RelativePath
    )

    $target = Join-Path $repoRootResolved $RelativePath
    if (-not (Test-Path -LiteralPath $target)) {
        return
    }

    $resolved = (Resolve-Path -LiteralPath $target).Path
    if (-not $resolved.StartsWith($repoRootResolved, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove outside repo: $resolved"
    }

    Remove-Item -LiteralPath $resolved -Recurse -Force
    Write-Host "Removed local cache: $RelativePath"
}

Remove-RepoPath "_backups"
Remove-RepoPath ".venv"
Remove-RepoPath "output"
Remove-RepoPath ".cache\node-upgrade"
Remove-RepoPath ".cache\chrome-ui-check"
Remove-RepoPath ".cache\session-record-cache.json"

$cacheRoot = Join-Path $repoRootResolved ".cache"
if (Test-Path -LiteralPath $cacheRoot) {
    Get-ChildItem -LiteralPath $cacheRoot -Force -Directory -Filter "push-stage-*" -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Recurse -Force
        Write-Host "Removed local cache: $($_.Name)"
    }
}
