#requires -Version 5.1
<#
Downloads only the official public release. No Git, system Python or credentials.
Dot-source this file to load the helpers without starting an installation.
#>
[CmdletBinding()]
param(
    [string]$InstallDir,
    [switch]$NoStart,
    [switch]$NoBrowser,
    [ValidateRange(1024,65504)][int]$Port = 8765
)

function Get-LianbanVersion([string]$Value) {
    if ($Value -notmatch '^20[0-9]{2}\.[0-9]{2}\.[0-9]{2}(?:\.[0-9]{1,6})?$') {
        throw 'Invalid release version.'
    }
    [void][datetime]::ParseExact($Value.Substring(0,10),'yyyy.MM.dd',[Globalization.CultureInfo]::InvariantCulture)
    if ($Value.Split('.').Count -eq 3) { $Value += '.0' }
    return [version]$Value
}

function ConvertFrom-LianbanChecksum([string]$Text) {
    $pattern = '(?m)^([a-fA-F0-9]{64})[ \t]+\*?(lianban-archive-desktop-v(20[0-9]{2}\.[0-9]{2}\.[0-9]{2}(?:\.[0-9]{1,6})?)\.zip)[ \t]*$'
    $entries = [regex]::Matches($Text.Replace("`r",''),$pattern)
    if ($entries.Count -ne 1) { throw 'The official release checksum file is invalid.' }
    $entry = $entries[0]
    $releaseVersion = $entry.Groups[3].Value
    [void](Get-LianbanVersion $releaseVersion)
    $filename = $entry.Groups[2].Value
    return [pscustomobject]@{
        Version=$releaseVersion; Filename=$filename; Sha256=$entry.Groups[1].Value.ToLowerInvariant()
        Url=('https://github.com/x107108/lianban-archive-desktop/releases/download/v'+$releaseVersion+'/'+$filename)
    }
}

function Get-LianbanHash([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
    finally { $hash.Dispose(); $stream.Dispose() }
}

function Resolve-LianbanChild([string]$Base, [string]$Relative) {
    if ([string]::IsNullOrWhiteSpace($Relative) -or [IO.Path]::IsPathRooted($Relative)) { throw 'Invalid installation path.' }
    $prefix = [IO.Path]::GetFullPath($Base).TrimEnd([char[]]'\/')+[IO.Path]::DirectorySeparatorChar
    $resolved = [IO.Path]::GetFullPath((Join-Path $Base $Relative))
    if (-not $resolved.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'Installation path leaves its directory.' }
    return $resolved
}

function Save-LianbanDownload([string]$Url, [string]$Destination) {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination -TimeoutSec 180 -ErrorAction Stop
}

function Get-LianbanRelease([string]$Workspace) {
    $checksumPath = Join-Path $Workspace 'SHA256SUMS.txt'
    Save-LianbanDownload 'https://github.com/x107108/lianban-archive-desktop/releases/latest/download/SHA256SUMS.txt' $checksumPath
    return ConvertFrom-LianbanChecksum ([IO.File]::ReadAllText($checksumPath))
}

function Assert-LianbanArchive([string]$Path, [string]$Destination) {
    Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($Path)
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $files = 0
    $total = [long]0
    try {
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName
            if (-not $name.StartsWith('lianban-archive-desktop/',[StringComparison]::Ordinal) -or
                $name.Contains('\') -or $name.Contains(':') -or $name -match '(^|/)\.\.?(/|$)' -or
                $name -match '^lianban-archive-desktop/(data|\.runtime|\.git)(/|$)' -or
                (($entry.ExternalAttributes -shr 16) -band 0xf000) -eq 0xa000) {
                throw 'The release ZIP contains an unexpected or unsafe entry.'
            }
            [void](Resolve-LianbanChild $Destination $name)
            if (-not $seen.Add($name)) { throw 'The release ZIP contains duplicate paths.' }
            $total += $entry.Length
            if ($total -gt 1GB -or $seen.Count -gt 10000) { throw 'The release ZIP exceeds installation limits.' }
            if (-not $name.EndsWith('/')) { $files++ }
        }
        if ($files -lt 1) { throw 'The release ZIP is empty.' }
    } finally { $archive.Dispose() }
}

function Invoke-LianbanLauncher([string]$Root, [string]$Action, [switch]$HideBrowser, [int]$WebsitePort=8765) {
    $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $logs = Join-Path $Root 'data\online-installer'
    [void][IO.Directory]::CreateDirectory($logs)
    $wrapper = Join-Path $logs ([guid]::NewGuid().ToString('N')+'.ps1')
    $logPath = $wrapper+'.log'
    $wrapperText = @'
param([string]$Root,[string]$Action,[string]$LogPath,[int]$Port,[int]$HideBrowser)
$ErrorActionPreference='Stop'
try {
    & (Join-Path $Root 'launcher.ps1') -Action $Action -Port $Port -NoBrowser:($HideBrowser -eq 1) *> $LogPath
    exit 0
} catch {
    $_ | Out-String | Add-Content -LiteralPath $LogPath
    exit 1
}
'@
    [IO.File]::WriteAllText($wrapper,$wrapperText,[Text.UTF8Encoding]::new($false))
    $arguments = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$wrapper,'-Root',$Root,
        '-Action',$Action,'-LogPath',$logPath,'-Port',[string]$WebsitePort,'-HideBrowser',[string][int]$HideBrowser.IsPresent)
    $quotedArguments = @($arguments | ForEach-Object { '"'+$_+'"' })
    $previousModulePath = $env:PSModulePath
    try {
        $env:PSModulePath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
        # A separate hidden console prevents the web server from inheriting a native-output pipe.
        # Wait only for this launcher process, not its persistent web-server child.
        $process = Start-Process -FilePath $windowsPowerShell -ArgumentList $quotedArguments -WindowStyle Hidden -PassThru
        $process.WaitForExit()
        if (Test-Path -LiteralPath $logPath) { Write-Host ([IO.File]::ReadAllText($logPath).TrimEnd()) }
        if ($process.ExitCode -ne 0) { throw ('Project '+$Action+' failed. Existing data was retained. Log: '+$logPath) }
    } finally { $env:PSModulePath = $previousModulePath }
}

