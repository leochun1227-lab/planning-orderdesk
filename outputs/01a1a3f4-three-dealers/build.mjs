import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {Workbook,SpreadsheetFile} from '@oai/artifact-tool';
const data=JSON.parse(await fs.readFile('../../sites/orderdesk/.sites-runtime/three-stock-review-data.json','utf8'));
const groups=['Leisure Lion Bundaberg','Vanari Christchurch','Destiny RV Store'];
const rows=data.rows.sort((a,b)=>groups.indexOf(a.group)-groups.indexOf(b.group)||Number(b.previousStockDifference)-Number(a.previousStockDifference)||a.chassis.localeCompare(b.chassis));
const w=Workbook.create(),summary=w.worksheets.add('汇总'),detail=w.worksheets.add('订单明细');
const ink='#283B52',blue='#233F64';
function setup(s,range,widths,title,subtitle){
 s.showGridLines=false;s.getRange(range).format.font={name:'Arial',size:10,color:ink};s.getRange(range).format.rowHeight=24;s.getRange(range).format.verticalAlignment='center';
 widths.forEach((width,i)=>s.getRange(`${String.fromCharCode(65+i)}1:${String.fromCharCode(65+i)}${range.match(/\d+$/)[0]}`).format.columnWidth=width);
 s.getRange('A2').values=[[title]];s.getRange('A2').format.font={name:'Arial',size:14,bold:true,color:ink};s.getRange('A2').format.rowHeight=30;
 s.getRange('A3').values=[[subtitle]];s.getRange('A4:'+String.fromCharCode(64+widths.length)+'4').format.borders={bottom:{style:'thin',color:'#CCD6E2'}};
}
function header(s,range){s.getRange(range).format={fill:blue,font:{name:'Arial',size:10,color:'#FFFFFF',bold:true},horizontalAlignment:'center',verticalAlignment:'center',rowHeight:30};}
setup(summary,'A1:F27',[36,23,27,25,22,22],'三个经销商 Customer → Stock','2026-11-04 · 当前本地网页中匹配这三个名称的全部未取消订单');
summary.getRange('A6:D10').values=[['Customer 名称组','本次订单数','其中此前148辆差异内','处理结果'],...groups.map(g=>[g,null,null,'Stock']),['合计',null,null,'Stock']];
for(let i=0;i<3;i++){
 const row=i+7;summary.getRange(`B${row}`).formulas=[[`=COUNTIF('订单明细'!B7:B200,A${row})`]];
 summary.getRange(`C${row}`).formulas=[[`=COUNTIFS('订单明细'!B7:B200,A${row},'订单明细'!J7:J200,"是")`]];
}
summary.getRange('B10:C10').formulas=[['=SUM(B7:B9)','=SUM(C7:C9)']];header(summary,'A6:D6');summary.getRange('A10:D10').format.font.bold=true;
summary.getRange('A12').values=[['明细含原 Customer、Stock 结果、Dealer、人工表 Customer 和状态，可用筛选按钮查看。']];
summary.getRange('A13').values=[['“此前148辆差异内”指人工表未完成且 Customer 为 Stock、网页原 Customer 仍为名称的订单。']];
summary.getRange('A15:C18').values=[['Finished 核对','车辆数','范围'],['旧初始化表中 Finished 总数',data.summary.oldPlanningFinishedTotal,'Planning Schedule 2025 (3) 全表'],['4,915 辆差异中旧表已 Finished',data.summary.alreadyFinishedInOldPlanning,'旧表已有、网页仍为 active'],['4,915 辆差异中后来才 Finished',data.summary.newlyFinishedSinceOldPlanning,'新表 Finished、旧表未 Finished']];header(summary,'A15:F15');
summary.getRange('A20').values=[['原因：本地测试库从 CRM 建立；后来的历史初始化只补五项流程日期，未同步完成状态。']];
summary.getRange('A21').values=[['本次处理为 Customer 归 Stock；Finished 数据列为核对结果。']];
summary.getRange('A23').values=[['来源：当前本地网页 http://127.0.0.1:5173/；最后 CRM 报表日期 2026-11-04。']];
summary.getRange('A24').values=[['人工表来源：Planning Schedule 2025 (4).xlsm / Orderlist；明细列出其行号。']];
summary.getRange('A25').values=[['Finished 历史来源：Planning Schedule 2025 (3).xlsm / Orderlist。']];
setup(detail,'A1:J200',[20,29,45,15,25,30,44,36,17,24],'订单明细 · 194 辆','按 Customer 名称匹配，保留每辆车的原值；“是”可筛选出此前提到的71辆差异。');
detail.getRange('A4').values=[['人工 Customer、生产状态及行号来源：Planning Schedule 2025 (4).xlsm / Orderlist。']];
detail.getRange('A6:J200').values=[['车架号','Customer 名称组','原网页 Customer','处理后 Customer','网页 Dealer','车型','人工表 Customer','人工表生产状态','Orderlist 行','此前148辆差异内'],...rows.map(r=>[r.chassis,r.group,r.originalCustomer,'Stock',r.dealer,r.model,r.manualCustomer,r.manualProductionStatus,r.manualRow??'',r.previousStockDifference?'是':'否'])];
detail.tables.add('A6:J200',true,'ConfirmedStockCustomers');header(detail,'A6:J6');detail.freezePanes.freezeRows(6);detail.freezePanes.freezeColumns(1);detail.getRange('I7:I200').format.horizontalAlignment='right';
const visualLength=s=>Array.from(s||'').reduce((n,c)=>n+(c.charCodeAt(0)>255?2:1),0);
rows.forEach((r,i)=>{const lines=Math.max(Math.ceil(visualLength(r.model)/28),Math.ceil(visualLength(r.manualCustomer)/41));if(lines>1){detail.getRange(`F${i+7}:G${i+7}`).format.wrapText=true;detail.getRange(`A${i+7}:J${i+7}`).format.rowHeight=lines*18+7;}});
w.recalculate();assert.equal(summary.getRange('B10').values[0][0],194);assert.equal(summary.getRange('C10').values[0][0],71);assert.deepEqual(summary.getRange('B7:C9').values,[[70,30],[56,24],[68,17]]);
console.log((await w.inspect({kind:'table',range:'汇总!A6:D10',tableMaxRows:5,tableMaxCols:4,maxChars:1300})).ndjson);
console.log((await w.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#NUM!|#N/A',options:{useRegex:true,maxResults:20},maxChars:600})).ndjson);
await (await SpreadsheetFile.exportXlsx(w)).save('三个经销商-Customer-Stock明细.xlsx');
for(const [s,range,file] of [[summary,'A1:F25','summary'],[detail,'A1:J13','details']]){const img=await w.render({sheetName:s.name,range,scale:1,format:'png'});await fs.writeFile(file+'.png',new Uint8Array(await img.arrayBuffer()));}
console.log('Saved 194 orders, including the prior 71-order subset.');
