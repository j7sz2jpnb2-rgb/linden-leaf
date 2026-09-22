"""Local single-document workbench. HTTPServer serializes C handle access."""
import sys
import argparse,json,struct,time
from pathlib import Path
from http.server import BaseHTTPRequestHandler,HTTPServer
from urllib.parse import urlparse,parse_qs
from native import Document

p=argparse.ArgumentParser();p.add_argument('pdf');p.add_argument('--library',default=str(Path(__file__).parent/'build'/('ll_mupdf.dll' if sys.platform=='win32' else 'libll_mupdf.so')));p.add_argument('--port',type=int,default=8765);p.add_argument('--password',default='');p.add_argument('--book-id',default=None);a=p.parse_args()
doc=Document(a.library,a.pdf,a.password)
# An explicit ID/path identifies the prototype's notes; no file hashing.
book_id=a.book_id or str(Path(a.pdf).resolve())
class Handler(BaseHTTPRequestHandler):
    def reply(self,data,mime='application/json',status=200):
        if not isinstance(data,bytes):data=json.dumps(data,ensure_ascii=False).encode()
        self.send_response(status);self.send_header('Content-Type',mime);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    def do_GET(self):
        url=urlparse(self.path);q=parse_qs(url.query)
        try:
            if url.path=='/':return self.reply(Path(__file__).with_name('index.html').read_bytes(),'text/html; charset=utf-8')
            if url.path=='/info':return self.reply({'pages':doc.count,'title':Path(a.pdf).name,'bookId':book_id})
            if url.path=='/stats':return self.reply(doc.stats())
            page=int(q.get('page',['0'])[0])
            if url.path=='/text':return self.reply(doc.text(page))
            if url.path=='/select':return self.reply(doc.select(page,[float(q['ax'][0]),float(q['ay'][0])],[float(q['bx'][0]),float(q['by'][0])]))
            if url.path=='/render':
                t=time.perf_counter();meta,pixels=doc.render(page,float(q.get('scale',['1'])[0]),float(q.get('rotation',['0'])[0]))
                meta['nativeMs']=round((time.perf_counter()-t)*1000,2)
                header=json.dumps(meta).encode()
                return self.reply(struct.pack('<I',len(header))+header+pixels,'application/octet-stream')
            self.reply({'error':'Not found'},status=404)
        except Exception as e:self.reply({'error':str(e)},status=400)
    def log_message(self,*args):pass
print(f'Open http://127.0.0.1:{a.port}',flush=True)
try:HTTPServer(('127.0.0.1',a.port),Handler).serve_forever()
finally:doc.close()
