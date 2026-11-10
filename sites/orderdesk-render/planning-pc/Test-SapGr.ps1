param([string[]]$Chassis=@('SRC264210','SRL264346','SRC263761','SRC264285','SRP264481','SRC264260','SRT266716','SRH255030'))
# Read-only diagnosis: finds GR (movement 101 at plant 3111) by the chassis serial number on the material
# document (SER03 + OBJK), without going through the sales order. Prints results; sends nothing.
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
try{
  $list=($Chassis|ForEach-Object {"'"+($_ -replace "'","")+"'"}) -join ','
  Show $connection '1. SER03 columns' 'SELECT TOP 1 * FROM "SAPHANADB"."SER03"'
  Show $connection '2. Goods movements by serial (all movement types) for sample chassis' @"
SELECT o.SERNR, s.MBLNR, s.MJAHR, s.ZEILE, s.BWART, s.WERKS, s.DATUM
FROM "SAPHANADB"."OBJK" o JOIN "SAPHANADB"."SER03" s ON s.OBKNR = o.OBKNR
WHERE o.SERNR IN ($list) ORDER BY o.SERNR, s.DATUM
"@
  Show $connection '3. GR 101 at plant 3111 by serial, with PO and posting date' @"
SELECT o.SERNR, m.BUDAT_MKPF, m.MBLNR, m.EBELN, m.BWART, m.WERKS
FROM "SAPHANADB"."OBJK" o JOIN "SAPHANADB"."SER03" s ON s.OBKNR = o.OBKNR
JOIN "SAPHANADB"."NSDM_V_MSEG" m ON m.MBLNR = s.MBLNR AND m.MJAHR = s.MJAHR AND m.ZEILE = s.ZEILE
WHERE o.SERNR IN ($list) AND m.BWART = '101' AND m.WERKS = '3111'
"@
  Show $connection '4. How many chassis have a 101 GR at 3111 by serial' @"
SELECT COUNT(DISTINCT o.SERNR) AS CHASSIS_WITH_GR, MAX(m.BUDAT_MKPF) AS LATEST_GR
FROM "SAPHANADB"."OBJK" o JOIN "SAPHANADB"."SER03" s ON s.OBKNR = o.OBKNR
JOIN "SAPHANADB"."NSDM_V_MSEG" m ON m.MBLNR = s.MBLNR AND m.MJAHR = s.MJAHR AND m.ZEILE = s.ZEILE
WHERE m.BWART = '101' AND m.WERKS = '3111'
"@
}finally{$connection.Dispose()}