function Assert-LianbanRuntimePaths([string]$Root) {
    # Windows systems without long-path support must not fail halfway through wheel extraction.
    $bundle=Get-Content -LiteralPath (Join-Path $Root 'BUNDLE.json') -Raw -Encoding UTF8|ConvertFrom-Json
    $runtimePrefix=Join-Path $Root ('.runtime\python-'+('0'*32)+'\Lib\site-packages')
    foreach($wheel in $bundle.wheels) {
        $archive=[IO.Compression.ZipFile]::OpenRead((Resolve-LianbanChild $Root $wheel))
        try {
            foreach($entry in $archive.Entries) {
                $candidate=Resolve-LianbanChild $runtimePrefix $entry.FullName
                if($candidate.Length -ge 260 -or [IO.Path]::GetDirectoryName($candidate).Length -ge 248) {
                    throw 'The installation path is too long for the bundled Windows runtime. Use a shorter -InstallDir. Existing installations were retained.'
                }
            }
        } finally { $archive.Dispose() }
    }
}

function Get-LianbanSession([string]$Root) {
    try {
        $sessionPath = Join-Path $Root 'data\desktop-session.json'
        if (-not (Test-Path -LiteralPath $sessionPath)) { return $null }
        $record = Get-Content -LiteralPath $sessionPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($record.state -eq 'stopped' -or $record.port -lt 1024 -or $record.port -gt 65535) { return $null }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $key=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Root.ToLowerInvariant())))).Replace('-','').ToLowerInvariant() }
        finally { $sha.Dispose() }
        if ($record.project_key -ne $key) { return $null }
        $url = 'http://127.0.0.1:'+$record.port
        $status = Invoke-RestMethod -Uri ($url+'/__desktop__/status') -TimeoutSec 3
        if ($status.project_key -ne $key -or $status.instance_id -ne $record.instance_id -or $status.pid -ne $record.pid) { return $null }
        return [pscustomobject]@{Url=$url; Port=[int]$record.port}
    } catch { return $null }
}

function Get-LianbanActive([string]$Base) {
    $path = Join-Path $Base 'active-install.json'
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $record = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($record.product -ne 'x107108/lianban-archive-desktop' -or $record.sha256 -notmatch '^[a-f0-9]{64}$') {
        throw 'Existing installation state is invalid. All files were retained.'
    }
    [void](Get-LianbanVersion $record.version)
    $root = Resolve-LianbanChild $Base $record.root
    $versionFile = Join-Path $root 'VERSION.json'
    if (-not (Test-Path -LiteralPath $versionFile) -or
        (Get-Content -LiteralPath $versionFile -Raw -Encoding UTF8 | ConvertFrom-Json).version -ne $record.version) {
        throw 'Existing installation does not match its version record. All files were retained.'
    }
    return [pscustomobject]@{Root=$root; Version=$record.version; Sha256=$record.sha256; RelativeRoot=$record.root}
}

