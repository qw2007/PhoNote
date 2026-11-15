# PhoNote

网课截图 → AI 笔记的桌面应用。**打包版自带本机后端**（`phonote-backend.exe`），
装完不需要 Python、也不需要另外起驱动平台；开发模式下才连你手动起的平台。

网课截图 -> 图片缓冲区 -> 任意多图组成笔记 -> AI 总结与讨论修订 -> 批注 -> 备份与多设备同步。

- 形态：桌面应用（Electron 壳）+ 平台侧领域插件（Python，驱动平台插件契约）
- 设计说明：[docs/design/PhoNote.md](docs/design/PhoNote.md)
- 状态：**P0 / P1 / P2 / P3 已实现**（P3 = 备份 zip + WebDAV 同步，见设计文档第 7、12 节）

## P3 包含什么

| 部分 | 位置 | 内容 |
|---|---|---|
| 平台插件 | 驱动平台仓库 `src/driver_platform/plugins/pho_note/` | 存储层（SQLite 树 + 内容寻址图片 + 批注 + 版本 + 消息）+ 26 个工具 |
| AI 层 | 同上 `ai.py` | OpenAI 兼容 / Anthropic / manual 三种模式；模型只回 `summary + edits` |
| 同步层 | 同上 `sync.py` | 备份 zip + WebDAV push/pull（manifest 最后写、只传远端缺的媒体、单主设备） |
| REST 层 | 同上 `api.py` | `/notes/api/*` 二十四条端点（含 AI 与同步），`DRIVER_NOTES_UI=1` 才挂载 |
| 桌面壳 | 本仓库 `main.js` / `preload.js` / `renderer/` | 四分区界面、全局热键截图、树增删改移、批注、版本回滚、AI 讨论与补丁确认、只读模式 |

查看界面的四个分区：**图片区**（缓冲区）、**讨论区**（与 AI 的往来消息 + 补丁预览）、
**现有笔记区**（正文编辑）、**批注区**（整篇 / 选中文字 / 图片区域三种锚点）。
左侧另有一列文件树用于导航。

二十六个工具：树 `note_tree`、`note_node_create`、`note_node_rename`、`note_node_move`、
`note_node_delete`；截图 `note_add_capture`、`note_list_captures`；笔记 `note_compose`、
`note_get`、`note_list`、`note_update`、`note_set_images`；批注 `note_annotate`、
`note_annotate_delete`；版本 `note_revisions`、`note_rollback`；导出 `note_export`；
AI `note_summarize`、`note_chat`、`note_messages`、`note_apply_patch`、`note_ingest_ai_reply`；
备份与同步 `note_backup`、`note_sync_push`、`note_sync_pull`、`note_sync_status`。

## 跑起来

### 1. 平台侧

```powershell
# 在驱动平台仓库根目录
$env:DRIVER_PLUGINS = "pho_note"
$env:DRIVER_NOTES_DIR = "$env:USERPROFILE\PhoNote"   # 可省略，默认就是这个
$env:DRIVER_NOTES_UI = "1"                            # 挂载 /notes/api/*
$env:DRIVER_NOTES_LLM = "manual"                      # off（默认）| openai | anthropic | manual
.\.venv\Scripts\python.exe -m uvicorn driver_platform.main:app --host 127.0.0.1 --port 8000
```

验证：

```powershell
curl.exe -s http://127.0.0.1:8000/v1/tools | ConvertFrom-Json | ForEach-Object { $_.name }
curl.exe -s http://127.0.0.1:8000/notes/api/tree
```

### 2. 桌面壳

```powershell
# 1) 装依赖。Electron 的二进制从 GitHub Releases 拉，直连不通时用镜像：
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
npm install --no-audit --no-fund

# 2) npm 11 默认拦住依赖的 postinstall 脚本，Electron 二进制不会自己下载，补一步：
node node_modules/electron/install.js      # 生成 node_modules/electron/dist/electron.exe

# 3) 启动
npm start
```

首次启动后点「设置」填配置（落在 `%APPDATA%\PhoNote\settings.json`）：

```json
{
  "apiBase": "http://127.0.0.1:8000",
  "apiKey": "",
  "notesDir": "C:\\Users\\<你>\\PhoNote",
  "readonly": false
}
```

