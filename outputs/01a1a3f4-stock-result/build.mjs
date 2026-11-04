import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {Workbook,SpreadsheetFile} from '@oai/artifact-tool';
import {customerName} from '../../sites/orderdesk/lib/order-engine.mjs';
const root='../../sites/orderdesk/.sites-runtime/';
const result=JSON.parse(await fs.readFile(root+'merchant-stock-result.json','utf8'));
const comparison=JSON.parse(await fs.readFile(root+'comparison-current-rules-summary.json','utf8'));
const data=JSON.parse(await fs.readFile(root+'comparison-current-rules-web.json','utf8'));
const orders=new Map(data.orders.map(o=>[o.id,o]));
const w=Workbook.create(),review=w.worksheets.add('原161条处理结果'),remaining=w.worksheets.add('剩余Customer差异'),all=w.worksheets.add('全站Stock更新');
const ink='#26374D',blue='#284767';
function setup(sheet,last,widths,title,scope,source){
 sheet.showGridLines=false;sheet.tabColor=blue;
 const area=sheet.getRangeByIndexes(0,0,last,widths.length);area.format.font={name:'Arial',size:10,color:ink};area.format.rowHeight=25;area.format.verticalAlignment='center';
 widths.forEach((width,i)=>sheet.getRangeByIndexes(0,i,last,1).format.columnWidth=width);
 sheet.getRange('A2').values=[[title]];sheet.getRange('A2').format.font={name:'Arial',size:14,bold:true,color:ink};sheet.getRange('A2').format.rowHeight=30;
 sheet.getRange('A3').values=[[scope]];sheet.getRangeByIndexes(3,0,1,widths.length).format.borders={bottom:{style:'thin',color:'#CCD6E2'}};
 sheet.getRange('A5').values=[[source]];
}
const visualLength=s=>Array.from(String(s??'')).reduce((n,c)=>n+(c.charCodeAt(0)>255?2:1),0);
function table(sheet,start,headers,rows,widths,name){
 const last=start+rows.length,end=String.fromCharCode(64+headers.length);
 sheet.getRange(`A${start}:${end}${last}`).values=[headers,...rows];sheet.tables.add(`A${start}:${end}${last}`,true,name);
 sheet.getRange(`A${start}:${end}${start}`).format={fill:blue,font:{name:'Arial',size:10,bold:true,color:'#FFFFFF'},horizontalAlignment:'center',verticalAlignment:'center',rowHeight:30};
 sheet.freezePanes.freezeRows(start);sheet.freezePanes.freezeColumns(1);
 rows.forEach((row,i)=>{const lines=Math.max(...row.map((v,j)=>Math.ceil(visualLength(v)/(widths[j]-3))),1);if(lines>1){sheet.getRange(`A${start+i+1}:${end}${start+i+1}`).format.wrapText=true;sheet.getRange(`A${start+i+1}:${end}${start+i+1}`).format.rowHeight=lines*17+8;}});
}
const widths=[19,43,43,43,21,23,28,15];
setup(review,170,widths,'Customer 处理结果','C 列为更新后 Customer。商户名归 Stock，人名保留。','来源：上一版 Customer差异161辆-2026-11-04.xlsx 的 Customer差异表 C列；网页更新后核对。');
review.getRange('A6').values=[['本次全站更新 503 条订单；Dealer、交期、流程日期、生产状态保留。']];
review.getRange('A7:H7').values=[['原表订单数',null,'本次改为 Stock',null,'保留人名',null,'原已为 Stock',null]];
review.getRange('B7').formulas=[['=COUNTA(A10:A170)']];
review.getRange('D7').formulas=[['=COUNTIF(E10:E170,"本次改为 Stock")']];
review.getRange('F7').formulas=[['=COUNTIF(E10:E170,"保留人名")']];
review.getRange('H7').formulas=[['=COUNTIF(E10:E170,"原已为 Stock")']];
review.getRange('A7:H7').format.fill='#EEF3F8';review.getRange('A7:H7').format.font.bold=true;
const rank={'本次改为 Stock':0,'保留人名':1,'原已为 Stock':2};
const rows=result.rows.toSorted((a,b)=>rank[a.action]-rank[b.action]||a.chassis.localeCompare(b.chassis));
table(review,9,['车架号','人工 Customer','更新后 Customer','更新前 Customer','本次处理','网页 Dealer','车型','Orderlist 行号'],rows.map(r=>[r.displayChassis,r.manualCustomer,r.customer,r.previousCustomer,r.action,r.dealer,r.model,r.manualRow]),widths,'ReviewedCustomers');
review.getRange('C10:C170').conditionalFormats.add('cellIs',{operator:'equal',formula:'"Stock"',format:{font:{bold:true,color:'#14644D'}}});
const category=r=>customerName(r.excel)==='Stock'&&r.web==='Stock'?'人工商户名称／网页Stock':r.excel.trim().toLowerCase()==='stock'?'人工Stock／网页人名':r.web==='Stock'?'网页Stock／人工姓名备注':'双方人名写法不同';
const diff=comparison.details.customer.toSorted((a,b)=>category(a).localeCompare(category(b),'zh')||a.chassis.localeCompare(b.chassis));
const rw=[19,44,44,30,24,29,15];
setup(remaining,diff.length+8,rw,'剩余 Customer 文本差异',`当前共同在排 1,729 辆中，${diff.length} 条文本仍不同；不等于 ${diff.length} 条网页错误。`,'来源：Planning Schedule 2025 (4).xlsm / Orderlist J列；网页 http://127.0.0.1:5173/，2026-11-04。');
remaining.getRange('A6').values=[['原161条还剩99条文字差异；另1条 Destiny RV Att Brett March 本次归Stock，人工仍写商户名。']];
table(remaining,8,['车架号','人工 Customer','网页 Customer','差异类型','网页 Dealer','车型','Orderlist 行号'],diff.map(r=>{const o=orders.get(r.chassis);return [o.chassis,r.excel,r.web,category(r),o.dealer,o.model,r.row];}),rw,'RemainingCustomerDifferences');
const aw=[19,53,21,24,22,30];
setup(all,result.changes.length+8,aw,'全站 Stock 更新明细','503 条同名商户及明确商户客户已统一；包括在排和已完成订单。','来源：本地网页更新前后数据及 Customer 变更记录。已取消订单保留原归档值。');
all.getRange('A6').values=[['24 项测试通过：品牌及商户名称识别、人名保留、后续 CRM 导入、日期和生产状态规则。']];
table(all,8,['车架号','更新前 Customer','更新后 Customer','网页 Dealer','订单分类','车型'],result.changes.toSorted((a,b)=>a.before.localeCompare(b.before)||a.chassis.localeCompare(b.chassis)).map(r=>{const o=orders.get(r.chassis.replace(/-/g,''));return [r.chassis,r.before,r.after,o.dealer,o.status==='completed'?'已完成':'在排',o.model];}),aw,'AllStockUpdates');
w.recalculate();
assert.deepEqual(['B7','D7','F7','H7'].map(a=>review.getRange(a).values[0][0]),[161,67,39,55]);
assert.equal(result.changes.length,503);assert.equal(diff.length,100);
for(const row of rows.filter(r=>r.action==='保留人名'))assert.equal(row.customer,row.previousCustomer);
console.log((await w.inspect({kind:'table',range:'原161条处理结果!A7:H11',tableMaxRows:5,tableMaxCols:8,maxChars:1800})).ndjson);
console.log((await w.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#NUM!|#N/A',options:{useRegex:true,maxResults:20},maxChars:500})).ndjson);
for(const [sheet,range,file] of [[review,'A1:H14','review.png'],[remaining,'A1:G13','remaining.png'],[all,'A1:F14','updated.png']]){const blob=await w.render({sheetName:sheet.name,range,scale:1,format:'png'});await fs.writeFile(file,new Uint8Array(await blob.arrayBuffer()));}
await (await SpreadsheetFile.exportXlsx(w)).save('Customer商户归Stock-处理结果-2026-11-04.xlsx');
console.log('Saved 161 reviewed rows, 100 remaining text differences and 503 website updates.');
