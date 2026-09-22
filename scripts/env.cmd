@echo off
rem scripts/env.cmd - Configures PATH for Linden Leaf dev session
set "PATH=C:\Users\YONGHU\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd;C:\Users\YONGHU\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;C:\Users\YONGHU\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback;%PATH%"
set "PNPM_HOME=D:\LindenLeaf-Dev\.pnpm-store"
echo [env.cmd] Environment configured.
if "%1"=="" (
    git --version
    node --version
    pnpm --version
) else (
    %*
)
