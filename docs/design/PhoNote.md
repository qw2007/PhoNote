# PhoNote 设计说明

> 网课截图 → 图片缓冲区 → 任意多图组成笔记 → AI 总结 → 讨论修订 → 批注。
> 本文是设计定稿（决策已锁，可直接照做），不是探索性草案。

- **状态**：设计定稿，待实现（P0 未开工）
- **形态**：桌面应用（Electron 壳）+ 平台侧领域插件（Python / 驱动平台插件契约）
- **命名**：产品 `PhoNote`；平台插件 `pho_note`；工具名前缀 `note_`
- **存储**：独立目录（默认 `D:\PhoNote`），可整体打包备份
- **组织方式**：**任意深度的自由文件树**（文件夹 + 笔记叶子，可建/改名/拖动/删除）
- **同步**：WebDAV（快照 + 图片增量，单向提交点为 manifest）
- **项目地址**：`https://github.com/qw2007/PhoNote`（private）

---

## 1. 七个已锁定的决策

| # | 决策 | 选择 | 理由 | 代价 / 何时回退 |
|---|------|------|------|----------------|
| 1 | 客户端形态 | **直接上桌面壳：Electron** | 本机有 Node 24.19.0，**没有 Rust/cargo，也没有 MSVC(cl.exe)/gcc** → Tauri 需要先装 VS Build Tools + Rust（>1 GB）；Electron 只依赖已有 Node。系统级全局热键、静默截屏、托盘常驻只有桌面壳能给 | 安装包 ~150–200 MB；首次 `npm install` 要能连 npm（先配镜像）。日后有 Rust 工具链可换 Tauri，接口不变 |
| 2 | AI 接入 | **api 与 manual 双模式并存，默认 `off`** | api 全自动（OpenAI-compatible / Anthropic）；manual 走网页版（免费或已付费订阅）。两者成本结构不同，不能二选一 | manual 需要人复制粘贴（§8.3） |
| 3 | 笔记真话 | **Markdown 是正文唯一真话**，SQLite 只存索引/元数据/版本 | 导出、迁移、被 Agent 读写、diff、回滚最省事 | 要富文本排版时用 Markdown 子集 + 前端渲染，不做 WYSIWYG 存储 |
| 4 | 组织层级 | **自由文件树**：任意深度文件夹 + 笔记叶子，可随时建/改名/移动/删除/排序 | 网课结构因人而异（有的按课程，有的按周，有的按主题），固定两级一定会被顶破；树是唯一不会后悔的结构 | 需要"课程"视图时用"某个文件夹"当课程，不回到固定字段 |
| 5 | 存储 | **独立目录**：`D:\PhoNote\`（`phonote.db` + `media/` + `backups/`） | 便于单独备份/迁移，不与驱动平台数据卷耦合 | 多设备靠 §9 的 WebDAV |
| 6 | 多设备同步 | **WebDAV**：整库快照 + 图片内容寻址增量，manifest 作为提交点；**单主设备**约定，不做双向字段级合并 | 坚果云/Nextcloud/群晖都自带 WebDAV；按 sha256 传图片天然幂等，只传缺的；合并两份会变的正文要向量时钟，属过度设计 | 真正多写并发时再考虑 CRDT/逐条记录同步 |
| 7 | 钥匙 | **壳用只读钥匙浏览，主设备用读写钥匙** | 第二台设备/投屏/分享只需要看；只读钥匙把误删风险关在门外。作用域是精确匹配、没有通配，所以两把钥匙各写全 | 单设备用户只用读写钥匙即可（§10） |

补充默认值（可改，不必拍板）：

- 图片落盘 **WebP 长边 1600**；**默认不保留原图**（`keep_original` 默认 false，需要时按次开启）；
- 平台插件默认**关闭**（`DRIVER_NOTES_ENABLED=0`），UI 端点默认关闭。

---

## 2. 系统架构

```
┌───────────────────────────── PhoNote 桌面壳（Electron）─────────────────────────────┐
│  main 进程                        │  renderer（四分区 UI + 文件树导航）              │
│  · globalShortcut 全局热键        │  · 树导航 / ① 图片区 ② 批注区 ③ 笔记区 ④ 讨论区  │
│  · desktopCapturer + 静默取帧     │  · Markdown 渲染 / 编辑 / 版本对比              │
│  · 托盘 / 悬浮提示 / 剪贴板兜底   │  · 本地只读缓存与离线草稿                        │
│  · 平台进程管理（可选本地拉起）   │  · WebDAV 同步触发（调平台工具）                 │
└───────────────────────────────┬────────────────────────────────────────────────────┘
                                │ HTTP + X-API-Key（读写钥匙 / 只读钥匙）
