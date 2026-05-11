param(
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
    [int]$RecentCount = 50
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "SessionDataConfig.ps1")
$dataRoot = Get-SessionDataRoot -RepoRoot $RepoRoot
$indexPath = Join-Path $dataRoot "session_index.jsonl"
$explorerDataPath = Join-Path $RepoRoot "Session-Explorer.data.js"
$cacheRoot = Join-Path $RepoRoot ".cache"
$cachePath = Join-Path $cacheRoot "session-record-cache.json"
$cacheVersion = 1

function Normalize-Text {
    param(
        [AllowNull()][string]$Text,
        [int]$MaxLength = 0
    )

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return ""
    }

    $value = $Text -replace "\x1B\[[0-9;]*[A-Za-z]", ""
    $value = $value -replace "\[[0-9;]+m", ""
    $value = $value -replace "[\x00-\x08\x0B\x0C\x0E-\x1F]", " "
    $value = $value -replace "\s+", " "
    $value = $value.Trim()

    if ($MaxLength -gt 0 -and $value.Length -gt $MaxLength) {
        return $value.Substring(0, $MaxLength - 3).TrimEnd() + "..."
    }

    return $value
}

function Normalize-BlockText {
    param(
        [AllowNull()][string]$Text,
        [int]$MaxLength = 0
    )

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return ""
    }

    $value = $Text -replace "\x1B\[[0-9;]*[A-Za-z]", ""
    $value = $value -replace "\[[0-9;]+m", ""
    $value = $value -replace "[\x00-\x08\x0B\x0C\x0E-\x1F]", " "
    $value = $value -replace "(\r?\n){3,}", ([Environment]::NewLine + [Environment]::NewLine)
    $value = $value.Trim()

    if ($MaxLength -gt 0 -and $value.Length -gt $MaxLength) {
        return $value.Substring(0, $MaxLength - 3).TrimEnd() + "..."
    }

    return $value
}

function Get-ProjectName {
    param([string]$Cwd)

    if ([string]::IsNullOrWhiteSpace($Cwd)) {
        return ""
    }

    try {
        return Split-Path -Leaf $Cwd
    }
    catch {
        return $Cwd
    }
}

