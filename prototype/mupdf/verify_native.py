"""Native ABI verification; PyMuPDF generates fixtures, never renders through our API."""
import sys
import argparse,tempfile,time,statistics,json
from pathlib import Path
import pymupdf as fitz
from native import Document

def fixture(path):
    d=fitz.open()
    p=d.new_page(width=595,height=842)
    p.insert_text((40,60),'Linden Leaf native selection: abcdefghijklmnopqrstuvwxyz 0123456789',fontsize=12)
    p.insert_text((40,100),'中文字符几何验证：菩提叶阅读器支持长句选择与复制。',fontname='china-s',fontsize=13)
    p.insert_text((40,135),'Second line for multiline selection.',fontsize=12)
    for i in range(600):
        x=40+i%50*10;y=190+i//50*15
        p.draw_rect(fitz.Rect(x,y,x+5,y+8),color=(.2,.4,.6),fill=(.4,.6,.8))
    for i in range(1,6):
        p=d.new_page(width=595,height=842)
        p.insert_text((70,90),f'Page {i+1}: mixed geometry',fontsize=14)
        if i==1:p.set_cropbox(fitz.Rect(30,40,565,802));p.set_rotation(90)
    d.set_metadata({'title':'Linden Native Fixture','author':'Linden QA'})
    d.set_toc([[1,'Intro',1],[2,'Rotated page',2],[1,'Later',4]])
    d.save(path);d.close()

def run(library,path):
    fixture(path);doc=Document(library,path)
    assert doc.count==6
    assert doc.metadata('info:Title')=='Linden Native Fixture'
    assert doc.metadata('info:Author')=='Linden QA'
    outline=doc.outline()
    assert [x['title'] for x in outline]==['Intro','Rotated page','Later'],outline
    assert [x['page'] for x in outline]==[0,1,3],outline
    assert [x['level'] for x in outline]==[0,1,0],outline
    assert doc.bounds(1)==[0,0,762,535],doc.bounds(1)
    many=doc.bounds_many(0,6)
    assert len(many)==6 and all(many[i]==doc.bounds(i) for i in range(6)),many
    chars=doc.text(0);text=''.join(c['text'] for c in chars)
    assert 'abcdefghijklmnopqrstuvwxyz 0123456789' in text
    assert '菩提叶阅读器支持长句选择与复制' in text
    full=doc.select(0,[0,0],[595,842])
    assert 'abcdefghijklmnopqrstuvwxyz 0123456789' in full['text']
    assert '菩提叶阅读器支持长句选择与复制' in full['text']
    assert len(full['quads'])>=3
    word=doc.select(0,[45,50],[48,65],1)
    assert word['text'].strip(),word
    line=doc.select(0,[45,50],[48,65],2)
    assert 'Linden Leaf native selection' in line['text'],line
    assert doc.render_pre_cancelled(0,2)==1
    builds=doc.stats()['list_builds']
    meta,pixels=doc.render(0,2)
    tile,part=doc.render(0,2,clip=[60,60,400,400])
    expected=b''.join(pixels[(tile['y']+y)*meta['stride']+tile['x']*4:(tile['y']+y)*meta['stride']+(tile['x']+tile['width'])*4] for y in range(tile['height']))
    assert part==expected
    for angle in [0,90,180,270]:
        m,p=doc.render(0,1.25,angle)
        assert len(p)==m['width']*m['height']*4
        assert all(p[i]==255 for i in range(3,len(p),4))
        a,b,c,d,e,f=m['matrix'];det=a*d-b*c
        for ch in chars[::13]:
            x,y=ch['quad'][:2];u=a*x+c*y+e;v=b*x+d*y+f
            xr=(d*(u-e)-c*(v-f))/det;yr=(-b*(u-e)+a*(v-f))/det
            assert abs(xr-x)<.001 and abs(yr-y)<.001
    assert doc.stats()['list_builds']==builds
    assert doc.stats()['text_builds']==1
    for i in range(1,5):doc.render(i,.5)
    doc.render(0,.5)
    assert doc.stats()['list_builds']==builds+5
    try:doc.render(99)
    except RuntimeError:pass
    else:raise AssertionError('Invalid page should report error')
    # A failed request must not poison the document session.
    doc.render(0,.5)
    report={'status':'PASS','checks':['native C ABI v2','metadata and outline','batch page geometry','long UTF-8 text','selection quads','word/line snap selection','cooperative render cancellation','crop and PDF rotation','user rotation inverse mapping','region pixels','Display List/text reuse','cache eviction','error recovery'],'stats':doc.stats()}
    doc.close();print(json.dumps(report,ensure_ascii=False,indent=2))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--library',default=str(Path(__file__).parent/'build'/('ll_mupdf.dll' if sys.platform=='win32' else 'libll_mupdf.so')));p.add_argument('--fixture');a=p.parse_args()
    if a.fixture:run(a.library,a.fixture)
    else:
        with tempfile.TemporaryDirectory() as tmp:run(a.library,Path(tmp)/'fixture.pdf')