┌───────────────────────────────▼────────────────────────────────────────────────────┐
│ 驱动平台（已有，Python / FastAPI）                                                   │
│  · 插件 pho_note：文件树 / 抓取入库 / 笔记 CRUD / 批注 / 版本 / AI 总结与对话 / 导出   │
│  · WebDAV 同步（httpx，PUT/PROPFIND/MKCOL）                                          │
│  · 复用：鉴权与作用域、错误信封、request_id、指标、日志、特性开关                     │
│  · 存储：SQLite（树 + 索引）+ 文件目录（图片）                                        │
└────────────────────────────────────────────────────────────────────────────────────┘
```

为什么不是"壳里直接操作 SQLite"：领域能力要能被 Agent 以工具形式调用（这是驱动平台存在的意义），真话只有一份，放在插件里；壳只是**又一个客户端**。这也让"以后做网页版/手机版"零成本。

### 2.1 部署形态

| 形态 | 说明 | 适用 |
|------|------|------|
| `remote` | 壳填 `base_url` + `api_key`，连已在跑的实例 | 默认；多设备共用一台 |
| `local-spawn` | 壳启动时拉起 `docker compose up -d`（或本机 `.venv` 的 uvicorn） | 单机"打开就能用" |
| 纯离线（后期） | 壳内置 Python sidecar（PyInstaller 打包） | 不装 Docker 的分发形态 |

---

## 3. 领域模型：自由文件树

```
Node（唯一实体的树）
├── kind = 'folder'  → 只做容器，可任意深度
└── kind = 'note'    → 叶子；有 body_md / 图片 / 批注 / 讨论 / 版本

Capture（缓冲区，不入树）
   截图先落这里（note_id 为空），之后被"任意多张"挑进某个 note 节点。

node ──< revision
     ├──< note_image >── capture
     ├──< annotation（锚：整篇 / 文本 / 图上框）
     └──< message
```

关键设计：

1. **一张表装下整棵树**：`nodes(id, parent_id, kind, name, position, body_md)`。`parent_id IS NULL` 即根；`folder` 不进 `body_md`。树深不设上限（实际用 3–5 层）。
2. **排序用整数 `position`**：拖拽后对同层重排（`0..n-1`）。同层节点数是个位数到几十，O(n) 重排没有成本，不需要 `sort_key`/分数索引。
3. **同层名称唯一**：`UNIQUE(IFNULL(parent_id, ''), name)`。重名自动加 ` (2)`，避免树里出现两个不可区分的"第 3 讲"。
4. **移动要防成环**：把 A 移到自己的后代下 → 拒绝（`invalid_arguments`）。删除目录默认递归（`ON DELETE CASCADE`），图片留在缓冲区。
5. **路径不落库**：用递归 CTE 现算（导出、面包屑、WebDAV 的清单都用它）。不存 `path` 就没有"改了名忘了改路径"的一致性 bug。

### 3.1 表结构

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA user_version = 1;            -- 迁移靠它，按序 1→2→3

CREATE TABLE nodes (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('folder', 'note')),
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  position    INTEGER NOT NULL DEFAULT 0,
  body_md     TEXT NOT NULL DEFAULT '',     -- 仅 kind='note' 使用
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  CHECK (kind = 'note' OR body_md = '')      -- 文件夹永远没有正文
);
CREATE UNIQUE INDEX ux_nodes_sibling_name ON nodes(IFNULL(parent_id, ''), name);
CREATE INDEX idx_nodes_parent ON nodes(parent_id, position);
CREATE INDEX idx_nodes_updated ON nodes(updated_at DESC);

CREATE TABLE captures (
  id          TEXT PRIMARY KEY,
  sha256      TEXT NOT NULL UNIQUE,          -- 内容寻址：同图只存一份、只传一次
  path        TEXT NOT NULL,                 -- 相对 media/
  thumb_path  TEXT,
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  bytes       INTEGER NOT NULL,
  source      TEXT,                          -- 'screen' | 'window' | 'paste' | 'agent'
  app_title   TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE note_images (
  note_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  capture_id  TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  PRIMARY KEY (note_id, capture_id)
);

CREATE TABLE revisions (
  id          TEXT PRIMARY KEY,
  note_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  body_md     TEXT NOT NULL,
  reason      TEXT NOT NULL,   -- 'manual' | 'ai_summary' | 'ai_patch' | 'rollback'
  created_at  TEXT NOT NULL
);

CREATE TABLE annotations (
  id          TEXT PRIMARY KEY,
  note_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,   -- 'note' | 'text' | 'image'
  anchor      TEXT NOT NULL,   -- JSON，见 §3.2
  body_md     TEXT NOT NULL,
  color       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  note_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,   -- 'user' | 'assistant' | 'system'
  body        TEXT NOT NULL,
  revision_id TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_captures_created ON captures(created_at DESC);
CREATE INDEX idx_messages_note ON messages(note_id, created_at);
CREATE INDEX idx_annotations_note ON annotations(note_id);
```

