"""ctypes transport for ll_mupdf ABI v2; all engine work runs in C."""
import ctypes as C
import json
from pathlib import Path

class Quad(C.Structure):
    _fields_ = [('xy', C.c_float * 8)]
class Char(C.Structure):
    _fields_ = [('codepoint', C.c_int), ('line', C.c_int), ('size', C.c_float), ('quad', Quad)]
class Text(C.Structure):
    _fields_ = [('chars', C.POINTER(Char)), ('count', C.c_int)]
class Selection(C.Structure):
    _fields_ = [('text', C.c_void_p), ('quads', C.POINTER(Quad)), ('count', C.c_int),
                ('a', C.c_float * 2), ('b', C.c_float * 2)]
class Image(C.Structure):
    _fields_ = [('samples', C.c_void_p), ('length', C.c_size_t),
                ('width', C.c_int), ('height', C.c_int), ('stride', C.c_int),
                ('x', C.c_int), ('y', C.c_int), ('matrix', C.c_float * 6)]
class Stats(C.Structure):
    _fields_ = [('list_builds', C.c_uint64), ('list_hits', C.c_uint64), ('text_builds', C.c_uint64)]
class OutlineItem(C.Structure):
    _fields_ = [('title', C.c_void_p), ('page', C.c_int), ('level', C.c_int)]
class Outline(C.Structure):
    _fields_ = [('items', C.POINTER(OutlineItem)), ('count', C.c_int)]

class Document:
    def __init__(self, library, path, password=''):
        self.lib = C.CDLL(str(Path(library).resolve()))
        signatures = {
            'll_open': ([C.c_char_p,C.c_char_p,C.c_void_p,C.c_size_t],C.c_void_p),
            'll_close': ([C.c_void_p],None),
            'll_page_count': ([C.c_void_p],C.c_int),
            'll_error': ([C.c_void_p],C.c_char_p),
            'll_metadata': ([C.c_void_p,C.c_char_p],C.c_void_p),
            'll_free_string': ([C.c_void_p],None),
            'll_get_outline': ([C.c_void_p,C.POINTER(Outline)],C.c_int),
            'll_free_outline': ([C.POINTER(Outline)],None),
            'll_page_bounds': ([C.c_void_p,C.c_int,C.POINTER(C.c_float)],C.c_int),
            'll_page_bounds_many': ([C.c_void_p,C.c_int,C.c_int,C.POINTER(C.c_float)],C.c_int),
            'll_cancel_new': ([],C.c_void_p),
            'll_cancel_abort': ([C.c_void_p],None),
            'll_cancel_free': ([C.c_void_p],None),
            'll_render': ([C.c_void_p,C.c_int,C.c_float,C.c_float,C.POINTER(C.c_float),C.c_void_p,C.POINTER(Image)],C.c_int),
            'll_free_image': ([C.POINTER(Image)],None),
            'll_get_text': ([C.c_void_p,C.c_int,C.POINTER(Text)],C.c_int),
            'll_free_text': ([C.POINTER(Text)],None),
            'll_select': ([C.c_void_p,C.c_int,*([C.c_float]*4),C.POINTER(Selection)],C.c_int),
            'll_select_mode': ([C.c_void_p,C.c_int,*([C.c_float]*4),C.c_int,C.POINTER(Selection)],C.c_int),
            'll_free_selection': ([C.POINTER(Selection)],None),
            'll_get_stats': ([C.c_void_p],Stats),
        }
        for name,(args,ret) in signatures.items():
            fn=getattr(self.lib,name);fn.argtypes=args;fn.restype=ret
        error=C.create_string_buffer(512)
        self.handle=self.lib.ll_open(str(Path(path).resolve()).encode(),password.encode(),error,len(error))
        if not self.handle: raise RuntimeError(error.value.decode())
        self.count=self.lib.ll_page_count(self.handle)
    def check(self,status):
        if status: raise RuntimeError(self.lib.ll_error(self.handle).decode())
    def metadata(self,key):
        ptr=self.lib.ll_metadata(self.handle,key.encode())
        if not ptr:return None
        try:return C.string_at(ptr).decode()
        finally:self.lib.ll_free_string(ptr)
    def outline(self):
        out=Outline();self.check(self.lib.ll_get_outline(self.handle,C.byref(out)))
        try:
            return [{'title':C.string_at(i.title).decode() if i.title else '', 'page':i.page, 'level':i.level}
                    for i in out.items[:out.count]]
        finally:self.lib.ll_free_outline(C.byref(out))
    def bounds(self,page):
        value=(C.c_float*4)();self.check(self.lib.ll_page_bounds(self.handle,page,value));return list(value)
    def bounds_many(self,start,count):
        value=(C.c_float*(max(count,1)*4))();written=self.lib.ll_page_bounds_many(self.handle,start,count,value)
        if written < 0: raise RuntimeError(self.lib.ll_error(self.handle).decode())
        return [list(value[i*4:(i+1)*4]) for i in range(written)]
    def render_pre_cancelled(self,page,scale=1):
        token=self.lib.ll_cancel_new()
        if not token: raise MemoryError('cancel token allocation failed')
        image=Image()
        try:
            self.lib.ll_cancel_abort(token)
            status=self.lib.ll_render(self.handle,page,scale,0,None,token,C.byref(image))
            return status
        finally:
            self.lib.ll_free_image(C.byref(image))
            self.lib.ll_cancel_free(token)
    def render(self,page,scale=1,rotation=0,clip=None):
        image=Image();region=(C.c_float*4)(*clip) if clip else None
        self.check(self.lib.ll_render(self.handle,page,scale,rotation,region,None,C.byref(image)))
        try:
            meta={key:getattr(image,key) for key in ['width','height','stride','x','y']}
            meta['matrix']=list(image.matrix)
            return meta,C.string_at(image.samples,image.length)
        finally: self.lib.ll_free_image(C.byref(image))
    def text(self,page):
        out=Text();self.check(self.lib.ll_get_text(self.handle,page,C.byref(out)))
        try:
            return [{'text':chr(c.codepoint),'line':c.line,'quad':list(c.quad.xy),'size':c.size}
                    for c in out.chars[:out.count]]
        finally:self.lib.ll_free_text(C.byref(out))
    def select(self,page,a,b,mode=0):
        out=Selection();self.check(self.lib.ll_select_mode(self.handle,page,*a,*b,mode,C.byref(out)))
        try:return {'text':C.string_at(out.text).decode(),'quads':[list(q.xy) for q in out.quads[:out.count]],
                    'a':list(out.a),'b':list(out.b)}
        finally:self.lib.ll_free_selection(C.byref(out))
    def stats(self):
        s=self.lib.ll_get_stats(self.handle)
        return {key:getattr(s,key) for key,_ in Stats._fields_}
    def close(self):
        if self.handle:self.lib.ll_close(self.handle);self.handle=None