- `apiKey`：平台开了 `DRIVER_AUTH_MODE=required` 时，壳走 REST，需要一把带
  `notes_read`（读）与 `notes_write`（写）作用域的钥匙，例如
  `DRIVER_API_KEYS="rw:notes_read|notes_write"`；需要给第二台设备/投屏时再建一把
  `"ro:notes_read"` 并把壳切到只读。
- `notesDir`：必须与平台的 `DRIVER_NOTES_DIR` 一致——图片按 sha256 从磁盘直读。
- `readonly`：只读模式，隐藏全部写入口、禁用截图热键（配合只读钥匙使用）。
- `useTemplate`：新建笔记是否套用平台内置骨架 `lecture`（`## 定义 / ## 定理 · 结论 / ## 易错点 / ## 例题`），默认 `true`；设置里对应「新建笔记套用骨架」。
- 给 Agent 用的话另建一把更窄的钥匙：`pho-agent:note_tree|note_get|note_list_captures`（只读工具白名单），别把 `notes_write` 给它。

### 3. 用法

1. 开着网课，按 `Ctrl+Shift+S`（或点「截图入缓冲区」）→ 图片进**图片区**；
2. 在图片区点要用的图（可多选）→ 填标题 → 「组成笔记」→ 新笔记出现在左侧树里；工具栏「新建笔记」会按设置套上骨架（定义/定理/易错点/例题），不想要就取消勾选；
3. 点树里的笔记 → 右侧**现有笔记区**显示图与正文，改完点「保存笔记」（存旧版本）；
4. 右侧**讨论区**：填一句话点「让 AI 总结」，或直接「发送」追问；模型会回摘要 + 若干条
   `find → replace` 补丁，逐条看过再点「套用补丁」（没匹配上的会进 `skipped`）；
   manual 模式不联网：上下文自动进剪贴板，粘给网页版模型，回复用 `note_ingest_ai_reply` 贴回；
5. 右侧**批注区**写批注（可选整篇/选中文字/图片区域、颜色）；
6. 「导出 Markdown」把当前笔记的 Markdown 复制到剪贴板（图片是绝对路径）。

### 4. 备份与同步（命令行）

壳里暂时没有备份按钮，先用工具的 HTTP 入口（都要带含 `note_*` 作用域的钥匙）：

```powershell
# 打一个自包含的 zip 到 DRIVER_NOTES_DIR\backups\
curl.exe -s -X POST http://127.0.0.1:8000/v1/tools/execute -H "X-API-Key: $KEY" `
  -d '{"tool":"note_backup","arguments":{}}'

# 推到 WebDAV（平台侧先设 DRIVER_NOTES_WEBDAV_URL，可选 _USER/_PASSWORD/_KEEP）
curl.exe -s -X POST http://127.0.0.1:8000/v1/tools/execute -H "X-API-Key: $KEY" `
  -d '{"tool":"note_sync_push","arguments":{}}'

# 另一台设备：先看 status 的 dirty；本地有未推送改动时 pull 会被拒绝
curl.exe -s http://127.0.0.1:8000/notes/api/sync/status -H "X-API-Key: $KEY"
curl.exe -s -X POST http://127.0.0.1:8000/notes/api/sync/pull -H "X-API-Key: $KEY"
```

远端布局：`phonote/manifest.json`（提交点，最后写）、`phonote/db/<UTC 时间戳>-<sha8>.db`
（`VACUUM INTO` 快照，按 `DRIVER_NOTES_WEBDAV_KEEP` 轮换）、`phonote/media/ab/cd/<sha256>.<ext>`
（内容寻址，只传远端缺的）。pull 会先把本地库备份到 `backups/pre-pull-<时间戳>.db` 再原子替换。

## 打包成独立应用（自带后端）

打包产物的结构就是 Electron 的「`resources/app`」约定：壳启动时挑一个空闲端口，
把 `resources/app/backend/bin/phonote-backend.exe` 拉起来（里面是 PyInstaller 打进去的
`driver_platform` + `pho_note` 插件），等 `/health` 通过再开窗；退出时杀掉它。
所以最终用户双击 `PhoNote.exe` 就能用，`%USERPROFILE%\PhoNote` 是默认笔记目录。

### 构建

后端（在驱动平台仓库里跑 PyInstaller，因为要用它的虚拟环境）：

```powershell
cd D:\DSh\driver-platform-v2
.\venv\Scripts\python.exe -m pip install pyinstaller
.\venv\Scripts\python.exe -m PyInstaller --noconfirm --onefile --name phonote-backend `
  --distpath .tmp\pyi-dist --workpath .tmp\pyi-work --specpath .tmp\pyi-spec `
  --hidden-import uvicorn.logging --hidden-import uvicorn.loops.auto --hidden-import uvicorn.loops.asyncio `
  --hidden-import uvicorn.protocols.http.auto --hidden-import uvicorn.protocols.http.h11_impl `
  --hidden-import uvicorn.protocols.websockets.auto --hidden-import uvicorn.lifespan.on `
  --hidden-import uvicorn.lifespan.off --hidden-import PIL --hidden-import PIL.Image `
  --hidden-import prometheus_client --collect-submodules driver_platform `
  D:\DSh\PhoNote\backend\sidecar.py
copy .tmp\pyi-dist\phonote-backend.exe D:\DSh\PhoNote\backend\bin\
```

