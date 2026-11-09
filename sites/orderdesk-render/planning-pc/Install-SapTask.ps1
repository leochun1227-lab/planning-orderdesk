param([string[]]$Times=@('06:40','09:40','12:40','15:40','18:40'),[switch]$Replace)
# Installs the SAP GR/GI sync as a scheduled task (default five times a day). Requires a successful
# .\Sync-SapGrGi.ps1 -VerifyOnly first. Runs as this Windows user (the SAP password is stored for this user).
$ErrorActionPreference='Stop'
foreach($f in 'sap-settings.json','agent-settings.json'){ if(-not(Test-Path -LiteralPath (Join-Path $PSScriptRoot $f))){throw "$f is missing; configure this computer first"} }
$resultPath=Join-Path $PSScriptRoot 'sap-last-run.json'
if(-not(Test-Path -LiteralPath $resultPath)){throw 'Run .\Sync-SapGrGi.ps1 -VerifyOnly first'}
$result=Get-Content -LiteralPath $resultPath -Raw|ConvertFrom-Json
if(-not $result.ok){throw 'The last SAP check failed; fix it and run .\Sync-SapGrGi.ps1 -VerifyOnly again'}
$taskName='OrderDesk SAP GR GI'
if(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue){
  if(-not $Replace){throw 'Task already exists. Use -Replace to reinstall it.'}
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$script=Join-Path $PSScriptRoot 'Sync-SapGrGi.ps1'
$powershell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action=New-ScheduledTaskAction -Execute $powershell -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$script+'"') -WorkingDirectory $PSScriptRoot
$triggers=@($Times|ForEach-Object {New-ScheduledTaskTrigger -Daily -At $_})
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Description 'Read GR and PGI per chassis from SAP HANA (read-only) and send them to the Orderdesk website.'|Out-Null
Write-Host ('Installed: '+($Times -join ', ')+' daily. Result of each run: sap-last-run.json')
