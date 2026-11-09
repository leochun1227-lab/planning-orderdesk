param([string]$Server='10.11.2.25:30241',[string]$Driver='HDBODBC',[switch]$Replace)
# Saves the SAP HANA connection for Sync-SapGrGi.ps1. The password is encrypted with Windows DPAPI:
# only this Windows user on this computer can read it. Nothing is sent anywhere by this script.
$ErrorActionPreference='Stop'
$found=Get-OdbcDriver -Platform '64-bit' -ErrorAction SilentlyContinue|Where-Object {$_.Name -like "*$Driver*"}
if(-not $found){throw "SAP HANA ODBC driver '$Driver' (64-bit) is not installed on this computer. Install the SAP HANA client first."}
$destination=Join-Path $PSScriptRoot 'sap-settings.json'
if((Test-Path -LiteralPath $destination) -and -not $Replace){throw 'sap-settings.json already exists. Use -Replace to overwrite it.'}
$user=Read-Host 'SAP HANA user'
if(-not $user){throw 'User is required'}
$password=Read-Host 'SAP HANA password (hidden)' -AsSecureString
if($password.Length -lt 1){throw 'Password is required'}
$config=[ordered]@{server=$Server;driver=$found[0].Name;user=$user;passwordProtected=(ConvertFrom-SecureString $password)}
$config|ConvertTo-Json|Set-Content -LiteralPath $destination -Encoding UTF8
Write-Host "Saved for this Windows user ($($found[0].Name), $Server). Next: .\Sync-SapGrGi.ps1 -VerifyOnly"
