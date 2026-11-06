param([Parameter(Mandatory=$true)][string]$SinceUtc,[Parameter(Mandatory=$true)][string]$UntilUtc,[Parameter(Mandatory=$true)][string]$OutputDirectory,[string]$StoreId='')
$ErrorActionPreference='Stop'
$mailbox='planning@regentrv.com.au'
$folderName='CRM Report'
$folderLabel='Inbox + CRM Report'
$sender='donotreply@my300375.mail.c4c.saphybriscloud.cn'
$subject='Sales Order Report (Customer)'
$since=[DateTimeOffset]::Parse($SinceUtc).UtcDateTime
$until=[DateTimeOffset]::Parse($UntilUtc).UtcDateTime
$minutes=($until-$since).TotalMinutes
if($minutes -lt 0 -or $minutes -gt 30){throw 'The receive window must be 0-30 minutes (00:00 to the scan)'}
$output=[IO.Path]::GetFullPath($OutputDirectory)
if(-not(Test-Path -LiteralPath $output -PathType Container)){throw 'Output directory does not exist'}
$app=$null
try {
  # Classic Outlook only. Uses the logged-in user's profile; never changes mail or guard settings.
  $app=New-Object -ComObject Outlook.Application
  $session=$app.GetNamespace('MAPI')
  $ids=New-Object 'System.Collections.Generic.HashSet[string]'
  if($StoreId){[void]$ids.Add($StoreId)}else{
    foreach($account in $session.Accounts){if($account.SmtpAddress -ieq $mailbox){[void]$ids.Add($account.DeliveryStore.StoreID)}}
    foreach($store in $session.Stores){if($store.DisplayName -ieq $mailbox -or $store.DisplayName -ieq 'Planning'){[void]$ids.Add($store.StoreID)}}
  }
  if($ids.Count -ne 1){throw 'Planning mailbox is missing or ambiguous. Configure its StoreId on this computer.'}
  $selected=@($session.Stores | Where-Object { $ids.Contains($_.StoreID) })
  if($selected.Count -ne 1){throw 'Configured Planning store was not found'}
  if($session.Offline){throw 'Outlook is offline'}
  $queue=New-Object 'System.Collections.Generic.Queue[object]'
  $queue.Enqueue($selected[0].GetRootFolder())
  $crmFolders=New-Object 'System.Collections.Generic.List[object]'
  $visited=0
  while($queue.Count -gt 0){
    if(++$visited -gt 1000){throw 'Folder scan limit exceeded'}
    $current=$queue.Dequeue()
    if($current.Name -ieq $folderName){$crmFolders.Add($current)}
    foreach($child in $current.Folders){$queue.Enqueue($child)}
  }
  if($crmFolders.Count -gt 1){throw 'CRM Report folder is ambiguous'}
  # The nightly report lands in the Inbox first; a rule may or may not have moved it to CRM Report yet.
  $folders=New-Object 'System.Collections.Generic.List[object]'
  $folders.Add($selected[0].GetDefaultFolder(6))
  foreach($folder in $crmFolders){$folders.Add($folder)}
  $seen=New-Object 'System.Collections.Generic.HashSet[string]'
  $reports=New-Object 'System.Collections.Generic.List[object]'
  $scanned=0
  foreach($folder in $folders){
  $items=$folder.Items
  $items.Sort('[ReceivedTime]',$true)
  foreach($item in $items){
    if(++$scanned -gt 10000){throw 'Message scan limit exceeded'}
    if($item.Class -ne 43){continue}
    $received=$item.ReceivedTime.ToUniversalTime()
    if($received -lt $since){break}
    if($received -gt $until){continue}
    if($item.Subject.Trim() -cne $subject){continue}
    $address=$item.SenderEmailAddress
    if($item.SenderEmailType -eq 'EX'){$exchangeUser=$item.Sender.GetExchangeUser();if($exchangeUser){$address=$exchangeUser.PrimarySmtpAddress}}
    if($address -ine $sender){continue}
    if(-not $seen.Add($item.EntryID)){continue}
    $files=@($item.Attachments | Where-Object {$_.Type -eq 1 -and $_.FileName -match '\.xlsx$'})
    if($files.Count -ne 1){throw 'A CRM email has no unique XLSX attachment'}
    if($files[0].Size -gt 10485760){throw 'CRM attachment exceeds 10 MB'}
    if($reports.Count -ge 100){throw 'More than 100 reports require backfill'}
    $hash=[Security.Cryptography.SHA256]::Create()
    try{$id=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($item.EntryID)))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
    $path=Join-Path $output ($id+'.xlsx')
    $files[0].SaveAsFile($path)
    $reports.Add([PSCustomObject]@{file=$id+'.xlsx';receivedAt=$received.ToString('o');folder=$folder.Name})
  }
  }
  $manifest=[PSCustomObject]@{mailbox=$mailbox;folder=$folderLabel;reports=@($reports.ToArray());checkedAt=[DateTime]::UtcNow.ToString('o')}
  [IO.File]::WriteAllText((Join-Path $output 'manifest.json'),($manifest|ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding($false)))
} catch {
  [Console]::Error.WriteLine('Classic Outlook collection failed: '+$_.Exception.Message)
  exit 1
} finally {
  # Do not call Quit: Outlook belongs to the signed-in user.
  if($app){[void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)}
}
