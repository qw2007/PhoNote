# PhoNote

网课截图 -> 图片缓冲区 -> 任意多图组成笔记 -> AI 总结与讨论修订 -> 批注。

- 形态：桌面应用（Electron 壳）+ 平台侧领域插件（Python，驱动平台插件契约）
- 设计说明：[docs/design/PhoNote.md](docs/design/PhoNote.md)
- 状态：**P0 已实现**（截图 → 缓冲区 → 组笔记 → 读回）；P1–P3 见设计文档第 12 节

## P0 包含什么

| 部分 | 位置 | 内容 |
|---|---|---|
| 平台插件 | 驱动平台仓库 `src/driver_platform/plugins/pho_note/` | 存储层（SQLite 树 + 内容寻址图片）+ 6 个工具 |
| 桌面壳 | 本仓库 `main.js` / `preload.js` / `renderer/` | 全局热键截主屏、图片区、文件树、组笔记、读笔记 |

六个工具：`note_tree`、`note_node_create`、`note_add_capture`、`note_list_captures`,
`note_compose`、`note_get`。

## 跑起来

### 1. 平台侧

```powershell
# 在驱动平台仓库根目录
$env:DRIVER_PLUGINS = "pho_note"
$env:DRIVER_NOTES_DIR = "$env:USERPROFILE\PhoNote"   # 可省略，默认就是这个
.\.venv\Scripts\python.exe -m uvicorn driver_platform.main:app --host 127.0.0.1 --port 8000
```

验证：

```powershell
curl.exe -s http://127.0.0.1:8000/v1/tools | ConvertFrom-Json | Select-Object -ExpandProperty name
```

应当看到 `echo` 与六个 `note_*` 工具。

### 2. 桌面壳

```powershell
npm install
npm start
```

首次启动会在 `%APPDATA%\PhoNote\settings.json` 生成配置：

```json
{
  "apiBase": "http://127.0.0.1:8000",
  "apiKey": "",
  "notesDir": "C:\\Users\\<你>\\PhoNote"
}
```

- `apiKey`：平台开了 `DRIVER_AUTH_MODE=required` 时填一把**包含**
  `note_tree|note_node_create|note_add_capture|note_list_captures|note_compose|note_get`
  作用域的钥匙（作用域是精确匹配，写错一个工具名就调不动它）。
- `notesDir`：必须与平台的 `DRIVER_NOTES_DIR` 一致——壳直接按 sha256 从磁盘读原图，
  P0 还没有 `/captures/{id}/image` 端点。

### 3. 用法

1. 开着网课，按 `Ctrl+Shift+S`（或点右上角「截图」）→ 图片进缓冲区；
2. 在图片区点要用的图（可多选）；
3. 填标题 → 点「组成笔记」→ 新笔记出现在左侧树里，右侧显示它的图；
4. 点树里的任意笔记可以读回。

## 已知限制（P0 范围内，不是 bug）

- 多屏时只截**第一个屏幕**；P1 按鼠标所在显示器挑。
- 截图在**主进程**转 JPEG（质量 85、长边 1600）；WebP 转码在 P1 与缩略图一起做。
- 讨论区（P2）、批注区（P1）、四分区完整布局、改名/移动/删除都还没做——
  界面上不预埋空面板。
- 未做设置界面：改 `settings.json` 后重启生效。
- **`npm install` 未在本机实际跑过**（本机网络对 npm registry 不稳），所以
  Electron 版本与依赖树未经验证；`package.json` 里钉的是 `electron ^33`。
- 图片列表只显示**还没被任何笔记用过**的图（`unused_only`）；用完即从图片区消失。
