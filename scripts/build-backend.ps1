param(
  [string]$Python = "D:\DSh\driver-platform-v2\.venv\Scripts\python.exe",
  [string]$Platform = "D:\DSh\driver-platform-v2",
  [string]$OutDir = "D:\DSh\PhoNote\backend\bin"
)

# 把平台侧的 pho_note 插件（含手机版页面）打成单文件 sidecar。
# 为什么构建目录放在 $Platform\.tmp 里：本机 DSH 会话限制「Python 子进程只能写工作区」，
# 直接在 PhoNote 仓库里建 dist/ 会报 PermissionError，所以先构建到平台工作区，再复制过去。
$ErrorActionPreference = "Stop"
$work = Join-Path $Platform ".tmp\pyi-backend"
$dist = Join-Path $Platform ".tmp\pyi-dist"

if (Test-Path $work) { Remove-Item -Recurse -Force $work }
if (Test-Path $dist) { Remove-Item -Recurse -Force $dist }

Push-Location $Platform
try {
  & $Python -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --name phonote-backend `
    --paths "$Platform\src" `
    --hidden-import uvicorn.logging `
    --hidden-import uvicorn.loops.auto `
    --hidden-import uvicorn.loops.asyncio `
    --hidden-import uvicorn.protocols.http.auto `
    --hidden-import uvicorn.protocols.http.h11_impl `
    --hidden-import uvicorn.protocols.websockets.auto `
    --hidden-import uvicorn.lifespan.on `
    --hidden-import uvicorn.lifespan.off `
    --hidden-import PIL `
    --hidden-import PIL.Image `
    --hidden-import prometheus_client `
    --collect-submodules driver_platform `
    --distpath $dist `
    --workpath $work `
    --specpath $work `
    "$Platform\..\PhoNote\backend\sidecar.py" 2>&1 | Select-Object -Last 5
  if ($LASTEXITCODE -ne 0) { throw "PyInstaller 失败：$LASTEXITCODE" }
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Force $OutDir | Out-Null
Copy-Item (Join-Path $dist "phonote-backend.exe") (Join-Path $OutDir "phonote-backend.exe") -Force
$info = Get-Item (Join-Path $OutDir "phonote-backend.exe")
"backend exe: $($info.Length) bytes -> $($info.FullName)"
