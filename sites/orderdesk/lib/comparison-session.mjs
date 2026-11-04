import {applyReport, parseReportRows} from './order-engine.mjs';

export function makeReport(rows,fileName,sheetName,hash) {
  const match=[sheetName,...rows.slice(0,13).flat()].map(v=>String(v??'')).join(' ').match(/20\d{2}-\d{2}-\d{2}/);
  return {records:parseReportRows(rows),fileName,reportDate:match?.[0]||'',hash};
}
const options=(report,stage)=>({batchId:`comparison-${stage}`,fileName:report.fileName,businessDate:report.reportDate,reportDate:report.reportDate,now:report.reportDate+'T00:00:00+11:00'});
export function seedHistory(report,refs) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(report.reportDate))throw new Error('REPORT_DATE_REQUIRED');
  const result=applyReport({orders:{},events:{},imports:{},refs,meta:{}},report.records,options(report,'history'));
  // The first report establishes history; its existing orders are not today's new orders.
  return {...result.state,events:{},imports:{},meta:{historyReport:report.fileName,historyDate:report.reportDate}};
}
export function importLatest(history,report) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(report.reportDate))throw new Error('REPORT_DATE_REQUIRED');
  if(report.reportDate<history.meta.historyDate)throw new Error('LATEST_BEFORE_HISTORY');
  return applyReport(history,report.records,options(report,'latest'));
}
