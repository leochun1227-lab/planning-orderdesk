param([switch]$VerifyOnly,[switch]$Scheduled)
$ErrorActionPreference='Stop'
$mutex=New-Object Threading.Mutex($false,'Local\OrderDeskPlanningReader')
if(-not $mutex.WaitOne(0)){$mutex.Dispose();exit 0}
$previousToken=$env:PLANNING_AGENT_TOKEN
$previousSiteToken=$env:PLANNING_SITE_ACCESS_TOKEN
function Unprotect-Value([string]$value){
  if(-not $value){return ''}
  $secure=ConvertTo-SecureString $value
  $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try{return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)}
}
try{
  $config=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'agent-settings.json') -Raw|ConvertFrom-Json
  $env:PLANNING_AGENT_TOKEN=Unprotect-Value $config.agentTokenProtected
  $env:PLANNING_SITE_ACCESS_TOKEN=Unprotect-Value $config.siteTokenProtected
  $arguments=@((Join-Path $PSScriptRoot 'agent.mjs'))
  if($VerifyOnly){$arguments+='--verify'}
  if($Scheduled){$arguments+='--scheduled'}
  & $config.nodePath @arguments
  if($LASTEXITCODE -ne 0){throw 'Planning sync failed. See last-run.json.'}
}finally{
  $env:PLANNING_AGENT_TOKEN=$previousToken
  $env:PLANNING_SITE_ACCESS_TOKEN=$previousSiteToken
  $mutex.ReleaseMutex();$mutex.Dispose()
}
