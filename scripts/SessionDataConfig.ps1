function Get-SessionSyncEnv {
    param(
        [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
    )

    $envPath = Join-Path $RepoRoot ".env.local"
    $values = @{}

    if (Test-Path -LiteralPath $envPath) {
        foreach ($line in Get-Content -LiteralPath $envPath -Encoding utf8) {
            $trimmed = $line.Trim()
            if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith("#")) {
                continue
            }

            $index = $trimmed.IndexOf("=")
            if ($index -le 0) {
                continue
            }

            $key = $trimmed.Substring(0, $index).Trim()
            $value = $trimmed.Substring($index + 1).Trim()
            if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            $values[$key] = [Environment]::ExpandEnvironmentVariables($value)
        }
    }

    return $values
}

function Get-SessionDataRoot {
    param(
        [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
    )

    $envValues = Get-SessionSyncEnv -RepoRoot $RepoRoot
    $configured = if ($envValues.ContainsKey("SESSION_DATA_ROOT")) { $envValues["SESSION_DATA_ROOT"] } else { $env:SESSION_DATA_ROOT }

    if ([string]::IsNullOrWhiteSpace($configured)) {
        throw "Missing SESSION_DATA_ROOT. This repository uses split mode only. Set SESSION_DATA_ROOT in .env.local to your private data repository data directory."
    }

    $resolved = if ([System.IO.Path]::IsPathRooted($configured)) {
        [System.IO.Path]::GetFullPath($configured)
    } else {
        [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $configured))
    }

    $repoDataRoot = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot "data"))
    if ($resolved.TrimEnd("\", "/") -ieq $repoDataRoot.TrimEnd("\", "/")) {
        throw "SESSION_DATA_ROOT cannot point to this tool repository's data directory. Use a separate private data repository, for example D:\00容器\ai_sys\ai-session-data\data."
    }

    $repoRootFull = [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd("\", "/")
    $resolvedFull = $resolved.TrimEnd("\", "/")
    if ($resolvedFull -ieq $repoRootFull -or $resolvedFull.StartsWith($repoRootFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "SESSION_DATA_ROOT must be outside the public tool repository. Point it to the data directory inside your private data repository."
    }

    return $resolved
}

function Get-SessionDataRepoRoot {
    param(
        [string]$DataRoot
    )

    if ([string]::IsNullOrWhiteSpace($DataRoot)) {
        return ""
    }

    $current = [System.IO.DirectoryInfo]::new([System.IO.Path]::GetFullPath($DataRoot))
    while ($current) {
        if (Test-Path -LiteralPath (Join-Path $current.FullName ".git")) {
            return $current.FullName
        }
        $current = $current.Parent
    }

    return ""
}
