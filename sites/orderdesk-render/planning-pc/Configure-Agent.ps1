param([Parameter(Mandatory=$true)][string]$SiteUrl,[Parameter(Mandatory=$true)][string]$NodePath,[string]$StoreId='',[switch]$PrivateSites)
$ErrorActionPreference='Stop'
$uri=[Uri]$SiteUrl
if($uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment){throw 'Use the HTTPS website address'}
if(-not(Test-Path -LiteralPath $NodePath -PathType Leaf)){throw 'Node executable not found'}
$version=& $NodePath -p 'process.versions.node'
if([version]$version -lt [version]'22.13.0'){throw 'Node 22.13 or newer is required'}
$destination=Join-Path $PSScriptRoot 'agent-settings.json'
if(Test-Path -LiteralPath $destination){throw 'Configuration already exists. Preserve it; ask the installer to update the existing setup.'}
$token=Read-Host 'Website Planning-agent token (hidden)' -AsSecureString
if($token.Length -lt 32){throw 'Use the random website agent token (at least 32 characters)'}
$siteToken=''
if($PrivateSites){$siteToken=ConvertFrom-SecureString (Read-Host 'Private Sites service access token (hidden)' -AsSecureString)}
$config=[ordered]@{siteUrl=$uri.GetLeftPart([UriPartial]::Authority);nodePath=[IO.Path]::GetFullPath($NodePath);storeId=$StoreId;agentTokenProtected=(ConvertFrom-SecureString $token);siteTokenProtected=$siteToken}
$config|ConvertTo-Json|Set-Content -LiteralPath $destination -Encoding UTF8
Write-Host 'Configured for this Windows user on this computer. Next: .\Run-Agent.ps1 -VerifyOnly'
