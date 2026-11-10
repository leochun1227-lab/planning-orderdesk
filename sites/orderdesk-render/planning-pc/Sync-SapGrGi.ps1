param([switch]$VerifyOnly)
# Reads GR and PGI per chassis from SAP HANA with the same SQL as the Planning Schedule workbook's
# Power Query queries "GR" and "PGI", then posts them to the website (/api/sap-grgi).
#   GR : chassis (SER02/OBJK on sales order item 10) -> PO (EKKN item 10 -> EKKO, purch. org 3111, released)
#        -> latest EKBE goods receipt (BEWTP E, movement 101). POs without a GR are sent too (PO raised, not received).
#   PGI: NSDM_V_MSEG plant 3111, movement 601, sales order item 10, not reversed -> posting date + document
# Read-only in SAP. -VerifyOnly runs the queries and shows counts without sending anything.
$ErrorActionPreference='Stop'
$mutex=New-Object Threading.Mutex($false,'Local\OrderDeskSapGrGi')
if(-not $mutex.WaitOne(0)){$mutex.Dispose();exit 0}
$resultPath=Join-Path $PSScriptRoot 'sap-last-run.json'
function Unprotect-Value([string]$value){
  if(-not $value){return ''}
  $secure=ConvertTo-SecureString $value
  $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try{return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)}
}
function Odbc-Value([string]$v){ if($v -match '[;{}=]'){return '{'+$v.Replace('}','}}')+'}'} ; return $v }
function Sap-Date($v){
  if($v -is [DBNull] -or $null -eq $v){return ''}
  if($v -is [datetime]){return $v.ToString('yyyy-MM-dd')}
  $s=[string]$v; if($s -match '^(\d{4})-?(\d{2})-?(\d{2})'){ if($matches[1] -lt '1971'){return ''}; return "$($matches[1])-$($matches[2])-$($matches[3])" }
  return ''
}
function Json-Text([string]$s){ return '"'+($s -replace '\\','\\' -replace '"','\"')+'"' }
function Read-Rows($connection,[string]$sql,[int[]]$dateColumns){
  # Returns JSON arrays (as text) of every column; date columns become yyyy-MM-dd, rows without a chassis are skipped.
  $command=$connection.CreateCommand(); $command.CommandText=$sql; $command.CommandTimeout=900
  $reader=$command.ExecuteReader(); $rows=New-Object 'System.Collections.Generic.List[string]'
  try{
    while($reader.Read()){
      $cells=New-Object 'System.Collections.Generic.List[string]'
      for($i=0;$i -lt $reader.FieldCount;$i++){
        $v=$reader.GetValue($i)
        if($dateColumns -contains $i){$text=Sap-Date $v}elseif($v -is [DBNull]){$text=''}else{$text=([string]$v).Trim()}
        $cells.Add((Json-Text $text))
      }
      if($cells[0] -ne '""'){$rows.Add('['+($cells -join ',')+']')}
    }
  }finally{$reader.Close()}
  return ,$rows
}
$grSql=@'
SELECT objk.SERNR AS CHASSIS, gr.GR_BUDAT AS GR_DATE, ekko.EBELN AS PO, ekko.BEDAT AS PO_DATE
FROM "SAPHANADB"."VBAK" AS vbak
LEFT JOIN "SAPHANADB"."SER02" AS ser02 ON vbak.VBELN = ser02.SDAUFNR AND ser02.POSNR = 10
LEFT JOIN "SAPHANADB"."OBJK" AS objk ON ser02.OBKNR = objk.OBKNR
LEFT JOIN "SAPHANADB"."EKKN" AS ekkn ON vbak.VBELN = ekkn.VBELN AND ekkn.VBELP = 10
LEFT JOIN "SAPHANADB"."EKKO" AS ekko ON ekkn.EBELN = ekko.EBELN AND ekko.EKORG = '3111' AND ekko.FRGKE IN ('D', 'G', 'O', 'R')
LEFT JOIN (
  SELECT EBELN, MAX(BUDAT) AS GR_BUDAT FROM "SAPHANADB"."EKBE" WHERE BEWTP = 'E' AND BWART = '101' GROUP BY EBELN
) AS gr ON ekko.EBELN = gr.EBELN
WHERE objk.SERNR IS NOT NULL AND ekko.EBELN IS NOT NULL
'@
$giSql=@'
SELECT DISTINCT obj.SERNR AS CHASSIS, mseg.BUDAT_MKPF AS GI_DATE, mseg.MBLNR AS GI_DOC
FROM (
  SELECT DISTINCT KDAUF, MBLNR, BUDAT_MKPF FROM "SAPHANADB"."NSDM_V_MSEG"
  WHERE KDPOS = 10 AND WERKS = 3111 AND BWART = '601'
    AND CONCAT(MBLNR, ZEILE) NOT IN (SELECT DISTINCT CONCAT(SMBLN, SMBLP) FROM "SAPHANADB"."NSDM_V_MSEG")
) AS mseg
INNER JOIN (
  SELECT DISTINCT VBAK.VBELN, OBJK.SERNR FROM "SAPHANADB"."VBAK"
  LEFT JOIN "SAPHANADB"."SER02" ON VBAK.VBELN = SER02.SDAUFNR AND SER02.POSNR = 10
  LEFT JOIN "SAPHANADB"."OBJK" ON SER02.OBKNR = OBJK.OBKNR
  WHERE SER02.POSNR = 10
) AS obj ON mseg.KDAUF = obj.VBELN
'@
$result=[ordered]@{ok=$false;at=(Get-Date).ToString('o');verifyOnly=[bool]$VerifyOnly;grRows=0;giRows=0;uploaded=$false;message=''}
$connection=$null
try{
  $sap=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'sap-settings.json') -Raw|ConvertFrom-Json
  $agent=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'agent-settings.json') -Raw|ConvertFrom-Json
  $password=Unprotect-Value $sap.passwordProtected
  $connection=New-Object System.Data.Odbc.OdbcConnection ('DRIVER={'+$sap.driver+'};SERVERNODE='+$sap.server+';UID='+(Odbc-Value $sap.user)+';PWD='+(Odbc-Value $password)+';')
  $password=$null
  $connection.Open()
  $gr=Read-Rows $connection $grSql @(1,3)
  $gi=Read-Rows $connection $giSql @(1)
  $result.grRows=$gr.Count; $result.giRows=$gi.Count
  if($gr.Count -lt 1 -and $gi.Count -lt 1){throw 'SAP returned no GR or PGI rows; nothing was sent.'}
  $result.sampleGr=@($gr|Select-Object -First 3); $result.sampleGi=@($gi|Select-Object -First 3)
  if($VerifyOnly){$result.ok=$true;$result.message='Read-only check finished; nothing was sent.'}
  else{
    $body='{"source":"SAP HANA '+$sap.server+'","gr":['+($gr -join ',')+'],"gi":['+($gi -join ',')+']}'
    $token=Unprotect-Value $agent.agentTokenProtected
    $uri=([Uri]$agent.siteUrl).GetLeftPart([UriPartial]::Authority)+'/api/sap-grgi'
    $response=Invoke-RestMethod -Method Post -Uri $uri -Headers @{Authorization='Bearer '+$token} -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 180
    $token=$null
    $result.ok=$true;$result.uploaded=$true;$result.message="Website saved $($response.chassis) chassis (GR $($response.gr), PGI $($response.gi))."
  }
}catch{
  $result.message=$_.Exception.Message
}finally{
  if($connection){$connection.Dispose()}
  ($result|ConvertTo-Json -Depth 4)|Set-Content -LiteralPath $resultPath -Encoding UTF8
  $mutex.ReleaseMutex();$mutex.Dispose()
}
Get-Content -LiteralPath $resultPath
if(-not $result.ok){exit 1}
