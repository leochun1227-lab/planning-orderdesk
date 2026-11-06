$ErrorActionPreference='Stop'
if((Get-TimeZone).Id -ne 'AUS Eastern Standard Time'){throw 'Set this computer to Sydney time (AUS Eastern Standard Time) before installing the 00:20 task.'}
$configPath=Join-Path $PSScriptRoot 'agent-settings.json'
if(-not(Test-Path -LiteralPath $configPath)){throw 'Configure this computer first'}
$resultPath=Join-Path $PSScriptRoot 'last-run.json'
if(-not(Test-Path -LiteralPath $resultPath)){throw 'Run verification on this computer first'}
$result=Get-Content -LiteralPath $resultPath -Raw|ConvertFrom-Json
# The read-only test proves Outlook mailbox/folder access and the website token. It only sees mail received in the
# window (since 00:00, at most the last 30 minutes), so outside 00:05-00:30 it normally finds no report; that is accepted, an error is not.
if(-not $result.verifyOnly -or $result.error){throw 'Run .\Run-Agent.ps1 -VerifyOnly first; it must finish without an error'}
if($result.matchedMessages -lt 1){Write-Warning 'Verification found no report in the window (normal outside 00:05-00:30). Check last-run.json and the website after the first 00:20 run.'}
$taskName='OrderDesk Planning CRM Reader'
if(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue){throw 'Task already exists. Do not install a second copy.'}
$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$run=Join-Path $PSScriptRoot 'Run-Agent.ps1'
$powershell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action=New-ScheduledTaskAction -Execute $powershell -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -File "'+$run+'" -Scheduled') -WorkingDirectory $PSScriptRoot
$daily=New-ScheduledTaskTrigger -Daily -At '00:20'
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 12) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -WakeToRun
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $daily -Principal $principal -Settings $settings -Description 'At 00:20 Sydney daily, read the CRM report received since 00:00 (Inbox and CRM Report). No catch-up.'|Out-Null
Write-Host 'Installed: daily at 00:20 Sydney; Inbox + CRM Report, mail received since 00:00 only. No logon trigger or missed-run catch-up.'