### 3.2 树的三个核心查询

```sql
-- 整棵树（带深度与路径，前端一次拿全）
WITH RECURSIVE tree(id, parent_id, kind, name, position, depth, path) AS (
  SELECT id, parent_id, kind, name, position, 0, name
  FROM nodes WHERE parent_id IS NULL
  UNION ALL
  SELECT n.id, n.parent_id, n.kind, n.name, n.position,
         tree.depth + 1, tree.path || '/' || n.name
  FROM nodes n JOIN tree ON n.parent_id = tree.id
)
SELECT * FROM tree ORDER BY path, position;
```

```sql
-- 移动前防环：new_parent 是否是 self 或 self 的后代
WITH RECURSIVE sub(id) AS (
  SELECT id FROM nodes WHERE id = :self
  UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
)
SELECT 1 FROM sub WHERE id = :new_parent;
```

```sql
-- 同层重排（把 node 放到 target 前后）：整体重编号，避免浮点 key
UPDATE nodes SET position = :i WHERE id = :id;
```

### 3.3 批注锚点三种形态

```jsonc
// 整篇
{ "kind": "note", "anchor": { "type": "note" } }

// 文本：quote 可随文移动，offset 只作快速定位
{ "kind": "text", "anchor": {
    "type": "text", "quote": "中值定理的三个条件",
    "prefix": "…本节讲", "suffix": "，必须都满足", "offset": 128 } }

// 单图框选：rect 归一化 [x, y, w, h]，0..1，与显示尺寸无关
{ "kind": "image", "anchor": {
    "type": "rect", "capture_id": "cap_01H…", "rect": [0.12, 0.31, 0.44, 0.18] } }
```

---

## 4. 平台插件接口（按驱动平台既有契约）

```
src/driver_platform/plugins/pho_note/
  __init__.py        # 导出 PhoNotePlugin
  plugin.py          # class PhoNotePlugin(Plugin): plugin_id="pho_note", version="0.1.0"
  store.py           # SQLite + 文件；所有 SQL 只在这里（含树操作、防环）
  tools.py           # 每个工具一个 Tool 子类
  llm.py             # Provider 协议 + openai / anthropic / manual
  webdav.py          # WebDAV 客户端（httpx）
  api.py             # 给桌面壳用的 REST router（不进工具表）
  web/               # 可选：无构建静态页（浏览器兜底，默认关）
```

`contract_version = "1.0"`。

| 工具 | 作用 | 关键入参 |
|------|------|----------|
| `note_tree` | 整棵树（嵌套 + 每节点笔记/图片/批注计数） | `max_depth?` |
| `note_node_create` | 建文件夹或空笔记 | `parent_id?`、`kind`、`name` |
| `note_node_rename` | 改名 | `node_id`、`name` |
| `note_node_move` | 移动/排序（防环） | `node_id`、`new_parent_id?`、`position?` |
| `note_node_delete` | 删（文件夹默认递归） | `node_id`、`recursive` |
| `note_add_capture` | 登记截图进缓冲区（同 sha256 幂等） | `image_b64` \| `image_url`、`source`、`app_title` |
| `note_list_captures` | 列缓冲区 | `limit`、`since?` |
| `note_compose` | **任意多张** Capture → 新笔记节点 | `parent_id?`、`capture_ids[]`、`title`、`body_md?` |
| `note_get` / `note_list` | 详情（正文+图+批注+版本）/ 按名字搜笔记 | `note_id`；`q`、`limit` |
| `note_update` | 改标题/正文（自动拍 Revision） | `note_id`、`name?`、`body_md?` |
| `note_attach_capture` / `note_detach_capture` | 给笔记加/减图（图留在缓冲区） | `note_id`、`capture_id(s)` |
| `note_annotate` / `note_annotate_delete` | 加/删批注（三种锚） | 见 §4.1 |
| `note_summarize` | 生成/重写总结（落新 Revision） | `note_id`、`style` |
| `note_chat` | 讨论区一轮对话 | `note_id`、`message`、`stream?` |
| `note_apply_patch` | 应用 AI 的 find/replace 建议 | `note_id`、`edits[]` |
| `note_ingest_ai_reply` | manual 模式：灌回网页版回答 | `note_id`、`text`、`as` |
| `note_revisions` / `note_rollback` | 版本列表 / 回滚 | `note_id`；`+revision_id` |
| `note_export` | 导出 Markdown（按树还原目录）/ zip | `node_id?`、`format` |
| `note_backup` | 打包数据目录到 `backups/` | `label?` |
| `note_sync_push` / `note_sync_pull` | WebDAV 推送 / 拉取（§9） | `dry_run?` |
| `note_sync_status` | 上次同步时间、manifest 摘要、待上传数 | — |

