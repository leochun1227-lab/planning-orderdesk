param([switch]$VerifyOnly)
# Reads GR, AU production finish and PGI per chassis from SAP HANA (read-only) and posts them to the
# website (/api/sap-grgi). PGI uses the same SQL as the Planning Schedule workbook's Power Query "PGI".
#   GR : goods receipt 101 at plant 3111 by the chassis serial number (SER03/OBJK), with a PO
#   FG : the same without a PO = AU production finished
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
# Goods receipts 101 at plant 3111 found by the chassis serial number on the material document (SER03 + OBJK),
# not through the sales order (new POs are not account-assigned to the sales order). Reversed lines (102) excluded.
# With a PO = received from Longtree (GR); without a PO = AU production finished.
$receiptSql=@'
SELECT DISTINCT o.SERNR AS CHASSIS, m.BUDAT_MKPF AS POSTING_DATE, COALESCE(m.EBELN, '') AS PO, m.MBLNR AS DOC
FROM "SAPHANADB"."OBJK" AS o
JOIN "SAPHANADB"."SER03" AS s ON s.OBKNR = o.OBKNR AND s.BWART = '101'
JOIN "SAPHANADB"."NSDM_V_MSEG" AS m ON m.MBLNR = s.MBLNR AND m.MJAHR = s.MJAHR AND m.ZEILE = s.ZEILE
WHERE m.BWART = '101' AND m.WERKS = '3111' AND o.SERNR IS NOT NULL
  AND CONCAT(m.MBLNR, m.ZEILE) NOT IN (SELECT DISTINCT CONCAT(SMBLN, SMBLP) FROM "SAPHANADB"."NSDM_V_MSEG" WHERE BWART = '102')
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
$result=[ordered]@{ok=$false;at=(Get-Date).ToString('o');verifyOnly=[bool]$VerifyOnly;grRows=0;fgRows=0;giRows=0;uploaded=$false;message=''}
$connection=$null
try{
  $sap=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'sap-settings.json') -Raw|ConvertFrom-Json
  $agent=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'agent-settings.json') -Raw|ConvertFrom-Json
  $password=Unprotect-Value $sap.passwordProtected
  $connection=New-Object System.Data.Odbc.OdbcConnection ('DRIVER={'+$sap.driver+'};SERVERNODE='+$sap.server+';UID='+(Odbc-Value $sap.user)+';PWD='+(Odbc-Value $password)+';')
  $password=$null
  $connection.Open()
  $receipts=Read-Rows $connection $receiptSql @(1)
  $gr=New-Object 'System.Collections.Generic.List[string]'; $fg=New-Object 'System.Collections.Generic.List[string]'
  foreach($r in $receipts){ if($r -match '^\[("[^"]*"),("[^"]*"),"",("[^"]*")\]$'){ $fg.Add('['+$matches[1]+','+$matches[2]+','+$matches[3]+']') } else { $gr.Add($r) } }
  $gi=Read-Rows $connection $giSql @(1)
  $result.grRows=$gr.Count; $result.fgRows=$fg.Count; $result.giRows=$gi.Count
  if($gr.Count -lt 1 -and $gi.Count -lt 1){throw 'SAP returned no GR or PGI rows; nothing was sent.'}
  $result.sampleGr=@($gr|Select-Object -Last 3); $result.sampleFg=@($fg|Select-Object -Last 3); $result.sampleGi=@($gi|Select-Object -First 3)
  if($VerifyOnly){$result.ok=$true;$result.message='Read-only check finished; nothing was sent.'}
  else{
    $body='{"source":"SAP HANA '+$sap.server+'","gr":['+($gr -join ',')+'],"fg":['+($fg -join ',')+'],"gi":['+($gi -join ',')+']}'
    $token=Unprotect-Value $agent.agentTokenProtected
    $uri=([Uri]$agent.siteUrl).GetLeftPart([UriPartial]::Authority)+'/api/sap-grgi'
    $response=Invoke-RestMethod -Method Post -Uri $uri -Headers @{Authorization='Bearer '+$token} -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 180
    $token=$null
    $result.ok=$true;$result.uploaded=$true;$result.message="Website saved $($response.chassis) chassis (GR $($response.gr), production finished $($response.fg), PGI $($response.gi))."
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