function Write-LianbanActive([string]$Base, [object]$Record) {
    $path = Join-Path $Base 'active-install.json'
    $temporary = Join-Path $Base 'active-install.tmp'
    [IO.File]::WriteAllText($temporary,($Record | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    if ([IO.File]::Exists($path)) {
        $previous = Join-Path $Base ('active-install-'+[guid]::NewGuid().ToString('N')+'.previous.json')
        [IO.File]::Replace($temporary,$path,$previous)
    }
    else { [IO.File]::Move($temporary,$path) }
}

function Copy-LianbanPersonalDatabase([string]$OldRoot, [string]$NewRoot, [string]$Base) {
    $source = Join-Path $OldRoot 'data\archive.sqlite3'
    if (-not (Test-Path -LiteralPath $source)) { return $null }
    $runtime = Get-Content -LiteralPath (Join-Path $OldRoot '.runtime\active.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $python = Resolve-LianbanChild $OldRoot $runtime.python
    $runtimePrefix = [IO.Path]::GetFullPath((Join-Path $OldRoot '.runtime'))+[IO.Path]::DirectorySeparatorChar
    if (-not $python.StartsWith($runtimePrefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid previous runtime path.' }
    $backupDir = Join-Path $Base 'backups'
    [void][IO.Directory]::CreateDirectory($backupDir)
    $archiveSnapshot = $null
    # The minute cache is a separate SQLite/WAL database. Preserve it with the
    # same consistent snapshot mechanism, including when its main file is stale.
    # Older installations without minute data continue to migrate normally.
    foreach ($databaseName in @('archive.sqlite3','intraday.sqlite3')) {
        $source = Join-Path $OldRoot ('data\'+$databaseName)
        if (-not (Test-Path -LiteralPath $source)) { continue }
        $label = [IO.Path]::GetFileNameWithoutExtension($databaseName)
        $snapshot = Join-Path $backupDir ($label+'-'+[datetime]::UtcNow.ToString('yyyyMMddTHHmmssZ')+'-'+[guid]::NewGuid().ToString('N')+'.sqlite3')
        & $python -c 'import sys; from backup_db import snapshot; snapshot(sys.argv[1], sys.argv[2])' $source $snapshot
        if ($LASTEXITCODE -ne 0) { throw ('Database snapshot failed: '+$databaseName+'. Previous data was retained.') }
        $target = Join-Path $NewRoot ('data\'+$databaseName)
        [IO.File]::Copy($snapshot,$target,$true)
        if ((Get-LianbanHash $snapshot) -ne (Get-LianbanHash $target)) { throw ('Database copy failed: '+$databaseName) }
        Write-Host ('Database snapshot: '+$snapshot)
        if ($databaseName -eq 'archive.sqlite3') { $archiveSnapshot = $snapshot }
    }
    return $archiveSnapshot
}

function Install-LianbanOnline {
    [CmdletBinding()]
    param([string]$InstallDir,[switch]$NoStart,[switch]$NoBrowser,[ValidateRange(1024,65504)][int]$Port=8765)
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem -or
        $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64' -or
        [Environment]::OSVersion.Version.Major -lt 10) { throw 'This installer supports Windows 10/11 x64.' }
    if ([string]::IsNullOrWhiteSpace($InstallDir)) {
        $localData = $env:LOCALAPPDATA
        if ([string]::IsNullOrWhiteSpace($localData)) { $localData=[Environment]::GetFolderPath('LocalApplicationData') }
        $InstallDir = Join-Path $localData 'LianbanArchive'
    }
    $base = [IO.Path]::GetFullPath($InstallDir)
    if ($base.Equals([IO.Path]::GetPathRoot($base),[StringComparison]::OrdinalIgnoreCase)) { throw 'Choose an installation folder, not a drive or share root.' }
    $base = $base.TrimEnd([char[]]'\/')
    [void][IO.Directory]::CreateDirectory($base)
    try { $lock=[IO.File]::Open((Join-Path $base '.install.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
    catch { throw 'Another installation is running in this folder. Try again after it finishes.' }
    $old = $null
    $oldSession = $null
    $oldStopped = $false
    $newRoot = $null
    $newStartAttempted = $false
    try {
        $ownerPath = Join-Path $base 'installer-owner.json'
        if (Test-Path -LiteralPath $ownerPath) {
            $owner = Get-Content -LiteralPath $ownerPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($owner.product -ne 'x107108/lianban-archive-desktop') { throw 'This folder belongs to another application.' }
        } else {
            $otherFiles = @(Get-ChildItem -LiteralPath $base -Force | Where-Object { $_.Name -ne '.install.lock' })
            if ($otherFiles.Count -gt 0) { throw 'This folder is not managed by this installer. Choose a new empty -InstallDir; existing files were retained.' }
            [IO.File]::WriteAllText($ownerPath,'{"product":"x107108/lianban-archive-desktop"}',[Text.UTF8Encoding]::new($false))
        }
        $old = Get-LianbanActive $base
        $workspace = Join-Path $base ('downloads\'+[guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($workspace)
        Write-Host 'Checking the latest official release...'
        $release = Get-LianbanRelease $workspace
        [void](Get-LianbanVersion $release.Version)
        if ($old -and (Get-LianbanVersion $old.Version).CompareTo((Get-LianbanVersion $release.Version)) -ge 0) {
            if ($old.Version -eq $release.Version -and $old.Sha256 -ne $release.Sha256) { throw 'The release checksum changed. Your existing installation was retained.' }
            Write-Host ('Reusing installed version '+$old.Version)
            Invoke-LianbanLauncher $old.Root 'verify'
            $website = $null
            if (-not $NoStart) {
                Invoke-LianbanLauncher $old.Root 'start' -HideBrowser:$NoBrowser -WebsitePort $Port
                $website = Get-LianbanSession $old.Root
                if (-not $website) { throw 'The installed website did not respond.' }
            }
            return [pscustomobject]@{Version=$old.Version; InstallFolder=$old.Root; Website=$(if($website){$website.Url}else{''}); Reused=$true}
        }
        $zipPath = Join-Path $workspace $release.Filename
        Write-Host ('Downloading version '+$release.Version+'...')
        Save-LianbanDownload $release.Url $zipPath
        if ((Get-LianbanHash $zipPath) -ne $release.Sha256) { throw 'Downloaded ZIP failed SHA-256 verification. Nothing was installed over your previous version.' }
        $relativeStage = 'versions\'+$release.Version+'-'+[guid]::NewGuid().ToString('N').Substring(0,12)
        $stage = Resolve-LianbanChild $base $relativeStage
        Assert-LianbanArchive $zipPath $stage
        [IO.Compression.ZipFile]::ExtractToDirectory($zipPath,$stage)
        $relativeRoot = $relativeStage+'\lianban-archive-desktop'
        $newRoot = Resolve-LianbanChild $base $relativeRoot
        foreach ($required in @('launcher.ps1','BUNDLE.json','VERSION.json','setup_shared.py')) {
            if (-not (Test-Path -LiteralPath (Join-Path $newRoot $required) -PathType Leaf)) { throw 'The release is missing required installation files.' }
        }
        if ((Get-Content -LiteralPath (Join-Path $newRoot 'VERSION.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version -ne $release.Version) { throw 'The ZIP version differs from its release.' }
        Assert-LianbanRuntimePaths $newRoot
        Write-Host 'Installing the bundled runtime and historical data...'
        Invoke-LianbanLauncher $newRoot 'install'
        Invoke-LianbanLauncher $newRoot 'verify'
        if ($old) {
            Invoke-LianbanLauncher $old.Root 'verify'
            $oldSession = Get-LianbanSession $old.Root
            Invoke-LianbanLauncher $old.Root 'stop'
            $oldStopped = $true
            if (Get-LianbanSession $old.Root) { throw 'The previous website is still running; personal data was not copied.' }
            [void](Copy-LianbanPersonalDatabase $old.Root $newRoot $base)
        }
        $website = $null
        if (-not $NoStart) {
            $newStartAttempted = $true
            Invoke-LianbanLauncher $newRoot 'start' -HideBrowser:$NoBrowser -WebsitePort $Port
            $website = Get-LianbanSession $newRoot
            if (-not $website) { throw 'The newly installed website did not respond.' }
        }
        Write-LianbanActive $base @{product='x107108/lianban-archive-desktop';version=$release.Version;root=$relativeRoot;sha256=$release.Sha256}
        Write-Host 'Installation completed. Use start_demo.cmd and stop_demo.cmd in the installation folder.'
        return [pscustomobject]@{Version=$release.Version; InstallFolder=$newRoot; Website=$(if($website){$website.Url}else{''}); Reused=$false}
    } catch {
        $failure = $_
        if ($newStartAttempted -and $newRoot) {
            try { Invoke-LianbanLauncher $newRoot 'stop' } catch { Write-Warning 'The new copy may still be running. Its files were retained.' }
        }
        if ($oldStopped -and $oldSession -and $old) {
            try { Invoke-LianbanLauncher $old.Root 'start' -HideBrowser -WebsitePort $oldSession.Port }
            catch { Write-Warning 'The previous copy could not be restarted automatically. Its data and start_demo.cmd were retained.' }
        }
        throw $failure
    } finally { $lock.Dispose() }
}

if ($MyInvocation.InvocationName -ne '.') {
    Install-LianbanOnline @PSBoundParameters | Format-List Version,InstallFolder,Website,Reused
}
