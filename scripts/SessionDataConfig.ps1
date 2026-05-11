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
        return (Join-Path $RepoRoot "data")
    }

    if ([System.IO.Path]::IsPathRooted($configured)) {
        return [System.IO.Path]::GetFullPath($configured)
    }

    return [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $configured))
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
