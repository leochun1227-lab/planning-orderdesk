param([string[]]$Chassis=@('SRC263676','SRT263681','SRC263675','SRP263700','SRC263618','SRH264638','SRC265008','SRP264481'))
# Read-only check of what the "完工入库" (movement 101 at plant 3111 without a PO, found by chassis serial)
# really is: production-order receipts, or something else. Prints results; sends nothing.
$ErrorActionPreference='Stop'
function Unprotect-Value([string]$value){
  $secure=ConvertTo-SecureString $value
  $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try{return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)}
}
function Odbc-Value([string]$v){ if($v -match '[;{}=]'){return '{'+$v.Replace('}','}}')+'}'} ; return $v }
function Show($connection,[string]$title,[string]$sql){
  Write-Host "`n==== $title" -ForegroundColor Cyan
  try{
    $command=$connection.CreateCommand(); $command.CommandText=$sql; $command.CommandTimeout=600
    $table=New-Object System.Data.DataTable; $table.Load($command.ExecuteReader())
    if($table.Rows.Count -eq 0){Write-Host '(no rows)'}else{$table|Format-Table -AutoSize|Out-String -Width 250|Write-Host}
  }catch{Write-Host ('ERROR: '+$_.Exception.Message) -ForegroundColor Red}
}
$sap=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'sap-settings.json') -Raw|ConvertFrom-Json
$password=Unprotect-Value $sap.passwordProtected
$connection=New-Object System.Data.Odbc.OdbcConnection ('DRIVER={'+$sap.driver+'};SERVERNODE='+$sap.server+';UID='+(Odbc-Value $sap.user)+';PWD='+(Odbc-Value $password)+';')
$password=$null
$connection.Open()
$base=@"
FROM "SAPHANADB"."OBJK" o
JOIN "SAPHANADB"."SER03" s ON s.OBKNR = o.OBKNR AND s.BWART = '101'
JOIN "SAPHANADB"."NSDM_V_MSEG" m ON m.MBLNR = s.MBLNR AND m.MJAHR = s.MJAHR AND m.ZEILE = s.ZEILE
LEFT JOIN "SAPHANADB"."AUFK" a ON a.AUFNR = m.AUFNR
WHERE m.BWART = '101' AND m.WERKS = '3111' AND o.SERNR IS NOT NULL
  AND CONCAT(m.MBLNR, m.ZEILE) NOT IN (SELECT DISTINCT CONCAT(SMBLN, SMBLP) FROM "SAPHANADB"."NSDM_V_MSEG" WHERE BWART = '102')
"@
try{
  Show $connection '1. 101 at 3111 by serial: with / without PO, movement indicator (KZBEW), production order type' @"
SELECT CASE WHEN COALESCE(m.EBELN,'') = '' THEN 'no PO' ELSE 'PO' END AS PO, m.KZBEW,
       CASE WHEN COALESCE(m.AUFNR,'') = '' THEN 'no order' ELSE 'order' END AS PROD_ORDER, a.AUART,
       COUNT(DISTINCT o.SERNR) AS CHASSIS, MIN(m.BUDAT_MKPF) AS FIRST_DATE, MAX(m.BUDAT_MKPF) AS LAST_DATE
$base
GROUP BY CASE WHEN COALESCE(m.EBELN,'') = '' THEN 'no PO' ELSE 'PO' END, m.KZBEW, CASE WHEN COALESCE(m.AUFNR,'') = '' THEN 'no order' ELSE 'order' END, a.AUART
ORDER BY CHASSIS DESC
"@
  $list=($Chassis|ForEach-Object {"'"+($_ -replace "'","")+"'"}) -join ','
  Show $connection '2. Sample chassis: every 101 at 3111 (first five: the "finish" receipt is months before the GR)' @"
SELECT o.SERNR, m.BUDAT_MKPF, m.MBLNR, m.ZEILE, m.EBELN, m.KZBEW, m.AUFNR, a.AUART, m.LGORT, m.MATNR
$base AND o.SERNR IN ($list)
ORDER BY o.SERNR, m.BUDAT_MKPF
"@
  Show $connection '3. Sample chassis: all serial movements (any type, any plant) for context' @"
SELECT o.SERNR, s.DATUM, s.BWART, m.WERKS, m.LGORT, m.EBELN, m.AUFNR, m.KZBEW, s.MBLNR
FROM "SAPHANADB"."OBJK" o JOIN "SAPHANADB"."SER03" s ON s.OBKNR = o.OBKNR
LEFT JOIN "SAPHANADB"."NSDM_V_MSEG" m ON m.MBLNR = s.MBLNR AND m.MJAHR = s.MJAHR AND m.ZEILE = s.ZEILE
WHERE o.SERNR IN ($list) ORDER BY o.SERNR, s.DATUM
"@
}finally{$connection.Close()}
Write-Host "`nDone. Nothing was sent anywhere. Copy the output (or a screenshot) back to Claude." -ForegroundColor Green
