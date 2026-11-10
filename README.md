# PhoNote

网课截图 -> 图片缓冲区 -> 任意多图组成笔记 -> AI 总结与讨论修订 -> 批注。

- 形态：桌面应用（Electron 壳）+ 平台侧领域插件（Python，驱动平台插件契约）
- 设计说明：[docs/design/PhoNote.md](docs/design/PhoNote.md)
- 状态：**P0 / P1 已实现**；P2（AI 总结与讨论修订）、P3（WebDAV 同步）见设计文档第 12 节

## P1 包含什么

| 部分 | 位置 | 内容 |
|---|---|---|
| 平台插件 | 驱动平台仓库 `src/driver_platform/plugins/pho_note/` | 存储层（SQLite 树 + 内容寻址图片 + 批注 + 版本）+ 17 个工具 |
| REST 层 | 同上 `api.py` | `/notes/api/*` 十六条端点，`DRIVER_NOTES_UI=1` 才挂载 |
| 桌面壳 | 本仓库 `main.js` / `preload.js` / `renderer/` | 四分区界面、全局热键截图、树增删改移、批注、版本回滚、只读模式 |

查看界面的四个分区：**图片区**（缓冲区）、**讨论区**（P2 接入 AI 后显示往来消息）、
**现有笔记区**（正文编辑）、**批注区**（整篇 / 选中文字 / 图片区域三种锚点）。
左侧另有一列文件树用于导航。

十七个工具：树 `note_tree`、`note_node_create`、`note_node_rename`、`note_node_move`、
`note_node_delete`；截图 `note_add_capture`、`note_list_captures`；笔记 `note_compose`、
`note_get`、`note_list`、`note_update`、`note_set_images`；批注 `note_annotate`、
`note_annotate_delete`；版本 `note_revisions`、`note_rollback`；导出 `note_export`。

## 跑起来

### 1. 平台侧

```powershell
# 在驱动平台仓库根目录
$env:DRIVER_PLUGINS = "pho_note"
$env:DRIVER_NOTES_DIR = "$env:USERPROFILE\PhoNote"   # 可省略，默认就是这个
$env:DRIVER_NOTES_UI = "1"                            # 挂载 /notes/api/*
.\.venv\Scripts\python.exe -m uvicorn driver_platform.main:app --host 127.0.0.1 --port 8000
```

验证：

```powershell
curl.exe -s http://127.0.0.1:8000/v1/tools | ConvertFrom-Json | ForEach-Object { $_.name }
curl.exe -s http://127.0.0.1:8000/notes/api/tree
```

### 2. 桌面壳

```powershell
npm install
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

### 3. 用法

1. 开着网课，按 `Ctrl+Shift+S`（或点「截图入缓冲区」）→ 图片进**图片区**；
2. 在图片区点要用的图（可多选）→ 填标题 → 「组成笔记」→ 新笔记出现在左侧树里；
3. 点树里的笔记 → 右侧**现有笔记区**显示图与正文，改完点「保存笔记」（存旧版本）；
4. 右侧**批注区**写批注（可选整篇/选中文字/图片区域、颜色）；**讨论区**等 P2；
5. 「导出 Markdown」把当前笔记的 Markdown 复制到剪贴板（图片是绝对路径）。

## 已知限制（P1 范围内，不是 bug）

- 多屏时只截**第一个屏幕**（取 `desktopCapturer` 的第一个 source）。
- 截图在**主进程**转 JPEG（质量 85、长边 1600），P2 再上 WebP 与缩略图。
- 批注的「选中文字 / 图片区域」锚点目前是占位对象，等 P2 的选区 UI 补真实坐标。
- 讨论区是空面板：AI 接入（P2）前没有消息可显示。
- 图片区只显示**还没被任何笔记用过**的图（`unused_only=true`），用完即消失。
- 删除节点不级联删图：图片留在缓冲区，可以再用。
- **`npm install` 未在本机实际跑过**（本机网络对 npm registry 不稳），Electron
  版本与依赖树未经验证；三个 JS 文件只做过 `node --check` 语法检查。