### 4.1 两个接口示例

```json
{ "name": "note_node_move", "contract_version": "1.0",
  "description": "把节点移动到某个文件夹下，可选指定同层位置。移动到自身后代会被拒绝。",
  "input_schema": {
    "type": "object",
    "properties": {
      "node_id":       { "type": "string" },
      "new_parent_id": { "type": ["string", "null"] },
      "position":      { "type": "integer", "minimum": 0 }
    },
    "required": ["node_id"],
    "additionalProperties": false } }
```

```json
{ "name": "note_annotate", "contract_version": "1.0",
  "description": "给笔记加批注：整篇(note)、一段文本(text，带 quote 以便随文移动)或某张图的框选区域(rect，归一化坐标)。",
  "input_schema": {
    "type": "object",
    "properties": {
      "note_id": { "type": "string" },
      "kind":    { "type": "string", "enum": ["note", "text", "image"] },
      "anchor":  { "type": "object" },
      "body_md": { "type": "string", "minLength": 1 },
      "color":   { "type": "string" }
    },
    "required": ["note_id", "kind", "anchor", "body_md"],
    "additionalProperties": false } }
```

### 4.2 错误码

| code | 状态 | 场景 |
|------|------|------|
| `note_not_found` | 404 | 节点 / 图片 / 版本不存在 |
| `node_move_invalid` | 422 | 移到自身或后代；`new_parent` 不是文件夹 |
| `node_name_conflict` | 409 | 同层重名（自动加序号失败时） |
| `ai_not_configured` | 400 | 调了 AI 工具但 `DRIVER_NOTES_LLM=off` |
| `ai_unavailable` | 502 | provider 超时 / 非 2xx |
| `ai_reply_unparsable` | 422 | manual 灌回的回答解析不出 summary/edits |
| `sync_not_configured` | 400 | 没配 WebDAV |
| `sync_failed` | 502 | WebDAV 返回非 2xx（详情带方法/路径/状态码） |

其余复用：`invalid_arguments`(422)、`permission_denied`(403)、`tool_not_found`(404)。

### 4.3 REST 端点（给桌面壳，不进工具表）

| 方法 | 路径 | 用途 |
|------|------|------|
| `GET` | `/notes/api/tree` | 文件树（嵌套，含计数） |
| `POST` | `/notes/api/nodes` | 建文件夹/笔记 |
| `PATCH` | `/notes/api/nodes/{id}` | 改名 / 改正文（自动 Revision） |
| `POST` | `/notes/api/nodes/{id}/move` | 移动 / 排序 |
| `DELETE` | `/notes/api/nodes/{id}?recursive=` | 删除 |
| `GET` | `/notes/api/notes/{id}` | 笔记详情（正文+图+批注+最近版本+消息） |
| `POST` | `/notes/api/captures` | `multipart/form-data` 上传截图 |
| `GET` | `/notes/api/captures/{id}/image` \| `/thumb` | 原图 / 缩略图（`immutable` + sha256 寻址） |
| `POST` | `/notes/api/notes/{id}/chat` | 讨论（`stream=true` 走 SSE） |
| `POST` | `/notes/api/notes/{id}/apply` | 应用 edits |
| `GET` | `/notes/api/notes/{id}/export` | Markdown / zip |
| `POST` | `/notes/api/backup` | 打包备份 |
| `POST` | `/notes/api/sync/push` \| `/pull` | WebDAV 同步 |
| `GET` | `/notes/api/sync/status` | 同步状态 |

**为什么两套入口**：工具给 Agent（schema + 审计 + 统一错误信封），REST 给界面（multipart 传大图、SSE、字节级缓存）。二者共用 `store.py`，业务逻辑只有一份。

**UI 挂载不改插件契约**：只有一个插件需要 UI，不值得为它抽象契约；由 `main.py` 显式挂载 4 行：

```python
if resolved.notes_enabled and resolved.notes_ui:
    from driver_platform.plugins.pho_note.api import build_notes_router
    app.include_router(build_notes_router(resolved))   # 内部已挂 /notes/api + 鉴权依赖
```

