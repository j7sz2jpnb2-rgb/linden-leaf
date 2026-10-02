"""Native prototype build. Supply --include/--library or use a PyMuPDF wheel."""
import argparse,os,subprocess,sys
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--include');p.add_argument('--library');p.add_argument('--output');p.add_argument('--extra-library',action='append',default=[]);a=p.parse_args()
root=Path(__file__).resolve().parents[2]
if not a.include or not a.library:
    import pymupdf
    package=Path(pymupdf.__file__).parent
    a.include=a.include or str(package/'mupdf-devel/include')
    candidates=list(package.glob('libmupdf.so.*'))+list(package.glob('libmupdf.dylib'))
    if not candidates:raise SystemExit('Provide --include and --library for an installed MuPDF build.')
    a.library=a.library or str(candidates[0])
name='ll_mupdf.dll' if sys.platform=='win32' else 'libll_mupdf.so'
output=Path(a.output or Path(__file__).parent/'build'/name).resolve();output.parent.mkdir(parents=True,exist_ok=True)
source=str(root/'src-tauri/native/ll_mupdf.c')
if sys.platform=='win32':
    # Run from an x64 VS developer prompt; match the library's runtime and architecture.
    command=[os.environ.get('CC','cl'),'/nologo','/std:c11','/O2','/MD','/LD',
             '/I'+a.include,source,'/Fo'+str(output.with_suffix('.obj')),
             '/link','/OUT:'+str(output),a.library,*a.extra_library]
else:
    command=[os.environ.get('CC','cc'),'-std=c11','-O2','-Wall','-Wextra','-Werror','-fPIC','-shared',
             '-I',a.include,source,a.library,*a.extra_library,
             '-Wl,-rpath,'+str(Path(a.library).resolve().parent),'-o',str(output)]
subprocess.run(command,check=True)
print(output)
