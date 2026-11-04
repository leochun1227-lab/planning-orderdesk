import {parseReportRows} from './order-engine.mjs';
import {MAX_ATTACHMENT_BYTES,MailSyncError} from './outlook-report.mjs';
export async function parseCrmWorkbook(bytes){
  if(!bytes?.length||bytes.length>MAX_ATTACHMENT_BYTES)throw new MailSyncError('size','CRM 附件大小无效');
  const {default:ExcelJS}=await import('exceljs');
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(bytes);
  const sheet=wb.worksheets[0];if(!sheet||sheet.rowCount>30050||sheet.columnCount>100)throw new MailSyncError('workbook','CRM 工作表尺寸无效');
  const cell=v=>v instanceof Date?v.toISOString().slice(0,10):v&&typeof v==='object'?'result'in v?cell(v.result):v.richText?v.richText.map(x=>x.text).join(''):v.text??null:v;
  const rows=Array.from({length:sheet.rowCount},(_,i)=>Array.from({length:Math.max(15,sheet.columnCount)},(_,j)=>cell(sheet.getRow(i+1).getCell(j+1).value)));
  const required=['Car Frame Number','Quote Status','Product Description','Quote Dealer Store','C Customer','Expected Delivery Date'];
  if(!rows.some(r=>required.every(h=>r.some(v=>String(v??'').trim()===h))))throw new MailSyncError('workbook','CRM 报告缺少必要表头');
  const reportDate=(sheet.name+' '+rows.slice(0,8).flat().join(' ')).match(/20\d{2}-\d{2}-\d{2}/)?.[0];
  if(!reportDate||Number.isNaN(Date.parse(reportDate))||new Date(reportDate).toISOString().slice(0,10)!==reportDate)throw new MailSyncError('date','无法识别 CRM 报告日期，未自动导入');
  return {records:parseReportRows(rows),reportDate};
}
