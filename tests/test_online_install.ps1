$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\install-online.ps1')
Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
$testRoot=Join-Path $PSScriptRoot ('..\.build\online-unit-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
$testCount=0
function Assert-Test([bool]$Value,[string]$Message) {
    if (-not $Value) { throw $Message }
    $script:testCount++
}
function Assert-Rejected([scriptblock]$Action,[string]$Message) {
    $rejected=$false
    try { & $Action | Out-Null } catch { $rejected=$true }
    Assert-Test $rejected $Message
}
function New-TestZip([string]$Name,[string[]]$Entries,[switch]$Link) {
    $path=Join-Path $testRoot $Name
    $zip=[IO.Compression.ZipFile]::Open($path,[IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach($name in $Entries) {
            $entry=$zip.CreateEntry($name)
            if ($Link) { $entry.ExternalAttributes=0xa000 -shl 16 }
            $writer=[IO.StreamWriter]::new($entry.Open())
            try { $writer.Write('fixture') } finally { $writer.Dispose() }
        }
    } finally { $zip.Dispose() }
    return $path
}

$digest='a'*64
$release=ConvertFrom-LianbanChecksum ($digest+'  lianban-archive-desktop-v2026.10.20.1.zip'+"`r`n")
Assert-Test ($release.Version -eq '2026.10.20.1') 'Version was not parsed.'
Assert-Test ($release.Url -eq 'https://github.com/x107108/lianban-archive-desktop/releases/download/v2026.10.20.1/lianban-archive-desktop-v2026.10.20.1.zip') 'Download must be pinned to the exact release.'
Assert-Test ((Get-LianbanVersion '2026.10.20.10') -gt (Get-LianbanVersion '2026.10.20.2')) 'Numeric version order is wrong.'
Assert-Rejected { Get-LianbanVersion '2026.02.30' } 'Impossible dates must be rejected.'
Assert-Rejected { ConvertFrom-LianbanChecksum ($digest+'  ../../evil.zip') } 'Unexpected filenames must be rejected.'
Assert-Rejected { ConvertFrom-LianbanChecksum (($digest+'  lianban-archive-desktop-v2026.10.20.zip')+"`n"+($digest+'  lianban-archive-desktop-v2026.10.21.zip')) } 'Ambiguous releases must be rejected.'
Assert-Rejected { Resolve-LianbanChild $testRoot '..\outside' } 'State paths must stay inside the install directory.'
Assert-Rejected { Resolve-LianbanChild $testRoot 'C:\outside' } 'Absolute state paths must be rejected.'

$good=New-TestZip 'good.zip' @('lianban-archive-desktop/file.txt')
Assert-LianbanArchive $good (Join-Path $testRoot 'extract')
Assert-Test $true 'Valid ZIP rejected.'
$unsafe=@('lianban-archive-desktop/../outside','lianban-archive-desktop/data/archive.sqlite3',
    'lianban-archive-desktop/.runtime/python.exe','lianban-archive-desktop/.git/config',
    'other/file.txt','lianban-archive-desktop/C:/file','lianban-archive-desktop\file.txt')
for($index=0;$index -lt $unsafe.Count;$index++) {
    $bad=New-TestZip ('bad-'+$index+'.zip') @($unsafe[$index])
    Assert-Rejected { Assert-LianbanArchive $bad (Join-Path $testRoot 'extract') } ('Unsafe ZIP accepted: '+$unsafe[$index])
}
$duplicate=New-TestZip 'duplicate.zip' @('lianban-archive-desktop/A.txt','lianban-archive-desktop/a.txt')
Assert-Rejected { Assert-LianbanArchive $duplicate (Join-Path $testRoot 'extract') } 'Case-insensitive duplicate paths must be rejected.'
$symlink=New-TestZip 'symlink.zip' @('lianban-archive-desktop/link') -Link
Assert-Rejected { Assert-LianbanArchive $symlink (Join-Path $testRoot 'extract') } 'Symbolic links must be rejected.'

$longRoot=Join-Path $testRoot ('p'*110)
[void][IO.Directory]::CreateDirectory($longRoot)
$wheelFixture=New-TestZip 'wheel.zip' @('package/module.py')
[IO.File]::Copy($wheelFixture,(Join-Path $longRoot 'wheel.zip'))
[IO.File]::WriteAllText((Join-Path $longRoot 'BUNDLE.json'),'{"wheels":["wheel.zip"]}')
Assert-Rejected { Assert-LianbanRuntimePaths $longRoot } 'Long runtime paths must fail before installing.'

$owned=Join-Path $testRoot 'owned'
[void][IO.Directory]::CreateDirectory((Join-Path $owned 'versions\one'))
[IO.File]::WriteAllText((Join-Path $owned 'versions\one\VERSION.json'),'{"version":"2026.10.20.1"}')
Write-LianbanActive $owned @{product='x107108/lianban-archive-desktop';version='2026.10.20.1';root='versions\one';sha256=$digest}
Assert-Test ((Get-LianbanActive $owned).Version -eq '2026.10.20.1') 'Managed state could not be read.'
Write-LianbanActive $owned @{product='x107108/lianban-archive-desktop';version='2026.10.20.1';root='..\escape';sha256=$digest}
Assert-Rejected { Get-LianbanActive $owned } 'An escaping active-install path must be rejected.'

$unrelated=Join-Path $testRoot 'unrelated'
[void][IO.Directory]::CreateDirectory($unrelated)
$personal=Join-Path $unrelated 'personal.txt'
[IO.File]::WriteAllText($personal,'keep this file')
Assert-Rejected { Install-LianbanOnline -InstallDir $unrelated -NoStart } 'An unrelated existing folder must not be taken over.'
Assert-Test ([IO.File]::ReadAllText($personal) -eq 'keep this file') 'An unrelated file changed.'
Write-Host ('PASS: '+$testCount+' online installer validation checks. Test files retained in .build.')
