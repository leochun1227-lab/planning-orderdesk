import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {Workbook,SpreadsheetFile} from '@oai/artifact-tool';
const root='../../sites/orderdesk/.sites-runtime/';
const data=JSON.parse(await fs.readFile(root+'comparison-current-rules-summary.json','utf8'));
const snapshot=JSON.parse(await fs.readFile(root+'comparison-current-rules-web.json','utf8'));
const orders=new Map(snapshot.orders.map(o=>[o.id,o]));
const names=['人工 Stock／网页名称','网页 Stock／人工姓名或备注','双方名称不同'];
const clean=value=>String(value??'').trim().toLowerCase();
const group=r=>clean(r.excel)==='stock'?0:clean(r.web)==='stock'?1:2;
const customers=data.details.customer.toSorted((a,b)=>group(a)-group(b)||a.chassis.localeCompare(b.chassis));
const w=Workbook.create();const c=w.worksheets.add('Customer差异'),d=w.worksheets.add('Dealer差异');
const ink='#26374D',blue='#284767';
function setup(sheet,last,widths,title,scope){
 sheet.showGridLines=false;
 const area=sheet.getRange(`A1:${String.fromCharCode(64+widths.length)}${last}`);
 area.format.font={name:'Arial',size:10,color:ink};area.format.rowHeight=25;area.format.verticalAlignment='center';
 widths.forEach((width,i)=>sheet.getRangeByIndexes(0,i,last,1).format.columnWidth=width);
 sheet.getRange('A2').values=[[title]];sheet.getRange('A2').format.font={name:'Arial',size:14,bold:true,color:ink};sheet.getRange('A2').format.rowHeight=30;
 sheet.getRange('A3').values=[[scope]];sheet.getRange(`A4:${String.fromCharCode(64+widths.length)}4`).format.borders={bottom:{style:'thin',color:'#CCD6E2'}};
 sheet.tabColor=blue;
}
function header(sheet,range){sheet.getRange(range).format={fill:blue,font:{name:'Arial',size:10,bold:true,color:'#FFFFFF'},horizontalAlignment:'center',verticalAlignment:'center',rowHeight:30};}
setup(c,170,[19,43,43,32,23,30,15,28],'Customer 不一致明细','共同在排订单 1,729 辆；仅列出 Customer 文本不一致的 161 辆。');
c.getRange('A5').values=[['来源：Planning Schedule 2025 (4).xlsm · Orderlist J列；网页 http://127.0.0.1:5173/ · 2026-11-04 核对。']];
c.getRange('A6').values=[['范围：按车架号匹配，忽略大小写及多余空格；名称不一致不代表网页一定错误。']];
c.getRange('A7:H7').values=[['Customer 差异',null,names[0],null,names[1],null,names[2],null]];
c.getRange('B7').formulas=[['=COUNTA(A10:A170)']];
c.getRange('D7').formulas=[['=COUNTIF(D10:D170,C7)']];
c.getRange('F7').formulas=[['=COUNTIF(D10:D170,E7)']];
c.getRange('H7').formulas=[['=COUNTIF(D10:D170,G7)']];
c.getRange('A7:H7').format.fill='#EEF3F8';c.getRange('A7:H7').format.font.bold=true;c.getRange('A7:H7').format.wrapText=true;c.getRange('A7:H7').format.rowHeight=38;
const matrix=[['车架号','人工 Customer','网页 Customer','差异类型','网页 Dealer','车型','Orderlist 行号','核对结果（可填写）'],...customers.map(r=>{const o=orders.get(r.chassis);return [o.chassis,r.excel,r.web,names[group(r)],o.dealer,o.model,r.row,''];})];
c.getRange('A9:H170').values=matrix;c.tables.add('A9:H170',true,'CustomerDifferences');header(c,'A9:H9');
c.getRange('H10:H170').format.fill='#FFF8DC';c.freezePanes.freezeRows(9);c.freezePanes.freezeColumns(1);
c.getRange('G10:G170').setNumberFormat('0');c.getRange('G10:G170').format.horizontalAlignment='right';
const length=s=>Array.from(s||'').reduce((n,ch)=>n+(ch.charCodeAt(0)>255?2:1),0);
for(let i=1;i<matrix.length;i++){
 const row=matrix[i],lines=Math.max(1,Math.ceil(length(row[1])/40),Math.ceil(length(row[2])/40),Math.ceil(length(row[5])/27));
 if(lines>1){c.getRange(`B${i+9}:F${i+9}`).format.wrapText=true;c.getRange(`A${i+9}:H${i+9}`).format.rowHeight=lines*17+8;}
}
setup(d,22,[19,25,25,25,14,34],'Dealer 不一致明细','13 辆。按已确认规则保留网页 Dealer，Customer 更新不改 Dealer。');
d.getRange('A5').values=[['来源：同一人工表 Orderlist I列；网页与 Customer 差异表使用同一次数据快照。']];
d.getRange('A6').values=[['3 条人工交期已补入网页；本表只列仍保留的 Dealer 文本差异。']];
d.getRange('A8:F21').values=[['车架号','人工 Dealer','网页 Dealer','车型','Orderlist 行号','处理说明'],...data.details.dealer.map(r=>{const o=orders.get(r.chassis);return [o.chassis,r.excel,r.web,o.model,r.row,'保留原 Dealer，供查看'];})];
d.tables.add('A8:F21',true,'DealerDifferences');header(d,'A8:F8');d.freezePanes.freezeRows(8);d.freezePanes.freezeColumns(1);
w.recalculate();
assert.equal(c.getRange('B7').values[0][0],161);assert.equal(c.getRange('D7').values[0][0],77);assert.equal(c.getRange('F7').values[0][0],55);assert.equal(c.getRange('H7').values[0][0],29);
assert.equal(new Set(customers.map(r=>r.chassis)).size,161);assert.equal(data.summary.requestDateDifferences.length,0);
console.log((await w.inspect({kind:'table',range:'Customer差异!A7:H11',tableMaxRows:5,tableMaxCols:8,maxChars:1600})).ndjson);
console.log((await w.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#NUM!|#N/A',options:{useRegex:true,maxResults:20},maxChars:600})).ndjson);
for(const [sheet,range,file] of [[c,'A1:H14','customer-preview.png'],[d,'A1:F21','dealer-preview.png']]){
 const blob=await w.render({sheetName:sheet.name,range,scale:1,format:'png'});await fs.writeFile(file,new Uint8Array(await blob.arrayBuffer()));
}
await (await SpreadsheetFile.exportXlsx(w)).save('Customer差异161辆-2026-11-04.xlsx');
console.log('Exported 161 Customer differences and 13 Dealer differences; category counts 77 / 55 / 29.');