壳（复制 electron 发行版 + 把 JS 与后端放进 `resources/app`，最后打 zip）：

```powershell
cd D:\DSh\PhoNote
npm run package        # = powershell -File scripts/package.ps1
```

产物：`dist\PhoNote-win32-x64\PhoNote.exe`（整个目录 307 MB）和
`dist\PhoNote-0.2.0-win32-x64.zip`（148 MB，可直接发给别人解压运行）。

### 已经实测过什么

- 打包版双击启动：自带后端在随机端口（本机实测 `:61632`）起来，界面状态行显示
  `本机服务已就绪（:61632）`，文件树读到 `C:\Users\Administrator\PhoNote` 里的笔记。
- `Ctrl+Shift+S` 在**打包版**里真实按键：出现「已截图: cap_…」，图片区计数 +1，
  `GET /notes/api/captures` 能看到 `image/webp 1600x900`。
- 设置里的「AI 模式 / Base URL / API Key / 模型」改完会自动重启本机后端（换 key 不用重启应用）。

### 没有做的事（别当它能做）

- **没有代码签名**：首次运行会被 SmartScreen 拦一下（「更多信息 → 仍要运行」）。
- **没有自动更新**：换版本要重新打包分发。
- 只出了 **Windows x64** 便携版；没有安装器、没有开始菜单项、没有 macOS/Linux 包。
- GitHub Actions 不构建这个包（PyInstaller + Electron 二进制都不在 CI 里下）。

## 已知限制（P3 范围内，不是 bug）

- 多屏时只截**第一个屏幕**（取 `desktopCapturer` 的第一个 source）。
- 截图在**主进程**转 JPEG（质量 85、长边 1600），还没有 WebP 与缩略图。
- 批注的「选中文字 / 图片区域」锚点目前是占位对象，等选区 UI 补真实坐标。
- AI 只有一条请求一条响应，没有重试、限流和流式；每次最多带 6 张图（平台侧
  `DRIVER_NOTES_LLM_MAX_IMAGES`），超长笔记可能被模型截断。
- `openai`/`anthropic` 需要 API key；只有 `manual` 模式不需要任何 key（上下文包 + 手动粘回）。
- 补丁只做「唯一匹配的片段替换」，不支持移动图片顺序或改结构（要改就改正文，或另发一条指令）。
- 图片区只显示**还没被任何笔记用过**的图（`unused_only=true`），用完即消失。
- 删除节点不级联删图：图片留在缓冲区，可以再用。
- 同步只实现 `MKCOL`/`PUT`/`GET`/`DELETE`，没有 `PROPFIND`/`MOVE`，也没有断点续传与分块上传；
  远端只增不删媒体，靠 `KEEP` 轮换快照间接收敛。
- 同步是**单主设备**约定：不做双向合并，本地有未推送改动时 pull 直接拒绝。
- 真实的坚果云 / Nextcloud **没有连过**：只用本机写的 WebDAV 假服务（真实 HTTP）验过
  push → 换目录 pull。
- `openai` / `anthropic` 两种模式**只用 `httpx.MockTransport` 测过**，没有对真实模型服务跑过。
- 热键已用 `AppActivate` + `SendKeys("^+s")` 在打包版里真按过（截图进缓冲区、`image/webp 1600x900`）；
  但多屏、缩放、DPI 差异仍未验证（现在只取 `desktopCapturer` 的第一块屏）。
- 依赖安装依赖外网：Electron 二进制走 `ELECTRON_MIRROR` 镜像，且 npm 11 的 allow-scripts
  会拦住 postinstall，需要手动 `node node_modules/electron/install.js`（见第 2 节）。
