import JSZip from 'jszip';
import template from './orderlist-template.json' with {type:'json'};
import {normalizeChassis} from './order-engine.mjs';
export const ORDERLIST_HEADERS=template.headers;
const esc=v=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'');
const col=n=>String.fromCharCode(64+n);
const serial=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)?(Date.parse(v+'T00:00:00Z')-Date.UTC(1899,11,30))/86400000:v;
const defined=(v,fallback)=>v===undefined||v===null||v===''?fallback:v;
export function orderlistValues(order,presentation={}){
  const a=presentation.aux||{},empty=presentation.emptyDateLabels||{};
  return [serial(defined(order.forecastDate,a.A??null)),serial(defined(order.requestDate,empty.B??null)),defined(order.shipment,a.C??null),order.productionStatus||'',defined(order.vinNumber,a.E??null),/^\d+$/.test(order.modelYear||'')?Number(order.modelYear):order.modelYear||'',order.chassis,order.model||'',order.dealer||'',order.customer||'',serial(defined(order.receivedAt,empty.K??null)),serial(defined(order.sentLongtreeAt,empty.L??null)),serial(defined(order.specAt,empty.M??'No')),serial(defined(order.signedAt,empty.N??'No')),serial(defined(order.purchaseAt,empty.O??'No')),defined(order.priceVersion,a.P??null),defined(order.index1,a.Q??null),defined(order.rank1,a.R??null),defined(order.rank2,a.S??null),serial(defined(order.estimatedSemiReceivedAt,a.T??null))];
}
function cells(values,styles,row){return values.map((v,i)=>{const attributes=`r="${col(i+1)}${row}" s="${Number(styles[i]??template.defaultStyles[i])}"`;if(v===null||v===undefined||v==='')return `<c ${attributes}/>`;if(typeof v==='number'&&Number.isFinite(v))return `<c ${attributes}><v>${v}</v></c>`;return `<c ${attributes} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;}).join('');}
function runs(numbers){const result=[];for(const n of [...new Set(numbers)].sort((a,b)=>a-b)){const previous=result.at(-1);if(previous&&previous[1]===n-1)previous[1]=n;else result.push([n,n]);}return result;}
function unionRanges(ranges){
  const columns=new Map();
  for(const range of ranges){const [,a,r1,b,r2]=range.match(/^([A-T])(\d+):([A-T])(\d+)$/);for(let c=a.charCodeAt(0);c<=b.charCodeAt(0);c++){if(!columns.has(c))columns.set(c,new Set());for(let r=Number(r1);r<=Number(r2);r++)columns.get(c).add(r);}}
  return [...columns.entries()].flatMap(([c,rows])=>runs([...rows]).map(([a,b])=>`${String.fromCharCode(c)}${a}:${String.fromCharCode(c)}${b}`)).join(' ');
}
function shiftFormula(xml,delta){
  // Only relative A1 references outside string literals move with a rule's applied range.
  return xml.replace(/<formula>([\s\S]*?)<\/formula>/g,(_,formula)=>'<formula>'+formula.split(/(&quot;[\s\S]*?&quot;|"(?:[^"]|"")*")/g).map((part,i)=>i%2?part:part.replace(/(\$?[A-Z]{1,3})(\$?)(\d+)/g,(match,column,absolute,row)=>absolute?match:column+Math.max(1,Number(row)+delta))).join('')+'</formula>');
}
function formatting(mapping){
  const pieces=[];let priority=1;
  for(const group of template.conditionalFormats){
    // Group by translated rule and column span; a source row's formatting follows its chassis.
    const buckets=new Map();
    for(const [c1,r1,c2,r2] of group.coverage){
      const matches=mapping.filter(x=>x.source>=r1&&x.source<=r2).map(x=>x.dest);
      if(!matches.length)continue;
      for(const [start,end] of runs(matches)){
        const rules=group.rules.map(rule=>shiftFormula(rule,start-r1));
        const key=rules.join('');
        if(!buckets.has(key))buckets.set(key,{rules,ranges:[]});
        buckets.get(key).ranges.push(`${col(c1)}${start}:${col(Math.min(c2,20))}${end}`);
      }
    }
    for(const {rules,ranges} of buckets.values()){
      pieces.push(`<conditionalFormatting sqref="${unionRanges(ranges)}">${rules.map(rule=>rule.replace('<cfRule ','<cfRule priority="'+priority+++'" ')).join('')}</conditionalFormatting>`);
    }
  }
  return pieces.join('');
}
export async function buildOrderlist(orders,presentations={},options={}){
  if(!Array.isArray(orders)||orders.length>30000)throw new Error('Invalid export size');
  const mapping=[{source:1,dest:1}],rows=[template.headerRow];
  orders.forEach((o,index)=>{
    const p=presentations[normalizeChassis(o.chassis)]||{};const r=index+2;
    mapping.push({source:p.sourceRow||2,dest:r});
    const values=options.referenceRows?.[index]?.values||orderlistValues(o,p);
    rows.push(`<row r="${r}" spans="1:20"${p.height?` ht="${Number(p.height)}" customHeight="1"`:''}>${cells(values,p.styles||template.defaultStyles,r)}</row>`);
  });
  const last=Math.max(1,orders.length+1);
  const worksheet=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${template.sheetPr}<dimension ref="A1:T${last}"/><sheetViews><sheetView showZeros="0" tabSelected="1" zoomScale="98" zoomScaleNormal="98" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>${template.sheetFormatPr}${template.columns}<sheetData>${rows.join('')}</sheetData><autoFilter ref="A1:T${last}"/>${formatting(mapping)}${template.pageMargins}${template.pageSetup}</worksheet>`;
  const zip=new JSZip();
  zip.file('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>');
  zip.file('_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml','<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets><sheet name="Orderlist" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>');
  zip.file('xl/_rels/workbook.xml.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>');
  zip.file('xl/styles.xml',template.styles);zip.file('xl/theme/theme1.xml',template.theme);zip.file('xl/worksheets/sheet1.xml',worksheet);
  return zip.generateAsync({type:'uint8array',compression:'DEFLATE'});
}
