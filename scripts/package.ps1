# 把 PhoNote 打成一个自带后端的便携版：dist\PhoNote-win32-x64\PhoNote.exe（外加同名 zip）。
#
# 做法就是 Electron 的「resources/app」约定：复制 electron 发行版，把我们的 JS 与
# phonote-backend.exe 放进 resources\app，Electron 会优先加载它而不是 default_app.asar。
# 不引 electron-builder：它要联网下 winCodeSign / nsis 之类的二进制，本机 github.com 不通。

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$pkg = Get-Content (Join-Path $root "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $pkg.version
$out = Join-Path $root "dist\PhoNote-win32-x64"
$electronDist = Join-Path $root "node_modules\electron\dist"
$backend = Join-Path $root "backend\bin\phonote-backend.exe"

if (-not (Test-Path $electronDist)) { throw "找不到 electron 发行版：$electronDist（先 npm install 并跑 node node_modules/electron/install.js）" }
if (-not (Test-Path $backend)) { throw "找不到后端：$backend（先按 README 里的 PyInstaller 步骤构建）" }

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force -Path $out | Out-Null
Copy-Item (Join-Path $electronDist "*") $out -Recurse -Force

# electron.exe → PhoNote.exe
$exeOld = Join-Path $out "electron.exe"
$exeNew = Join-Path $out "PhoNote.exe"
if (-not (Test-Path $exeOld)) { throw "发行版里没有 electron.exe" }
Move-Item $exeOld $exeNew -Force

$appDir = Join-Path $out "resources\app"
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $appDir "backend\bin") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $appDir "renderer") | Out-Null

Copy-Item (Join-Path $root "main.js") $appDir -Force
Copy-Item (Join-Path $root "preload.js") $appDir -Force
Copy-Item (Join-Path $root "renderer\*.js") (Join-Path $appDir "renderer") -Force
Copy-Item (Join-Path $root "renderer\*.html") (Join-Path $appDir "renderer") -Force
Copy-Item (Join-Path $root "renderer\*.css") (Join-Path $appDir "renderer") -Force
Copy-Item $backend (Join-Path $appDir "backend\bin") -Force

# 应用自己的 package.json：不能带 devDependencies，否则会被当成要装依赖
$appPkg = [ordered]@{
  name    = "phonote"
  version = $version
  private = $true
  main    = "main.js"
  description = "网课截图 → AI 笔记（自带本机后端）"
}
$appPkg | ConvertTo-Json -Depth 3 | Set-Content (Join-Path $appDir "package.json") -Encoding utf8

# default_app.asar 是 electron 的兜底 app，留着只会让人误以为加载的是它
Remove-Item (Join-Path $out "resources\default_app.asar") -Force -ErrorAction SilentlyContinue

$zip = Join-Path $root "dist\PhoNote-$version-win32-x64.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $out "*") -DestinationPath $zip -CompressionLevel Optimal

$exeBytes = (Get-Item $exeNew).Length
$totalMB = [math]::Round(((Get-ChildItem $out -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
$zipMB = [math]::Round(((Get-Item $zip).Length / 1MB), 1)
"ok: $exeNew"
"launcher-bytes: $exeBytes"
"app-dir: $totalMB MB"
"zip: $zip ($zipMB MB)"
