import zipfile, xml.etree.ElementTree as E, re, json, sys, struct, math
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8')
p=Path(r'C:/Users/Leo.Li/Downloads/Updating the schedule (1).xlsm')
z=zipfile.ZipFile(p)
N={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
ss=[''.join(x.itertext()) for x in E.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si',N)] if 'xl/sharedStrings.xml' in z.namelist() else []
def value(c):
    v=c.find('m:v',N)
    return (ss[int(v.text)] if c.get('t')=='s' else v.text) if v is not None else None
rels={x.get('Id'):x.get('Target') for x in E.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
for s in E.fromstring(z.read('xl/workbook.xml')).findall('m:sheets/m:sheet',N):
    target=rels[s.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')]
    r=E.fromstring(z.read('xl/'+target))
    prop=r.find('m:sheetPr',N)
    print('SHEET',s.attrib,'CODENAME',None if prop is None else prop.attrib,'DIM',r.find('m:dimension',N).attrib)
    cs=r.findall('.//m:sheetData/m:row/m:c',N)
    print('TOP',[(c.get('r'),value(c),c.find('m:f',N).text if c.find('m:f',N) is not None else None) for c in cs if int(re.search(r'\d+',c.get('r')).group())<5 and value(c) is not None][:65])
for n in z.namelist():
    if ('drawings/' in n or 'ctrlProps/' in n) and n.endswith(('.xml','.vml')):
        t=z.read(n).decode('utf-8',errors='replace')
        if re.search('creating|updating|macro|FmlaMacro',t,re.I): print('CONTROL',n,t[:14000])

# Read Compound File Binary streams without loading or executing VBA.
b=z.read('xl/vbaProject.bin'); secsize=1<<struct.unpack_from('<H',b,30)[0]; minisize=1<<struct.unpack_from('<H',b,32)[0]
def sector(i): return b[(i+1)*secsize:(i+2)*secsize]
dif=list(struct.unpack_from('<109I',b,76)); nxt=struct.unpack_from('<I',b,68)[0]
for _ in range(struct.unpack_from('<I',b,72)[0]):
    ar=struct.unpack('<'+'I'*(secsize//4),sector(nxt)); dif.extend(ar[:-1]); nxt=ar[-1]
fat=[]
for i in dif:
    if i<0xFFFFFFFA: fat.extend(struct.unpack('<'+'I'*(secsize//4),sector(i)))
def chain(start,table):
    seen=set()
    while start<0xFFFFFFFA and start<len(table) and start not in seen:
        seen.add(start); yield start; start=table[start]
def stream(start,size): return b''.join(sector(i) for i in chain(start,fat))[:size]
directory=stream(struct.unpack_from('<I',b,48)[0],len(b))
entries=[]
for off in range(0,len(directory),128):
    d=directory[off:off+128]; nl=struct.unpack_from('<H',d,64)[0]
    if nl>=2: entries.append((d[:nl-2].decode('utf-16le'),d[66],struct.unpack_from('<I',d,116)[0],struct.unpack_from('<Q',d,120)[0]))
root=next(x for x in entries if x[1]==5); mini=stream(root[2],root[3]); mf=stream(struct.unpack_from('<I',b,60)[0],struct.unpack_from('<I',b,64)[0]*secsize); minifat=list(struct.unpack('<'+'I'*(len(mf)//4),mf))
def getstream(e):
    return stream(e[2],e[3]) if e[3]>=4096 else b''.join(mini[i*minisize:(i+1)*minisize] for i in chain(e[2],minifat))[:e[3]]
def decompress(data):
    if not data or data[0]!=1: raise ValueError()
    pos=1; out=bytearray()
    while pos+2<=len(data):
        h=struct.unpack_from('<H',data,pos)[0]; size=(h&4095)+3; end=min(pos+size,len(data)); pos+=2
        if (h>>12)&7 !=3: raise ValueError()
        base=len(out)
        if not h&0x8000: out.extend(data[pos:end]); pos=end; continue
        while pos<end:
            flag=data[pos]; pos+=1
            for bit in range(8):
                if pos>=end: break
                if flag&(1<<bit):
                    tok=struct.unpack_from('<H',data,pos)[0];pos+=2
                    bits=max(4,(len(out)-base-1).bit_length()); mask=0xFFFF>>bits
                    length=(tok&mask)+3; offset=(tok>>(16-bits))+1
                    if offset>len(out)-base: raise ValueError()
                    for _ in range(length): out.append(out[-offset])
                else: out.append(data[pos]);pos+=1
                if len(out)-base>4096: raise ValueError()
    return bytes(out)
outdir=Path('updating_analysis');outdir.mkdir(exist_ok=True)
for e in entries:
    if e[1]!=2 or e[0].startswith('__') or e[0] in ['dir','PROJECT','PROJECTwm','_VBA_PROJECT']: continue
    raw=getstream(e)
    for i in range(len(raw)-3):
        if raw[i]!=1: continue
        try:
            dec=decompress(raw[i:])
            if not dec.startswith(b'Attribute VB_Name'):continue
            txt=dec.decode('utf-8',errors='replace') if b'\xef\xbb\xbf' in dec[:3] else dec.decode('cp1252',errors='replace')
            (outdir/(e[0]+'.bas')).write_text(txt,encoding='utf-8')
            print('VBA_MODULE',e[0],'bytes',len(dec),'procedures',re.findall(r'(?:Sub|Function)\s+(\w+)',txt))
            break
        except (ValueError,IndexError,struct.error):pass
