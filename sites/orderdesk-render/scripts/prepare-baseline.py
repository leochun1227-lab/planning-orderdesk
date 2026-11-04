import zipfile,xml.etree.ElementTree as E,json,re,datetime,collections
from pathlib import Path
N={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
def book(path):
 z=zipfile.ZipFile(path);ss=[''.join(x.itertext()) for x in E.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si',N)]
 def cells(name):
  root=E.fromstring(z.read(name));out={}
  for row in root.findall('m:sheetData/m:row',N):
   vals={}
   for c in row:
    v=c.find('m:v',N)
    if v is not None:
     value=ss[int(v.text)] if c.get('t')=='s' else (v.text or '')
     vals[re.match('[A-Z]+',c.get('r')).group()]=value
   out[int(row.get('r'))]=vals
  return out
 return z,cells
def norm(x):return re.sub(r'[-\s]','',str(x or '')).upper()
def name(x):return re.sub(r'[^\w]+',' ',str(x or '').lower().replace('<','').replace('>','')).strip()
def date(v):
 if not v or str(v).lower() in ['no','null','waiting']:return None
 if str(v).lower()=='asap':return 'ASAP'
 try:
  n=float(v)
  if 0<=n<=366:return 'ASAP'
  if 20000<n<100000:return (datetime.datetime(1899,12,30)+datetime.timedelta(days=int(n))).date().isoformat()
 except ValueError:pass
 for f in ['%Y/%m/%d','%Y-%m-%d','%d/%m/%Y']:
  try:return datetime.datetime.strptime(v,f).date().isoformat()
  except ValueError:pass
 return None
base=Path('C:/Users/Leo.Li/Downloads')
z,read=book(base/'Planning Schedule 2025 (3).xlsm');rows=read('xl/worksheets/sheet3.xml')
orders={};duplicates=[]
for i,r in rows.items():
 if i==1 or not r.get('G'):continue
 key=norm(r['G'])
 if key in orders:duplicates.append(key);continue
 orders[key]={'id':key,'chassis':r['G'],'modelYear':r.get('F',''),'model':r.get('H',''),'dealer':r.get('I',''),'customer':r.get('J',''),'forecastDate':date(r.get('A')),'requestDate':date(r.get('B')) or r.get('B'),'receivedAt':date(r.get('K')),'sentLongtreeAt':date(r.get('L')),'specAt':date(r.get('M')),'signedAt':date(r.get('N')),'purchaseAt':date(r.get('O')),'shipment':r.get('C',''),'productionStatus':r.get('D',''),'priceVersion':r.get('P',''),'status':'completed' if r.get('D','').lower()=='finished' else 'active','createdAt':None,'updatedAt':None,'sourceRow':i}
z2,read2=book(base/'Updating the schedule (1).xlsm');dealerRows=read2('xl/worksheets/sheet4.xml')
dealers={r['A'].strip():r.get('C','') for i,r in dealerRows.items() if i>1 and r.get('A')}
dealerNames=list(set(name(r.get('B')) for i,r in dealerRows.items() if i>1 and r.get('B'))|set(name(r.get('C')) for i,r in dealerRows.items() if i>1 and r.get('C')))
excluded=[norm(r['A']) for r in read2('xl/worksheets/sheet3.xml').values() if r.get('A')]
# Preserve exclusion by the supplied Campervan Schedule cache where available.
cached=[]
if 'xl/externalLinks/externalLink2.xml' in z2.namelist():
 rt=E.fromstring(z2.read('xl/externalLinks/externalLink2.xml'))
 for c in rt.findall('.//m:cell',N):
  if re.match(r'C\d+$',c.get('r','')):
   v=c.find('m:v',N)
   if v is not None and v.text and re.match(r'^(SRV|SRM)[-\d]',v.text):cached.append(norm(v.text))
excluded=list(set(excluded+cached))
state={'orders':orders,'events':{},'imports':{},'refs':{'dealers':dealers,'dealerNames':dealerNames,'excluded':excluded},'meta':{'baselineDate':'2026-10-29','baselineSource':'Planning Schedule 2025','baselineCount':len(orders),'baselineDuplicateRows':len(duplicates),'syncMode':'manual','timezone':'Australia/Sydney','alertDays':5,'mailbox':'planning@regentv.com.au'}}
Path('.sites-runtime/baseline.json').write_text(json.dumps(state,ensure_ascii=False),encoding='utf-8')
_,reportread=book(base/'Z1D50F1707CB797BB7BD5BD.xlsx');reportrows=reportread('xl/worksheets/sheet1.xml');arr=[]
for i in range(1,max(reportrows)+1):arr.append([reportrows.get(i,{}).get(chr(c)) for c in range(65,80)])
Path('.sites-runtime/report.json').write_text(json.dumps(arr,ensure_ascii=False),encoding='utf-8')
print(json.dumps({'orders':len(orders),'duplicates':len(duplicates),'dealers':len(dealers),'exclusions':len(excluded),'campervanExclusions':len(cached),'reportRows':len(arr)}))
