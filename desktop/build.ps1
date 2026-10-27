param([Parameter(Mandatory=$true)][string]$NodePath,[Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference='Stop'
$projectDir=Split-Path -Parent $PSScriptRoot
$buildDir=Join-Path $projectDir 'build'
$stageDir=Join-Path $buildDir ('payload-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $stageDir 'app') -Force | Out-Null
Copy-Item -LiteralPath $NodePath -Destination (Join-Path $stageDir 'node.exe')
Copy-Item -LiteralPath (Join-Path (Split-Path $NodePath) 'LICENSE') -Destination (Join-Path $stageDir 'NODE-LICENSE.txt')
foreach($name in @('src','app','daily','tests')){Copy-Item -LiteralPath (Join-Path $projectDir $name) -Destination (Join-Path $stageDir 'app') -Recurse}
foreach($name in @('server.mjs','run.mjs','scheduler.mjs','config.example.json','package.json','LICENSE','README-DESKTOP.md')){Copy-Item -LiteralPath (Join-Path $projectDir $name) -Destination (Join-Path $stageDir 'app')}
$zipPath=Join-Path $buildDir ('payload-'+[guid]::NewGuid().ToString('N')+'.zip')
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($stageDir,$zipPath,[IO.Compression.CompressionLevel]::Optimal,$false)
$buildNumber=([int]((Get-Date).ToUniversalTime()-[datetime]'2026-10-01').TotalMinutes)%60000
$assembly=Join-Path $buildDir 'AssemblyInfo.cs'
$source='using System.Reflection;[assembly: AssemblyTitle("LeadRadar")][assembly: AssemblyProduct("LeadRadar Desktop")][assembly: AssemblyVersion("3.2.0.'+$buildNumber+'")][assembly: AssemblyFileVersion("3.2.0.'+$buildNumber+'") ]'
[IO.File]::WriteAllText($assembly,$source,[Text.UTF8Encoding]::new($false))
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPath) -Force | Out-Null
& $compiler /nologo /target:winexe /platform:x64 /optimize+ "/out:$OutputPath" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll "/resource:$zipPath,payload.zip" (Join-Path $PSScriptRoot 'LauncherV2.cs') $assembly
if($LASTEXITCODE -ne 0){throw 'EXE compilation failed'}
Get-Item -LiteralPath $OutputPath | Select-Object FullName,Length
Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256
