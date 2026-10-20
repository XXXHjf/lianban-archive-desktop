param(
    [ValidateSet('install','start','stop','verify')][string]$Action = 'start',
    [int]$Port = 8765,
    [switch]$NoBrowser,
    [switch]$NoUpdates
)
$ErrorActionPreference = 'Stop'
$shareRoot = $PSScriptRoot
$shareBundle = Get-Content -LiteralPath (Join-Path $shareRoot 'BUNDLE.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$shareActivePath = Join-Path $shareRoot '.runtime\active.json'
$shareSessionPath = Join-Path $shareRoot 'data\desktop-session.json'
$shareSha = [Security.Cryptography.SHA256]::Create()
$shareKey = ([BitConverter]::ToString($shareSha.ComputeHash([Text.Encoding]::UTF8.GetBytes($shareRoot.ToLowerInvariant())))).Replace('-','').ToLowerInvariant()
$shareSha.Dispose()

function Get-SharePython {
    if (Test-Path -LiteralPath $shareActivePath) {
        $shareActive = Get-Content -LiteralPath $shareActivePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $shareCandidate = [IO.Path]::GetFullPath((Join-Path $shareRoot $shareActive.python))
        $shareAllowed = [IO.Path]::GetFullPath((Join-Path $shareRoot '.runtime')) + [IO.Path]::DirectorySeparatorChar
        if ($shareActive.bundle -eq $shareBundle.id -and $shareActive.project -eq $shareKey -and $shareCandidate.StartsWith($shareAllowed,[StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $shareCandidate)) { return $shareCandidate }
    }
    return $null
}

function Install-Share {
    if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { throw 'This package requires Windows 10/11 on an x64 PC.' }
    $shareArchive = Join-Path $shareRoot $shareBundle.runtime
    $shareExpected = $shareBundle.sha256.PSObject.Properties[$shareBundle.runtime].Value
    if ((Get-FileHash -LiteralPath $shareArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $shareExpected) { throw 'Python archive is missing or damaged. Download the project again.' }
    $shareRuntime = Join-Path $shareRoot ('.runtime\python-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $shareRuntime -Force | Out-Null
    Expand-Archive -LiteralPath $shareArchive -DestinationPath $shareRuntime
    New-Item -ItemType Directory -Path (Join-Path $shareRuntime 'Lib\site-packages') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $shareRuntime 'python313._pth'), "python313.zip`n.`nLib/site-packages`n$shareRoot`nimport site`n", [Text.UTF8Encoding]::new($false))
    $sharePython = Join-Path $shareRuntime 'python.exe'
    & $sharePython (Join-Path $shareRoot 'setup_shared.py') install | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { throw 'Installation failed. Existing databases were retained; see the error above.' }
    $shareRelative = $sharePython.Substring($shareRoot.Length+1)
    @{python=$shareRelative;bundle=$shareBundle.id;project=$shareKey} | ConvertTo-Json | Set-Content -LiteralPath $shareActivePath -Encoding UTF8
    Write-Host 'Offline installation completed. No system Python or Codex is required.'
    return $sharePython
}

function Get-ShareSession {
    if (-not (Test-Path -LiteralPath $shareSessionPath)) { return $null }
    try {
        $shareRecorded = Get-Content -LiteralPath $shareSessionPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($shareRecorded.project_key -ne $shareKey -or $shareRecorded.state -eq 'stopped') { return $null }
        $shareStatus = Invoke-RestMethod -Uri ("http://127.0.0.1:"+$shareRecorded.port+'/__desktop__/status') -TimeoutSec 2
        if ($shareStatus.project_key -eq $shareKey -and $shareStatus.instance_id -eq $shareRecorded.instance_id -and $shareStatus.pid -eq $shareRecorded.pid) { return $shareRecorded }
    } catch {}
    return $null
}

if ($Action -eq 'stop') {
    $shareSession = Get-ShareSession
    if ($null -eq $shareSession) { Write-Host 'This project is already stopped.'; exit 0 }
    Invoke-RestMethod -Uri ("http://127.0.0.1:"+$shareSession.port+'/__desktop__/shutdown') -Method Post -Headers @{'X-Desktop-Token'=$shareSession.token} -ContentType 'application/json' -Body '{}' | Out-Null
    for ($shareAttempt=0;$shareAttempt -lt 40;$shareAttempt++) {
        Start-Sleep -Milliseconds 250
        if ($null -eq (Get-ShareSession)) { Write-Host 'This project is stopped.'; exit 0 }
    }
    throw 'The project is still shutting down. Try Stop again in a moment.'
}

$sharePython = Get-SharePython
if ($null -eq $sharePython) { $sharePython = Install-Share }
elseif ($Action -eq 'install') {
    & $sharePython (Join-Path $shareRoot 'setup_shared.py') install
    if ($LASTEXITCODE -ne 0) { throw 'Installation verification failed.' }
}
if ($Action -eq 'install') { Write-Host 'Ready. Double-click start_demo.cmd to open the website.'; exit 0 }
if ($Action -eq 'verify') {
    & $sharePython (Join-Path $shareRoot 'setup_shared.py') verify
    exit $LASTEXITCODE
}

$shareSession = Get-ShareSession
if ($null -eq $shareSession) {
    $shareChosenPort = 0
    for ($shareTryPort=$Port;$shareTryPort -le [Math]::Min(65535,$Port+30);$shareTryPort++) {
        $shareListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$shareTryPort)
        try { $shareListener.Start(); $shareChosenPort=$shareTryPort; break } catch {} finally { $shareListener.Stop() }
    }
    if ($shareChosenPort -eq 0) { throw 'No free local port was found.' }
    $shareData = Join-Path $shareRoot 'data'
    $shareArguments = @('"'+(Join-Path $shareRoot 'desktop.py')+'"','serve','--port',[string]$shareChosenPort)
    if ($NoUpdates) { $shareArguments += '--no-updates' }
    $shareProcess = Start-Process -FilePath $sharePython -ArgumentList $shareArguments -WorkingDirectory $shareRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $shareData 'server.log') -RedirectStandardError (Join-Path $shareData 'server-error.log')
    for ($shareAttempt=0;$shareAttempt -lt 60;$shareAttempt++) {
        Start-Sleep -Milliseconds 250
        $shareSession = Get-ShareSession
        if ($null -ne $shareSession) { break }
        if ($shareProcess.HasExited) { break }
    }
    if ($null -eq $shareSession) { throw 'The server did not start. Check data/server-error.log.' }
}
$shareUrl = 'http://127.0.0.1:' + $shareSession.port
if (-not $NoBrowser) { Start-Process $shareUrl }
Write-Host ('Website ready: ' + $shareUrl)