等第二个需要界面的插件出现，再提升成 `Plugin.web()`（契约 1.1）。

**作用域是精确匹配、没有前缀通配**（`*` 只代表全权），所以两把钥匙都要把工具名逐个列全，见 §10。

---

## 5. 截图管线

快捷键 → 静默取帧 → 上传 → 落缓冲区，全程不打断听课。

```js
// main.js
const { globalShortcut, desktopCapturer, session } = require('electron')

app.whenReady().then(() => {
  globalShortcut.register('Control+Shift+S', () => captureNow())
})

async function captureNow() {
  const sources = await desktopCapturer.getSources({
    types: ['screen'], thumbnailSize: { width: 0, height: 0 }
  })
  session.defaultSession.setDisplayMediaRequestHandler((req, cb) => {
    cb({ video: sources[0] })            // 静默选主屏，不弹选择框
  }, { useSystemPicker: false })

  const frame = await frameWindow.grabOnce()   // getDisplayMedia → ImageCapture → canvas
  const meta = await api.upload('/notes/api/captures', {
    blob: frame.blob, app_title: frame.foregroundTitle
  })
  notify(`已入缓冲区（${meta.width}×${meta.height}）`)
}
```

坑与对策：

1. **分辨率**：`desktopCapturer.getSources` 的 `thumbnail` 是缩放图；要原始像素必须 `getDisplayMedia` 抓流后取帧（走这条）。
2. **多显示器**：热键默认主屏，`Ctrl+Shift+D` 切下一块；选择记在 `settings.json`。
3. **高 DPI**：以实际帧尺寸为准，不要用 `screen.getPrimaryDisplay().size`。
4. **热键被占用**：注册失败就提示，并启用"剪贴板兜底"（监听 `paste` 吃 `Win+Shift+S` 的图）。
5. **不打断**：只发 3 秒托盘通知，不强制切窗口——这类工具最容易做错的地方。
6. **隐私**：截图只在本地与自己的平台之间流动；`manual` 模式下也只有你主动复制才离开本机。

---

