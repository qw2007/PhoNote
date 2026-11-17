param(
  [string]$Python = "",
  [string]$Platform = "",
  [string]$OutDir = ""
)

# 把平台侧的 pho_note 插件（含手机版页面）打成单文件 sidecar。
# 用法：先设 PHONOTE_PLATFORM 指向「驱动平台」仓库根（含 src/ 与 .venv/），再执行本脚本。
# 也可以用 -Platform / -Python / -OutDir 显式覆盖；默认值不写死任何人的机器路径。
$ErrorActionPreference = "Stop"
if (-not $Platform) {
  $Platform = $env:PHONOTE_PLATFORM
}
if (-not $Platform) {
  throw "请设置 PHONOTE_PLATFORM 指向驱动平台仓库根目录（或用 -Platform 指定）。"
}
$Platform = (Resolve-Path $Platform).Path
if (-not $Python) {
  $Python = Join-Path $Platform ".venv\Scripts\python.exe"
}
if (-not (Test-Path $Python)) {
  throw "找不到 Python：$Python（用 -Python 指定，或在平台仓库里先建 .venv）"
}
if (-not (Test-Path (Join-Path $Platform "src\driver_platform"))) {
  throw "在 $Platform 下没看到 src\driver_platform，这个目录不像驱动平台仓库。"
}
if (-not $OutDir) {
  $OutDir = Join-Path (Split-Path $PSScriptRoot -Parent) "backend\bin"
}

# 构建目录放在 $Platform\.tmp 里：PyInstaller 会大量写临时文件，
# 放在平台工作区可以避免目标仓库的权限/忽略规则问题，构建完再复制到 $OutDir。
$work = Join-Path $Platform ".tmp\pyi-backend"
$dist = Join-Path $Platform ".tmp\pyi-dist"
$Sidecar = Join-Path (Split-Path $PSScriptRoot -Parent) "backend\sidecar.py"
if (-not (Test-Path $Sidecar)) {
  throw "找不到 sidecar：$Sidecar"
}

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
    "$Sidecar" 2>&1 | Select-Object -Last 5
  if ($LASTEXITCODE -ne 0) { throw "PyInstaller 失败：$LASTEXITCODE" }
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Force $OutDir | Out-Null
Copy-Item (Join-Path $dist "phonote-backend.exe") (Join-Path $OutDir "phonote-backend.exe") -Force
$info = Get-Item (Join-Path $OutDir "phonote-backend.exe")
"backend exe: $($info.Length) bytes -> $($info.FullName)"
