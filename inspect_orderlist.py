import zipfile, xml.etree.ElementTree as E, re, json, collections, sys
sys.stdout.reconfigure(encoding='utf-8')
from pathlib import Path
P=Path(r'C:/Users/Leo.Li/Downloads/Planning Schedule 2025 (3).xlsm')
z=zipfile.ZipFile(P)
N={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
ss=[''.join(t.itertext()) for t in E.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si',N)]
def val(c):
    v=c.find('m:v',N)
    if v is None: return None
    return ss[int(v.text)] if c.get('t')=='s' else v.text
def read(i):
    root=E.fromstring(z.read(f'xl/worksheets/sheet{i}.xml'))
    cells={c.get('r'):c for c in root.findall('.//m:sheetData/m:row/m:c',N)}
    return root,cells
root,cells=read(3)
print('DIM',root.find('m:dimension',N).attrib)
cols=collections.defaultdict(list)
for a,c in cells.items():
    if val(c) is not None or c.find('m:f',N) is not None: cols[re.match('[A-Z]+',a).group()].append((a,c))
report={}
for col,items in cols.items():
    fs=[(a,c.find('m:f',N)) for a,c in items if c.find('m:f',N) is not None]
    patterns=collections.defaultdict(list)
    for a,f in fs:
        if f.text: patterns[re.sub(r'(?<=[A-Z])\$?\d+','ROW',f.text)].append((a,f.text,dict(f.attrib)))
    plain=[(a,val(c)) for a,c in items if c.find('m:f',N) is None]
    report[col]={'formulas':len(fs),'constants':len(plain),'plain_samples':plain[:5]+plain[-3:], 'patterns':[{'n':len(v),'first':v[0],'last':v[-1][0]} for v in patterns.values()]}
Path('orderlist_inspection.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print('VALIDATION', [E.tostring(x,encoding='unicode') for x in root.findall('m:dataValidations',N)])
print('CF expression samples',list(dict.fromkeys(f.text for x in root.findall('m:conditionalFormatting',N) for f in x.findall('m:cfRule/m:formula',N) if f.text and not f.text.startswith('"')))[:12])
for i,name in [(2,'uploadedScheduleBilingual'),(4,'DateTrack'),(5,'Longtree Production'),(6,'Reference'),(7,'PGI'),(8,'Dispatch Special'),(9,'Dispatch API'),(10,'Production API'),(12,'Longtree API'),(13,'Production Planning'),(14,'Calendar')]:
    r,cs=read(i)
    print('SOURCE',name,r.find('m:dimension',N).attrib)
    for row in ([1,2,3,4,5,6] if i==14 else [1,2]):
        print([(a,val(c),c.find('m:f',N).text if c.find('m:f',N) is not None else '') for a,c in cs.items() if int(re.search(r'\d+',a).group())==row][:28])
Path('orderlist_inspection.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
