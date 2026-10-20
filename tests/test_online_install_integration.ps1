# Requires a previously downloaded official release ZIP. All fixtures stay in .build.
# No fixture is uploaded or used by ordinary installations.
param([Parameter(Mandatory=$true)][string]$ReleaseZip,[int]$WebsitePort=18769)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\install-online.ps1')
Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
$integrationRoot=Join-Path $PSScriptRoot ('..\.build\oi-'+[guid]::NewGuid().ToString('N').Substring(0,8))
$integrationBase=Join-Path $integrationRoot 'managed install'
[void][IO.Directory]::CreateDirectory($integrationRoot)
$ReleaseZip=[IO.Path]::GetFullPath($ReleaseZip)
$sourceArchive=[IO.Compression.ZipFile]::OpenRead($ReleaseZip)
try {
    $versionEntry=$sourceArchive.GetEntry('lianban-archive-desktop/VERSION.json')
    $reader=[IO.StreamReader]::new($versionEntry.Open())
    try { $sourceVersion=($reader.ReadToEnd()|ConvertFrom-Json).version } finally { $reader.Dispose() }
} finally { $sourceArchive.Dispose() }
$nextRevision=(Get-LianbanVersion $sourceVersion).Revision+1
$nextVersion=$sourceVersion.Substring(0,10)+'.'+$nextRevision
$brokenVersion=$sourceVersion.Substring(0,10)+'.'+($nextRevision+1)
$checks=0
function Assert-Integration([bool]$Condition,[string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:checks++
}
function Set-Fixture([string]$Path,[string]$Version,[switch]$BadHash) {
    $script:fixturePath=$Path
    $script:fixture=[pscustomobject]@{Version=$Version;Filename=('lianban-archive-desktop-v'+$Version+'.zip');
        Sha256=(Get-LianbanHash $Path);Url=('https://github.com/x107108/lianban-archive-desktop/releases/download/v'+$Version+'/fixture.zip')}
    if ($BadHash) { $script:fixture.Sha256='0'*64 }
}
function Get-LianbanRelease([string]$Workspace) { return $script:fixture }
function Save-LianbanDownload([string]$Url,[string]$Destination) { [IO.File]::Copy($script:fixturePath,$Destination) }
function New-ReleaseFixture([string]$Version,[switch]$BrokenStart) {
    $stage=Join-Path $integrationRoot ('fixture-'+$Version)
    [IO.Compression.ZipFile]::ExtractToDirectory($ReleaseZip,$stage)
    $project=Join-Path $stage 'lianban-archive-desktop'
    [IO.File]::WriteAllText((Join-Path $project 'VERSION.json'),('{"version":"'+$Version+'"}'),[Text.UTF8Encoding]::new($false))
    $bundlePath=Join-Path $project 'BUNDLE.json'
    $bundle=Get-Content -LiteralPath $bundlePath -Raw -Encoding UTF8|ConvertFrom-Json
    $bundle.id='integration-'+[guid]::NewGuid().ToString('N')
    $bundle.sha256.PSObject.Properties['VERSION.json'].Value=Get-LianbanHash (Join-Path $project 'VERSION.json')
    if ($BrokenStart) {
        [IO.File]::WriteAllText((Join-Path $project 'desktop.py'),"raise RuntimeError('intentional isolated integration fixture failure')`n")
        $bundle.sha256.PSObject.Properties['desktop.py'].Value=Get-LianbanHash (Join-Path $project 'desktop.py')
    }
    [IO.File]::WriteAllText($bundlePath,($bundle|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
    $zip=Join-Path $integrationRoot ('release-'+$Version+'.zip')
    $archive=[IO.Compression.ZipFile]::Open($zip,[IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach($file in [IO.Directory]::EnumerateFiles($project,'*',[IO.SearchOption]::AllDirectories)) {
            $entryName='lianban-archive-desktop/'+$file.Substring($project.Length+1).Replace('\','/')
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$file,$entryName,[IO.Compression.CompressionLevel]::Fastest)
        }
    } finally { $archive.Dispose() }
    return $zip
}
function Assert-PersonalData([string]$Url,[string]$Code) {
    $note=Invoke-RestMethod ($Url+'/api/stock-note?code='+$Code)
    $tags=Invoke-RestMethod ($Url+'/api/stock-tags?code='+$Code)
    $blacklist=Invoke-RestMethod ($Url+'/api/blacklist')
    Assert-Integration ($note.content -eq 'online installer integration note') 'Personal note was lost.'
    Assert-Integration ($tags.tags -contains 'installer test tag') 'Personal tags were lost.'
    Assert-Integration (@($blacklist.rows|Where-Object code -eq $Code).Count -eq 1) 'Blacklist membership was lost.'
}

try {
    Set-Fixture $ReleaseZip $sourceVersion
    $first=Install-LianbanOnline -InstallDir $integrationBase -NoBrowser -Port $WebsitePort
    Assert-Integration (-not $first.Reused) 'First install was not fresh.'
    Assert-Integration ($first.Website -ne '') 'First install did not return a live website.'
    $metadata=Invoke-RestMethod ($first.Website+'/api/meta')
    $day=Invoke-RestMethod ($first.Website+'/api/date?date='+$metadata.latest_date)
    $code=$day.rows[0].code
    $tag=Invoke-RestMethod ($first.Website+'/api/stock-tags?code='+$code)
    $note=Invoke-RestMethod ($first.Website+'/api/stock-note?code='+$code)
    $null=Invoke-RestMethod ($first.Website+'/api/stock-tags') -Method Post -ContentType 'application/json' -Body (@{code=$code;tags=@('installer test tag');revision=$tag.revision}|ConvertTo-Json)
    $null=Invoke-RestMethod ($first.Website+'/api/stock-note') -Method Post -ContentType 'application/json' -Body (@{code=$code;content='online installer integration note';revision=$note.revision}|ConvertTo-Json)
    $null=Invoke-RestMethod ($first.Website+'/api/blacklist') -Method Post -ContentType 'application/json' -Body (@{code=$code;action='add'}|ConvertTo-Json)
    $repeat=Install-LianbanOnline -InstallDir $integrationBase -NoBrowser -Port $WebsitePort
    Assert-Integration ($repeat.Reused -and $repeat.InstallFolder -eq $first.InstallFolder) 'Repeat install must reuse the same copy.'
    Assert-PersonalData $repeat.Website $code

    $newZip=New-ReleaseFixture $nextVersion
    Set-Fixture $newZip $nextVersion
    $upgraded=Install-LianbanOnline -InstallDir $integrationBase -NoBrowser -Port $WebsitePort
    Assert-Integration ($upgraded.Version -eq $nextVersion -and $upgraded.InstallFolder -ne $first.InstallFolder) 'Upgrade did not create a separate version.'
    Assert-PersonalData $upgraded.Website $code
    Assert-Integration (Test-Path -LiteralPath (Join-Path $first.InstallFolder 'data\archive.sqlite3')) 'Previous database was removed.'
    Assert-Integration (@(Get-ChildItem -LiteralPath (Join-Path $integrationBase 'backups') -Filter '*.sqlite3').Count -gt 0) 'No consistent database snapshot was retained.'

    Set-Fixture $newZip $brokenVersion -BadHash
    $rejected=$false
    try { Install-LianbanOnline -InstallDir $integrationBase -NoBrowser -Port $WebsitePort|Out-Null } catch { $rejected=$true }
    Assert-Integration $rejected 'Corrupt ZIP was not rejected.'
    Assert-Integration ((Get-LianbanActive $integrationBase).Root -eq $upgraded.InstallFolder) 'Bad download changed the active version.'
    Assert-PersonalData $upgraded.Website $code

    $brokenZip=New-ReleaseFixture $brokenVersion -BrokenStart
    Set-Fixture $brokenZip $brokenVersion
    $rejected=$false
    try { Install-LianbanOnline -InstallDir $integrationBase -NoBrowser -Port $WebsitePort|Out-Null } catch { $rejected=$true }
    Assert-Integration $rejected 'The intentionally broken startup was not detected.'
    $restored=Get-LianbanActive $integrationBase
    Assert-Integration ($restored.Root -eq $upgraded.InstallFolder) 'Failed startup replaced the active version.'
    $session=Get-LianbanSession $restored.Root
    Assert-Integration ($null -ne $session) 'Previous running version was not restarted after failure.'
    Assert-PersonalData $session.Url $code
    Write-Host ('PASS: '+$checks+' end-to-end checks for fresh install, reuse, personal-data upgrade, corrupt download and failed-start recovery.')
} finally {
    if (Test-Path -LiteralPath (Join-Path $integrationBase 'active-install.json')) {
        $active=Get-LianbanActive $integrationBase
        Invoke-LianbanLauncher $active.Root 'stop'
    }
}
