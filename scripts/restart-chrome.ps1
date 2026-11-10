[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot '..\.local\maintenance.json'),
    [switch]$Check
)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding utf8 | ConvertFrom-Json
if (!(Test-Path -LiteralPath $config.chromePath -PathType Leaf) -or $config.extensionId -notmatch '^[a-p]{32}$' -or $config.profileDirectory -notmatch '^[A-Za-z0-9 _-]+$') { throw '浏览器维护配置无效。' }
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function OwnProcess($process) {
    (Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid).Sid -eq $userSid
}
$busy = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -match '(@playwright[\\/]mcp[\\/]|laptop-chrome-mcp[\\/]src[\\/]server\.mjs)' -and (OwnProcess $_)
})
$roots = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
    $_.ExecutablePath -eq $config.chromePath -and $_.CommandLine -notmatch '--type=|--user-data-dir' -and (OwnProcess $_)
})
if ($Check) {
    [pscustomobject]@{ browserPids = @($roots.ProcessId); browserTasks = $busy.Count; profile = $config.profileDirectory; extensionId = $config.extensionId } | ConvertTo-Json -Compress
    exit 0
}
if ($busy.Count) { throw '浏览器助手正在运行，暂不重启；计划任务会延后重试。' }
if ($roots.Count -gt 1) { throw '检测到多个浏览器主进程，未进行重启。' }
if ($roots.Count -eq 1) {
    $root = $roots[0]
    $process = Get-Process -Id $root.ProcessId
    if ([Math]::Abs(($process.StartTime.ToUniversalTime() - $root.CreationDate.ToUniversalTime()).TotalSeconds) -gt 1) { throw '浏览器进程身份已变化。' }
    [void]$process.CloseMainWindow()
    if (!$process.WaitForExit(30000)) {
        # This exact process was verified above; never terminate Chrome by name.
        & "$env:WINDIR\System32\taskkill.exe" /PID $root.ProcessId /T /F | Out-Null
        if (!$process.WaitForExit(10000)) { throw '浏览器尚未退出，未重复启动。' }
    }
}
$url = "chrome-extension://$($config.extensionId)/wake.html"
Start-Process -FilePath $config.chromePath -ArgumentList @("--profile-directory=`"$($config.profileDirectory)`"", '--no-first-run', $url) -WindowStyle Normal
$log = Join-Path (Split-Path -Parent $ConfigPath) 'maintenance-runs.jsonl'
@{ at = [DateTime]::UtcNow.ToString('o'); event = 'browser-start-requested'; profile = $config.profileDirectory } |
    ConvertTo-Json -Compress | Add-Content -LiteralPath $log -Encoding utf8