## 6. 四分区界面 + 树的导航

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ PhoNote   Ctrl+Shift+S 截图   Ctrl+Shift+D 切屏   ⟳ 同步   ⚙   [备份]      ● 在线     │
├────────────┬──────────────┬──────────────────────────────────┬──────────────────────┤
│ 文件树      │ ① 图片区      │ ③ 现有笔记区                      │ ④ 讨论区              │
│ (导航，可折叠)│              │                                  │                      │
│ ▾ 高数      │ 未归档 3 张   │ # 中值定理                        │ 你：把第二段证明补全  │
│  ▾ 第3讲    │ ┌──┐┌──┐┌──┐ │                                   │ AI：好的，补充如下…   │
│   · 中值定理 │ │  ││  ││  │ │ 若 f 在 [a,b] 连续…[1]           │ ───────────────────  │
│   · 罗尔定理 │ └──┘└──┘└──┘ │                                   │ [应用修改] [重答]     │
│ ▸ 线代      │ [组成笔记]    │ [1] 老师强调三个条件必须同时满足   ├──────────────────────┤
│            │              │ ─────────────────────────         │ ② 批注区              │
│ ═══ 拖拽可改 │ 本笔记 4 张   │ ✎ 编辑   🕘 版本   ⤓ 导出          │ · 图1 框选「ε-δ」：没听懂│
│ ＋ 新建      │ ┌──┐┌──┐     │                                   │ · 正文[1]：考试重点   │
│            │ │  ││  │     │                                   │ [+ 新批注]            │
└────────────┴──────────────┴──────────────────────────────────┴──────────────────────┘
```

| 区 | 数据来源 | 写操作 | 交互要点 |
|----|----------|--------|----------|
| 树 | `GET /notes/api/tree` | `POST/PATCH/DELETE nodes`、`POST .../move` | 拖拽移动/排序；右键菜单（新建文件夹/笔记、重命名、删除）；只读钥匙下隐藏全部写入口 |
| ① 图片区 | tree + captures | 多选 `POST /notes/api/notes`（compose） | 多选框 +「组成笔记」；已入笔记的图显示所属笔记角标 |
| ③ 笔记区 | `GET /notes/api/notes/{id}` | `PATCH`（防抖 800 ms 自动存）、版本、导出 | 预览/编辑双态；批注角标内联；版本左右 diff |
| ④ 讨论区 | 笔记详情里的 messages | `POST /chat`（SSE）、`/apply` | AI 回复里的 edits 渲染成「建议卡片」，逐条勾选应用 |
| ② 批注区 | 同笔记详情 | `POST/DELETE annotations` | 选中文本/框选图片后浮出"加批注"；点击批注滚动定位并高亮锚点 |

树是**导航区**（不算第五个"不可或缺的区"），宽窗常驻；窄窗（<1100px）收进左侧抽屉。② 在窄窗变成右侧抽屉。

---

## 7. 同步（WebDAV）

### 7.1 远端布局

```
<remote>/phonote/manifest.json                     # 提交点：最后写
<remote>/phonote/db/phonote-20261110-2130.db.zip   # VACUUM INTO 快照，保留最近 N 份
<remote>/phonote/media/ab/cd/<sha256>.webp         # 内容寻址，天然去重
```

```jsonc
// manifest.json
{
  "format": "phonote/1",
  "generated_at": "2026-11-10T21:30:12Z",
  "device": "desk-win",
  "db": { "path": "db/phonote-20261110-2130.db.zip", "sha256": "…", "bytes": 183422 },
  "media": [ { "sha256": "ab12…", "bytes": 84120 }, … ]
}
```

### 7.2 push / pull

| 动作 | 步骤 |
|------|------|
| **push** | ① `MKCOL` 补齐目录（已存在返回 405 视为成功）② `GET manifest.json`（可选，拿远端已有 sha256 集合）③ 只 `PUT` 缺失的图片（按 sha256 文件名，重复上传无副作用）④ `VACUUM INTO` 出快照并压缩 ⑤ `PUT` 快照 ⑥ **最后 `PUT` manifest.json** —— 提交点，前五步中断不会污染远端 |
| **pull** | ① `GET manifest.json` ② 若本地有未推送改动（`updated_at > manifest.generated_at`）→ 拒绝，`--force` 才继续（先 `note_sync_push`）③ 下载快照到临时文件、校验 sha256 ④ 备份当前库到 `backups/` ⑤ 原子替换（`os.replace`）⑥ 按 manifest 补拉缺失图片 ⑦ 打开 WAL、跑迁移检查 |

### 7.3 配置与安全

```
DRIVER_NOTES_WEBDAV_URL=https://dav.jianguoyun.com/dav/PhoNote
DRIVER_NOTES_WEBDAV_USER=me@example.com
DRIVER_NOTES_WEBDAV_PASSWORD=...        # 只从环境变量读，绝不进 DB、绝不进日志
DRIVER_NOTES_WEBDAV_KEEP=5              # 远端保留的数据库快照份数
```

壳侧只提供"现在同步 / 每 N 分钟自动同步"；令牌/密码存 `%APPDATA%\PhoNote\settings.json`（不进仓库、不进导出）。

### 7.4 不做（明确）

- 不做双向字段级合并：两台设备同时编辑同一篇会丢其中一份，**约定单主设备**（文档与 UI 都要写这句话）；
- 不做实时协同（CRDT）、不做冲突 UI；
- 不传 `exports/`、不传缩略图（可本地重建）。

---

## 8. AI 接入

### 8.1 Provider 协议

```python
class Message(TypedDict):
    role: Literal["system", "user", "assistant"]
    content: str

class ImageRef(NamedTuple):
    path: Path
    mime: str            # image/webp

class LLMProvider(Protocol):
    name: str
    async def complete(
        self,
        messages: Sequence[Message],
        *,
        images: Sequence[ImageRef] = (),
        json_mode: bool = False,
    ) -> str: ...
```

| 实现 | 何时用 | 关键点 |
|------|--------|--------|
| `OpenAICompatibleProvider` | `DRIVER_NOTES_LLM=openai` | 一把 `base_url` 覆盖 DeepSeek / 通义 / Kimi / Ollama / vLLM；多模态用 `image_url` + `data:` URI |
| `AnthropicProvider` | `DRIVER_NOTES_LLM=anthropic` | `messages` + `image`(base64) 块；system 单独字段 |
| `ManualProvider` | `DRIVER_NOTES_LLM=manual` | **不联网**：把上下文包成文本返回，由用户粘到网页版 |

```
DRIVER_NOTES_LLM=off|openai|anthropic|manual
DRIVER_NOTES_LLM_BASE_URL=https://api.deepseek.com/v1
DRIVER_NOTES_LLM_API_KEY=...
DRIVER_NOTES_LLM_MODEL=deepseek-chat
DRIVER_NOTES_LLM_MAX_IMAGES=6
DRIVER_NOTES_LLM_MAX_PX=1024
```

### 8.2 让 AI "修改"而不是"重写全文"

模型统一输出增量补丁：

```json
{ "summary": "本节课讲了中值定理的三个条件与两个推论。",
  "edits": [ { "find": "若 f 在 [a,b] 连续",
               "replace": "若 f 在闭区间 [a,b] 上连续，在开区间 (a,b) 内可导" } ] }