function Get-RepoRelativePath {
    param(
        [string]$BasePath,
        [string]$FullPath
    )

    $resolvedBase = [System.IO.Path]::GetFullPath($BasePath).TrimEnd("\")
    $resolvedFullPath = [System.IO.Path]::GetFullPath($FullPath)

    if ($resolvedFullPath.StartsWith($resolvedBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $resolvedFullPath.Substring($resolvedBase.Length).TrimStart("\")
    }

    return $resolvedFullPath
}

function Get-TextFromMessageContent {
    param($Content)

    $parts = @()
    foreach ($item in @($Content)) {
        if ($null -eq $item) {
            continue
        }

        if (($item.type -eq "input_text" -or $item.type -eq "output_text") -and $item.text) {
            $parts += [string]$item.text
        }
    }

    return Normalize-Text ($parts -join " ")
}

function Test-NoiseUserMessage {
    param([string]$Text)

    $value = Normalize-Text $Text
    if ([string]::IsNullOrWhiteSpace($value)) {
        return $true
    }

    if ($value -match "^<environment_context>" -or $value -match "^# AGENTS\.md instructions\b" -or $value -match "^<turn_aborted>") {
        return $true
    }

    return $false
}

function Test-BadTitle {
    param([string]$Title)

    $value = Normalize-Text $Title
    if ([string]::IsNullOrWhiteSpace($value)) {
        return $true
    }

    if ($value -match "<environment_context>|</|<fault|\{|\}|_text|^""") {
        return $true
    }

    return $false
}

function Write-Utf8BomFile {
    param(
        [string]$Path,
        [string]$Content
    )

    $encoding = New-Object System.Text.UTF8Encoding($true)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function ConvertTo-IsoTimestamp {
    param($Value)

    if ($null -eq $Value) {
        return ""
    }

    if ($Value -is [System.Array]) {
        $Value = @($Value | Where-Object { $_ }) | Select-Object -First 1
        if ($null -eq $Value) {
            return ""
        }
    }

    try {
        return ([datetimeoffset]$Value).ToString("o")
    }
    catch {
        return ""
    }
}

function Update-UserMessageState {
    param(
        [string]$Text,
        [ref]$FirstObservedUserMessage,
        [ref]$FirstUserMessage,
        [ref]$LastUserMessage
    )

    $message = Normalize-Text $Text 500
    if (-not $message) {
        return
    }

    if (-not $FirstObservedUserMessage.Value) {
        $FirstObservedUserMessage.Value = $message
    }

    if (Test-NoiseUserMessage $message) {
        return
    }

    if (-not $FirstUserMessage.Value) {
        $FirstUserMessage.Value = $message
    }

    $LastUserMessage.Value = $message
}

function Add-OutlineTurn {
    param(
        $TurnList,
        [hashtable]$SeenTurns,
        [string]$Text,
        $Timestamp
    )

    $message = Normalize-Text $Text 280
    if (-not $message -or (Test-NoiseUserMessage $message)) {
        return
    }

    $timestampText = ConvertTo-IsoTimestamp $Timestamp
    $dedupeKey = "$timestampText|$message"
    if ($SeenTurns.ContainsKey($dedupeKey)) {
        return
    }

    $SeenTurns[$dedupeKey] = $true
    $TurnList.Add([pscustomobject]@{
        index = $TurnList.Count + 1
        timestamp = $timestampText
        text = $message
    })
}

function Add-TranscriptItem {
    param(
        $TranscriptList,
        [hashtable]$SeenItems,
        [string]$Kind,
        [string]$Label,
        [string]$Text,
        $Timestamp
    )

    if ($Kind -eq "user" -and (Test-NoiseUserMessage $Text)) {
        return
    }

    if ($Kind -eq "tool") {
        $message = Normalize-BlockText -Text $Text -MaxLength 1800
    }
    else {
        $message = Normalize-Text -Text $Text -MaxLength 900
    }

    if (-not $message) {
        return
    }

    if ($TranscriptList.Count -gt 0) {
        $lastItem = $TranscriptList[$TranscriptList.Count - 1]
        if ($lastItem.kind -eq $Kind -and $lastItem.text -eq $message) {
            return
        }
    }

    $timestampText = ConvertTo-IsoTimestamp $Timestamp
    $dedupeKey = "$Kind|$timestampText|$message"
    if ($SeenItems.ContainsKey($dedupeKey)) {
        return
    }

    $SeenItems[$dedupeKey] = $true
    $TranscriptList.Add([pscustomobject]@{
        kind = $Kind
        label = $Label
        timestamp = $timestampText
        text = $message
    })
}

function Get-SessionRecord {
    param(
        [System.IO.FileInfo]$File,
        [hashtable]$IndexMap,
        [string]$RepoRoot
    )

    $sessionId = ""
    $startedAt = $null
    $updatedAt = $null
    $lastTimestamp = $null
    $cwd = ""
    $firstObservedUserMessage = ""
    $firstUserMessage = ""
    $lastUserMessage = ""
    $lastAgentMessage = ""
    $lastLifecycle = ""
    $agentMessages = New-Object 'System.Collections.Generic.List[string]'
    $transcriptItems = New-Object 'System.Collections.Generic.List[object]'
    $transcriptSeen = @{}
    $toolCallNames = @{}

    $eventUserTurns = New-Object 'System.Collections.Generic.List[object]'
    $fallbackUserTurns = New-Object 'System.Collections.Generic.List[object]'
    $eventUserTurnMap = @{}
    $fallbackUserTurnMap = @{}

    foreach ($line in Get-Content -LiteralPath $File.FullName -Encoding utf8) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        try {
            $item = $line | ConvertFrom-Json
        }
        catch {
            continue
        }

        if ($item.timestamp) {
            $lastTimestamp = [datetimeoffset]$item.timestamp
        }

        if ($item.type -eq "session_meta") {
            if ($item.payload.id) {
                $sessionId = [string]$item.payload.id
            }
            if ($item.payload.timestamp) {
                $startedAt = [datetimeoffset]$item.payload.timestamp
            }
            if ($item.payload.cwd) {
                $cwd = [string]$item.payload.cwd
            }
            continue
        }

        if ($item.type -eq "event_msg") {
            $eventType = [string]$item.payload.type

            if ($eventType -eq "user_message") {
                $message = Normalize-Text ([string]$item.payload.message) 500
                Update-UserMessageState -Text $message -FirstObservedUserMessage ([ref]$firstObservedUserMessage) -FirstUserMessage ([ref]$firstUserMessage) -LastUserMessage ([ref]$lastUserMessage)
                Add-OutlineTurn -TurnList $eventUserTurns -SeenTurns $eventUserTurnMap -Text $message -Timestamp $lastTimestamp
                Add-TranscriptItem -TranscriptList $transcriptItems -SeenItems $transcriptSeen -Kind "user" -Label "用户" -Text $message -Timestamp $lastTimestamp
                continue
            }

            if ($eventType -eq "agent_message") {
                $message = Normalize-Text ([string]$item.payload.message) 300
                if ($message) {
                    $lastAgentMessage = $message
                    if ($agentMessages.Count -lt 24) {
                        $agentMessages.Add($message)
                    }
                    Add-TranscriptItem -TranscriptList $transcriptItems -SeenItems $transcriptSeen -Kind "ai" -Label "AI" -Text $message -Timestamp $lastTimestamp
                }
                continue
            }

            if ($eventType -eq "task_started" -or $eventType -eq "task_complete") {
                $lastLifecycle = $eventType
                if ($eventType -eq "task_complete" -and $item.payload.last_agent_message) {
                    $message = Normalize-Text ([string]$item.payload.last_agent_message) 300
                    if ($message) {
                        $lastAgentMessage = $message
                        if ($agentMessages.Count -lt 24) {
                            $agentMessages.Add($message)
                        }
                    }
                }
            }

            continue
        }

        if ($item.type -eq "response_item" -and $item.payload.type -eq "message") {
            if ($item.payload.role -eq "user") {
                $message = Get-TextFromMessageContent $item.payload.content
                Update-UserMessageState -Text $message -FirstObservedUserMessage ([ref]$firstObservedUserMessage) -FirstUserMessage ([ref]$firstUserMessage) -LastUserMessage ([ref]$lastUserMessage)
                Add-OutlineTurn -TurnList $fallbackUserTurns -SeenTurns $fallbackUserTurnMap -Text $message -Timestamp $lastTimestamp
                Add-TranscriptItem -TranscriptList $transcriptItems -SeenItems $transcriptSeen -Kind "user" -Label "用户" -Text $message -Timestamp $lastTimestamp
            }
            elseif ($item.payload.role -eq "assistant") {
                $message = Normalize-Text (Get-TextFromMessageContent $item.payload.content) 300
                if ($message) {
                    $lastAgentMessage = $message
                    if ($agentMessages.Count -lt 24) {
                        $agentMessages.Add($message)
                    }
                    Add-TranscriptItem -TranscriptList $transcriptItems -SeenItems $transcriptSeen -Kind "ai" -Label "AI" -Text $message -Timestamp $lastTimestamp
                }
            }
        }

        if ($item.type -eq "response_item" -and $item.payload.type -eq "function_call") {
            if ($item.payload.call_id -and $item.payload.name) {
                $toolCallNames[[string]$item.payload.call_id] = [string]$item.payload.name
            }
            continue
        }

        if ($item.type -eq "response_item" -and $item.payload.type -eq "function_call_output") {
            $toolLabel = "工具"
            if ($item.payload.call_id -and $toolCallNames.ContainsKey([string]$item.payload.call_id)) {
                $toolLabel = [string]$toolCallNames[[string]$item.payload.call_id]
            }
            Add-TranscriptItem -TranscriptList $transcriptItems -SeenItems $transcriptSeen -Kind "tool" -Label $toolLabel -Text ([string]$item.payload.output) -Timestamp $lastTimestamp
        }
    }

    if (-not $sessionId) {
        return $null
    }

    if (-not $firstUserMessage) {
        $firstUserMessage = $firstObservedUserMessage
    }

    $userTurns = $eventUserTurns
    if ($eventUserTurns.Count -eq 0) {
        $userTurns = $fallbackUserTurns
    }
    if ($null -eq $userTurns) {
        $userTurns = New-Object 'System.Collections.Generic.List[object]'
    }
    if ($userTurns.Count -eq 0 -and $firstUserMessage) {
        $userTurns.Add([pscustomobject]@{
            index = 1
            timestamp = (ConvertTo-IsoTimestamp $startedAt)
            text = (Normalize-Text -Text $firstUserMessage -MaxLength 280)
        })
    }

    $indexRecord = $IndexMap[$sessionId]
    $titleRaw = ""
    if ($indexRecord) {
        $titleRaw = [string]$indexRecord.thread_name
        if ($indexRecord.updated_at) {
            $updatedAt = [datetimeoffset]$indexRecord.updated_at
        }
    }

    if (-not $updatedAt) {
        $updatedAt = $lastTimestamp
    }

    if (-not $startedAt) {
        $startedAt = $updatedAt
    }

    if (-not $titleRaw -or (Test-BadTitle $titleRaw)) {
        if ($firstUserMessage) {
            $titleRaw = $firstUserMessage
        }
        elseif ($lastUserMessage) {
            $titleRaw = $lastUserMessage
        }
        else {
            $titleRaw = $File.BaseName
        }
    }

    $titleClean = Normalize-Text $titleRaw 80
    if (-not $titleClean) {
        $titleClean = $File.BaseName
    }

    if (-not $firstUserMessage) {
        $firstUserMessage = $titleClean
    }

    if (-not $lastUserMessage) {
        $lastUserMessage = $firstUserMessage
    }

    $status = "unknown"
    if ($lastLifecycle -eq "task_complete") {
        $status = "completed"
    }
    elseif ($lastLifecycle -eq "task_started") {
        $status = "in_progress"
    }

    $source = "sessions"
    if ($File.FullName -like "*archived_sessions*") {
        $source = "archived_sessions"
    }

    $project = Get-ProjectName $cwd
    $summary = @()
    if ($project) {
        $summary += "Project: $project"
    }
    $summary += "Turns: $($userTurns.Count)"
    if ($firstUserMessage) {
        $summary += "Start: $(Normalize-Text $firstUserMessage 120)"
    }
    if ($lastUserMessage -and $lastUserMessage -ne $firstUserMessage) {
        $summary += "Recent: $(Normalize-Text $lastUserMessage 120)"
    }
    elseif ($lastAgentMessage) {
        $summary += "Recent: $(Normalize-Text $lastAgentMessage 120)"
    }

    $outlineSearchText = Normalize-Text (($userTurns | ForEach-Object { $_.text }) -join " ") 1600
    $agentSearchText = Normalize-Text ($agentMessages -join " ") 2200
    $transcriptClean = New-Object 'System.Collections.Generic.List[object]'
    foreach ($entry in $transcriptItems) {
        if ($entry.kind -eq "user" -and (Test-NoiseUserMessage $entry.text)) {
            continue
        }

        if ($transcriptClean.Count -gt 0) {
            $lastEntry = $transcriptClean[$transcriptClean.Count - 1]
            if ($lastEntry.kind -eq $entry.kind -and $lastEntry.text -eq $entry.text) {
                continue
            }
        }

        $transcriptClean.Add($entry)
    }
    $transcriptArray = @($transcriptClean | ForEach-Object { $_ })

    $turnsArray = @($userTurns | ForEach-Object { $_ })
    $record = [pscustomobject]@{}
    $record | Add-Member -NotePropertyName "session_id" -NotePropertyValue $sessionId
    $record | Add-Member -NotePropertyName "title_raw" -NotePropertyValue (Normalize-Text -Text $titleRaw -MaxLength 200)
    $record | Add-Member -NotePropertyName "title_clean" -NotePropertyValue $titleClean
    $record | Add-Member -NotePropertyName "updated_at" -NotePropertyValue (ConvertTo-IsoTimestamp $updatedAt)
    $record | Add-Member -NotePropertyName "started_at" -NotePropertyValue (ConvertTo-IsoTimestamp $startedAt)
    $record | Add-Member -NotePropertyName "status" -NotePropertyValue $status
    $record | Add-Member -NotePropertyName "source" -NotePropertyValue $source
    $record | Add-Member -NotePropertyName "cwd" -NotePropertyValue $cwd
    $record | Add-Member -NotePropertyName "project" -NotePropertyValue $project
    $record | Add-Member -NotePropertyName "session_file" -NotePropertyValue (Get-RepoRelativePath -BasePath $RepoRoot -FullPath $File.FullName)
    $record | Add-Member -NotePropertyName "first_user_message" -NotePropertyValue (Normalize-Text -Text $firstUserMessage -MaxLength 200)
    $record | Add-Member -NotePropertyName "last_user_message" -NotePropertyValue (Normalize-Text -Text $lastUserMessage -MaxLength 200)
    $record | Add-Member -NotePropertyName "last_agent_message" -NotePropertyValue (Normalize-Text -Text $lastAgentMessage -MaxLength 200)
    $record | Add-Member -NotePropertyName "resume_command" -NotePropertyValue "codex resume $sessionId"
    $record | Add-Member -NotePropertyName "turn_count" -NotePropertyValue $userTurns.Count
    $record | Add-Member -NotePropertyName "user_turns" -NotePropertyValue $turnsArray
    $record | Add-Member -NotePropertyName "transcript_items" -NotePropertyValue $transcriptArray
    $record | Add-Member -NotePropertyName "summary" -NotePropertyValue $summary
    $record | Add-Member -NotePropertyName "search_text" -NotePropertyValue (Normalize-Text -Text (($titleClean, $cwd, $project, $firstUserMessage, $lastUserMessage, $lastAgentMessage, $outlineSearchText, $agentSearchText, ($transcriptArray | ForEach-Object { $_.text }) -join " ") -join " ") -MaxLength 8000)
    return $record
}

if (-not (Test-Path -LiteralPath $indexPath)) {
    throw "Missing session index: $indexPath"
}

$indexMap = @{}
foreach ($line in Get-Content -LiteralPath $indexPath -Encoding utf8) {
    if ([string]::IsNullOrWhiteSpace($line)) {
        continue
    }

    try {
        $record = $line | ConvertFrom-Json
    }
    catch {
        continue
    }

    if ($record.id) {
        $indexMap[[string]$record.id] = $record
    }
}

$sessionFiles = @()
$sessionFiles += Get-ChildItem -Path (Join-Path $dataRoot "sessions") -Recurse -File -ErrorAction SilentlyContinue
$sessionFiles += Get-ChildItem -Path (Join-Path $dataRoot "archived_sessions") -Recurse -File -ErrorAction SilentlyContinue

$cacheEntries = @{}
if (Test-Path -LiteralPath $cachePath) {
    try {
        $cacheDoc = Get-Content -Raw -LiteralPath $cachePath -Encoding utf8 | ConvertFrom-Json -Depth 12
        if ($cacheDoc.version -eq $cacheVersion) {
            foreach ($entry in @($cacheDoc.entries)) {
                if ($entry.session_file) {
                    $cacheEntries[[string]$entry.session_file] = $entry
                }
            }
        }
    }
    catch {
        $cacheEntries = @{}
    }
}

$parsedCount = 0
$reusedCount = 0
$records = New-Object 'System.Collections.Generic.List[object]'
$newCacheEntries = New-Object 'System.Collections.Generic.List[object]'

foreach ($file in $sessionFiles) {
    $relativePath = Get-RepoRelativePath -BasePath $RepoRoot -FullPath $file.FullName
    $lastWriteTicks = $file.LastWriteTimeUtc.Ticks
    $fileLength = [int64]$file.Length
    $record = $null

    if ($cacheEntries.ContainsKey($relativePath)) {
        $cacheEntry = $cacheEntries[$relativePath]
        if (
            $cacheEntry.record -and
            [int64]$cacheEntry.last_write_ticks -eq $lastWriteTicks -and
            [int64]$cacheEntry.length -eq $fileLength
        ) {
            $record = $cacheEntry.record
            $reusedCount++
        }
    }

    if (-not $record) {
        $record = Get-SessionRecord -File $file -IndexMap $indexMap -RepoRoot $RepoRoot
        $parsedCount++
    }

    if ($record) {
        $records.Add($record)
        $newCacheEntries.Add([pscustomobject]@{
            session_file = $relativePath
            last_write_ticks = $lastWriteTicks
            length = $fileLength
            record = $record
        })
    }
}

$records = @(
    $records |
        Where-Object { $_ } |
        Sort-Object @{ Expression = { $_.updated_at }; Descending = $true }, @{ Expression = { $_.started_at }; Descending = $true }
)

$statusCounts = @{
    completed = @($records | Where-Object { $_.status -eq "completed" }).Count
    in_progress = @($records | Where-Object { $_.status -eq "in_progress" }).Count
    unknown = @($records | Where-Object { $_.status -eq "unknown" }).Count
}

$catalog = [pscustomobject]@{
    generated_at = (Get-Date).ToUniversalTime().ToString("o")
    total_sessions = $records.Count
    status_counts = $statusCounts
    projects = @($records | Where-Object { $_.project } | Group-Object project | Sort-Object Count -Descending | ForEach-Object {
        [pscustomobject]@{
            project = $_.Name
            count = $_.Count
        }
    })
    sessions = $records
}

$catalogJson = $catalog | ConvertTo-Json -Depth 8
$catalogJsonMin = $catalog | ConvertTo-Json -Depth 8 -Compress

Write-Utf8BomFile -Path $explorerDataPath -Content ("window.SESSION_EXPLORER_DATA = $catalogJsonMin;" + [Environment]::NewLine)

New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
$cacheDocOut = [pscustomobject]@{
    version = $cacheVersion
    updated_at = (Get-Date).ToUniversalTime().ToString("o")
    entries = @($newCacheEntries | ForEach-Object { $_ })
}
[System.IO.File]::WriteAllText($cachePath, ($cacheDocOut | ConvertTo-Json -Depth 12 -Compress), (New-Object System.Text.UTF8Encoding($false)))

Write-Host "Resume catalog updated:"
Write-Host "  $explorerDataPath"
Write-Host "  Parsed: $parsedCount, reused from cache: $reusedCount"
