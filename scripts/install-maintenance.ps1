[CmdletBinding()]
param(
    [ValidateRange(1, 744)][int]$EveryHours = 48,
    [ValidatePattern('^([01]\d|2[0-3]):[0-5]\d$')][string]$At = '04:30',
    [string]$ChromePath = (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    [ValidatePattern('^[A-Za-z0-9 _-]+$')][string]$ProfileDirectory = 'Default',
    [string]$TaskName = 'BrowserTriggerChromeMaintenance'
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (!(Test-Path -LiteralPath $ChromePath -PathType Leaf)) { throw '找不到 Chrome。' }
$preferences = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\$ProfileDirectory\Secure Preferences"
$settings = (Get-Content -LiteralPath $preferences -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable).extensions.settings
$installed = @($settings.GetEnumerator() | Where-Object { $_.Value.path -and [IO.Path]::GetFullPath($_.Value.path).TrimEnd('\') -eq $root.TrimEnd('\') })
if ($installed.Count -ne 1 -or $installed[0].Key -notmatch '^[a-p]{32}$') { throw '请先在此 Chrome 用户配置中加载页面触发器扩展。' }
$local = Join-Path $root '.local'
New-Item -ItemType Directory -Path $local -Force | Out-Null
$configPath = Join-Path $local 'maintenance.json'
@{ chromePath = $ChromePath; profileDirectory = $ProfileDirectory; extensionId = $installed[0].Key; everyHours = $EveryHours; at = $At } |
    ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8
$first = [DateTime]::Today.Add([TimeSpan]::Parse($At))
if ($first -le (Get-Date)) { $first = $first.AddDays(1) }
$action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'pwsh.exe') -Argument "-NoProfile -WindowStyle Hidden -File `"$(Join-Path $PSScriptRoot 'restart-chrome.ps1')`" -ConfigPath `"$configPath`""
$trigger = New-ScheduledTaskTrigger -Once -At $first -RepetitionInterval ([TimeSpan]::FromHours($EveryHours))
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::FromMinutes(3)) -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(15))
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
[pscustomobject]@{ taskName = $TaskName; nextStart = $first.ToString('o'); everyHours = $EveryHours; extensionId = $installed[0].Key } | ConvertTo-Json -Compress