```

- `find` 必须在正文里**唯一出现**，否则该条标记"未应用"交给人处理；
- 应用成功 → 拍 Revision（`reason='ai_patch'`）→ 可回滚；
- 提示词固定约束：只改命中片段、不动标题层级、保留 `[n]` 批注角标。

### 8.3 manual 模式

`note_summarize` 返回**上下文包**而不是总结：

```json
{ "mode": "manual",
  "bundle": {
    "prompt": "你是我的复习助手…请按「定义 / 定理 / 易错点」三节总结，输出 JSON：{summary, edits}。",
    "note_md": "…当前正文…",
    "annotations": ["…"],
    "images": ["cap_01H…（第 1 张）", "cap_01H…（第 2 张）"]
  },
  "copy_text": "（完整可粘贴文本）",
  "image_dir": "D:\\PhoNote\\exports\\note_xxx\\" }
```

流程：壳复制 `copy_text` + 打开导出目录 → 你贴给网页版 → 回答复制回来 → `note_ingest_ai_reply(note_id, text, as="auto")` 解析并预览应用。

理由：网页版没有官方 API，无头浏览器驱动既违反条款又会随前端改版而碎。**manual 是唯一能长期稳定的免费路径。**

### 8.4 成本控制

图片送模型前缩到长边 1024（WebP q=0.8）；单次最多 6 张；超过则"每 6 张先局部总结再合并"（map-reduce）；正文超 8k 字符时只送标题行 + 关键词命中的段落。

---

## 9. 存储、备份与迁移

```
D:\PhoNote\                        # DRIVER_NOTES_DIR
├── phonote.db                     # SQLite（WAL）
├── media\ab\cd\<sha256>.webp      # 内容寻址原图（默认长边 1600，不保留原始分辨率）
├── thumbs\<sha256>.webp           # 缩略图（长边 320，本地重建）
├── exports\node_<id>\             # manual 模式的图片清单 + prompt.txt
└── backups\phonote-20261110-2130.zip
```

- **备份**：`VACUUM INTO` 一致性快照 + `media/` 打包；不打包 `exports/`。
- **恢复**：解压到新目录 → 改 `DRIVER_NOTES_DIR` 指向它即可（路径都相对 `media/`）。
- **迁移**：`PRAGMA user_version` 顺序升级，每步一个函数 + 一条测试（建 v1 库升到当前版本再断言）。
- **并发**：WAL + 单写者；壳只读缓存，写永远经平台。

---

## 10. 鉴权：两把钥匙

```bash
# 主设备（读写）：截图上传、组笔记、改正文、批注、AI、同步
DRIVER_API_KEYS="pho-rw:note_tree|note_get|note_list|note_node_create|note_node_rename|note_node_move|note_node_delete|note_add_capture|note_list_captures|note_compose|note_update|note_attach_capture|note_detach_capture|note_annotate|note_annotate_delete|note_summarize|note_chat|note_apply_patch|note_ingest_ai_reply|note_revisions|note_rollback|note_export|note_backup|note_sync_push|note_sync_pull|note_sync_status"

