@echo off
rem scripts/env.cmd - Configures PATH and Toolchains for Linden Leaf dev session
set "PATH=D:\LindenLeaf-Toolchains\cargo\bin;C:\Users\YONGHU\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd;C:\Users\YONGHU\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;C:\Users\YONGHU\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback;D:\LindenLeaf-Toolchains\MSVC\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64;C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64;D:\LindenLeaf-Toolchains\MSVC\MSBuild\Current\Bin;%PATH%"
set "INCLUDE=D:\LindenLeaf-Toolchains\MSVC\VC\Tools\MSVC\14.44.35207\include;C:\Program Files (x86)\Windows Kits\10\Include\10.0.22621.0\ucrt;C:\Program Files (x86)\Windows Kits\10\Include\10.0.22621.0\shared;C:\Program Files (x86)\Windows Kits\10\Include\10.0.22621.0\um;C:\Program Files (x86)\Windows Kits\10\Include\10.0.22621.0\winrt;C:\Program Files (x86)\Windows Kits\10\Include\10.0.22621.0\cppwinrt"
set "LIB=D:\LindenLeaf-Toolchains\MSVC\VC\Tools\MSVC\14.44.35207\lib\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.22621.0\ucrt\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.22621.0\um\x64"
set "LIBPATH=D:\LindenLeaf-Toolchains\MSVC\VC\Tools\MSVC\14.44.35207\lib\x64"

set "PNPM_HOME=D:\LindenLeaf-Dev\.pnpm-store"
set "RUSTUP_HOME=D:\LindenLeaf-Toolchains\rustup"
set "CARGO_HOME=D:\LindenLeaf-Toolchains\cargo"
set "CARGO_TARGET_DIR=D:\LindenLeaf-Build\target"
set "LINDEN_NATIVE_CACHE_DIR=D:\LindenLeaf-Data\development\pdf-native"

set "LL_MUPDF_INCLUDE=D:\LindenLeaf-Dev\mupdf-1.25.4-source\include"
set "LL_MUPDF_LIB_DIR=D:\LindenLeaf-Dev\mupdf-1.25.4-source\platform\win32\x64\Release"
set "LL_MUPDF_LIBS=libmupdf;libthirdparty;libresources"
set "LL_REQUIRE_NATIVE_MUPDF=1"

echo [env.cmd] Environment configured with native MuPDF and MSVC.
if "%1"=="" (
    git --version
    node --version
    pnpm --version
    cargo --version
) else (
    %*
)