# 只读设备（第二台电脑 / 投屏 / 给 Agent 看）：只能浏览与导出
DRIVER_API_KEYS="...,pho-ro:note_tree|note_get|note_list|note_list_captures|note_export|note_sync_status"
```

- 作用域**精确匹配**，`*` 只代表"全权"，没有前缀通配 → 必须逐个列（上面已列全）。
- 壳的设置里选钥匙；`readonly=true` 时隐藏树/笔记的写入口、禁用截图热键、讨论区只读。
- 只读钥匙调写工具 → 403 `permission_denied`，`details` 里会列出"需要作用域"。

---

## 11. 与驱动平台的对齐

| 机制 | 用法 |
|------|------|
| 错误信封 | `raise PlatformError(...)` → `{"error":{code,message,details,request_id}}` |
| 可观测性 | 自动获得 `driver_tool_calls_total{tool="note_compose"}` 与 `tool_call` 日志 |
| 特性开关 | `DRIVER_NOTES_ENABLED=0`、`DRIVER_NOTES_UI=0` |
| 存储 | `DRIVER_NOTES_DIR`（默认 `D:\PhoNote`；容器里映射 `/data/phonote`） |
| 契约 | `contract_version="1.0"`；加可选字段=minor，删字段/改语义=major |

---

## 12. 分期路线

| 期 | 范围 | 验收 |
|----|------|------|
| **P0** | 仓库骨架 + 插件（`store.py` + 树三个工具 + `note_add_capture`/`note_compose`/`note_get`）+ 迁移 v1；Electron 壳：热键、静默截主屏、上传、树 + 图片区渲染 | `pytest` 全绿；按 `Ctrl+Shift+S` 后图片区出缩略图；`GET /v1/tools` 能看到工具；重启数据还在 |
| **P1** | 树完整 CRUD（含拖拽、防环、同层重排）+ 笔记编辑 + 四分区 + 文本/图片批注 + 自动 Revision + 只读钥匙模式 | 建三层树、拖动不出错、移到自身后代被拒；两种批注角标重启后仍在；只读钥匙隐藏写入口 |
| **P2** | `note_summarize` + 讨论区 + edits 应用 + 版本 diff | 一次真实总结落 Revision；2 条 edits 中 1 条应用、1 条因 `find` 不唯一正确标"未应用"；回滚验证 |
| **P3** | WebDAV 同步 + 备份/恢复 + manual 模式 + 多显示器/窗口选择 + 设置页 | 断网走完 manual 全流程；push 后在另一目录 pull 还原出同样的树与图片；备份 zip 可恢复 |

P0 建议一次提交：`feat(pho-note): 截图入缓冲区到组成笔记的最小闭环`。

---

## 13. 风险与已知限制

| 风险 | 影响 | 应对 |
|------|------|------|
| Electron 首次 `npm install` / 打包需外网 | 装不上就开不了发 | 配国内镜像；开发期 `npm start`，打包最后做 |
| 全局热键被占用 | 快捷键无反应 | 注册失败即提示 + 剪贴板兜底；设置页可改键 |
| 多显示器 + 高 DPI | 分辨率/坐标错 | 以真实帧尺寸为准；`rect` 归一化 |
| 截图含隐私（人脸、付费内容） | 数据泄露 | 默认只存本地；只有点"总结"才发送；manual 由人决定粘贴内容 |
| WebDAV 平台差异（不支持 MKCOL/PUT） | 同步失败 | 报 `sync_failed` 带方法/路径/状态码；只支持标准 WebDAV（坚果云/Nextcloud/群晖） |
| 两台设备同时改 | 丢一份 | **单主设备**约定；pull 前检测本地未推送改动并拒绝 |
| 树里同名 | 混淆 | 同层唯一 + 自动加 ` (2)` |
| 移动成环 | 树损坏 | 移动前递归 CTE 校验，`node_move_invalid` |
| SQLite 并发写 | `SQLITE_BUSY` | 只让平台写；WAL + `busy_timeout=5000` |
| 笔记越写越大 | 上下文超限 | §8.4 的分段总结；导出后归档 |
| 插件默认关 | 壳调不通 | 壳启动做能力探测（`GET /v1/tools`），缺工具就一键配置指引 |

明确不做：多人实时协作、CRDT 合并、自动录屏转写、全文检索（先 `LIKE`，需要再上 FTS5）、浏览器端全局热键。

---

## 14. 未决（不阻塞 P0）

1. 图片是否对**关键节点**按次保留原图（默认全不保留，需要时 `keep_original=true`）？
2. 树是否需要"模板"（新建笔记时自动带「定义 / 定理 / 易错点」骨架）？
3. 远端保留几份库快照（默认 5）——按天数还是按份数清理？
4. 是否给 Agent 单独一把更窄的钥匙（只 `note_tree|note_get`），与"只读设备钥匙"分开？

---

## 15. 参考实现（分类；**我未逐个核实其当前维护状态与许可证**）

| 类型 | 举例 | 可借的点 |
|------|------|----------|
| 截图/标注 | ShareX、Flameshot、Snipaste（闭源）、PowerToys Text Extractor | 即时标注手感、快捷键默认值、剪贴板兜底 |
| 笔记 + AI | Obsidian 的 Copilot 类插件、Logseq、SiYuan、Joplin、Trilium | 本地优先、Markdown 为真话、自由文件树 + 双链 |
| 文档问答 | anything-llm、khoj、Reor | 分段总结 + 引用溯源（"这句来自第 3 张图"） |
| 网页/视频摘要 | BibiGPT、Glarity、YouTube Summary | 一键摘要的交互与配额控制 |
| MCP 生态 | 各家 obsidian/notion MCP server | **把笔记暴露成工具给 Agent** —— 正是本设计平台侧的做法 |
| 桌面壳 | Electron `desktopCapturer` / `globalShortcut` 官方示例 | 静默取帧与热键注册的坑 |

以上名称来自记忆，作为架构对照可以，不要当结论引用。
