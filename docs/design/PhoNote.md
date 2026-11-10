# PhoNote 设计说明

> 网课截图 → 图片缓冲区 → 任意多图组成笔记 → AI 总结 → 讨论修订 → 批注。
> 本文是设计定稿（决策已锁，可直接照做），不是探索性草案。

- **状态**：设计定稿，待实现（P0 未开工）
- **形态**：桌面应用（Electron 壳）+ 平台侧领域插件（Python / 驱动平台插件契约）
- **命名**：产品 `PhoNote`；平台插件 `pho_note`；工具名前缀 `note_`
- **存储**：独立目录（默认 `D:\PhoNote`），可整体打包备份
- **项目地址**：`https://github.com/qw2007/PhoNote`（private）

---

## 1. 五个已锁定的决策

| # | 决策 | 选择 | 理由 | 代价 / 何时回退 |
|---|------|------|------|----------------|
| 1 | 客户端形态 | **直接上桌面壳：Electron** | 本机有 Node 24.19.0，**没有 Rust/cargo，也没有 MSVC(cl.exe)/gcc** → Tauri 需要先装 VS Build Tools + Rust（>1 GB，且本机无 cl）；Electron 只依赖已有 Node。系统级全局热键、静默截屏、托盘常驻都只有桌面壳能给 | 安装包 ~150–200 MB；首次 `npm install` 要能连 npm（国内建议先配镜像）。若日后有 Rust 工具链，可换 Tauri 减小体积，接口不变 |
| 2 | AI 接入 | **api 与 manual 双模式并存，默认 `off`** | api 全自动（OpenAI-compatible / Anthropic），manual 走网页版（免费或已付费的订阅），二者是不同成本结构，不能二选一 | manual 需要人复制粘贴（见 §7.3） |
| 3 | 笔记真话 | **Markdown 是正文唯一真话**，SQLite 只存索引/元数据/版本 | 导出、迁移、被 Agent 读写、diff、回滚全都最省事；富文本/结构化 JSON 会让"让 AI 改一段"变成协议设计题 | 若要富文本排版，用 Markdown 子集 + 前端渲染，不做 WYSIWYG 存储 |
| 4 | 层级 | **课程 → 笔记**（一门课一个笔记库，笔记按课程归档） | 网课天然按课程/讲次组织；扁平标签在 20 节课后就会失控 | 需要跨课程视图时再加标签，不动主结构 |
| 5 | 存储 | **独立目录**：`D:\PhoNote\`（`phonote.db` + `media/` + `backups/`） | 便于单独备份/迁移，不与驱动平台的数据卷耦合；一个 zip 就是完整备份 | 多设备同步留白（§12）；不做自动云同步 |

补充两个默认值（可改，不必拍板）：

- 图片落盘为 **WebP，长边默认 1600**，原图可选保留（`keep_original=true`）；
- 平台插件默认**关闭**（`DRIVER_NOTES_ENABLED=0`），UI 端点默认关闭。

---

## 2. 系统架构

三层，边界清晰，各自可单独替换：

```
┌───────────────────────────── PhoNote 桌面壳（Electron）─────────────────────────────┐
│  main 进程                        │  renderer（四分区 UI）                          │
│  · globalShortcut 全局热键        │  · ① 图片区 ② 批注区 ③ 现有笔记区 ④ 讨论区      │
│  · desktopCapturer + 静默取帧     │  · Markdown 渲染 / 编辑 / 版本对比              │
│  · 托盘 / 悬浮提示 / 剪贴板兜底   │  · 本地缓存与离线草稿                            │
│  · 平台进程管理（可选本地拉起）   │                                                 │
└───────────────────────────────┬────────────────────────────────────────────────────┘
                                │ HTTP + X-API-Key（同一套 REST 契约）
┌───────────────────────────────▼────────────────────────────────────────────────────┐
│ 驱动平台（已有，Python / FastAPI）                                                   │
│  · 插件 pho_note：抓取入库 / 笔记 CRUD / 批注 / 版本 / AI 总结与对话 / 导出           │
│  · 复用：鉴权与作用域、错误信封、request_id、指标、日志、特性开关                     │
│  · 存储：SQLite（索引）+ 文件目录（图片）                                             │
└────────────────────────────────────────────────────────────────────────────────────┘
```

为什么不是"壳里直接操作 SQLite"：领域能力要能被 Agent 以工具形式调用（这是驱动平台存在的意义），所以真话只有一份，放在插件里；壳只是**又一个客户端**。这也让"以后做网页版/手机版"变成零成本。

### 2.1 部署形态（壳怎么连平台）

| 形态 | 说明 | 适用 |
|------|------|------|
| `remote` | 壳填 `base_url` + `api_key`，连已在跑的实例（`docker compose up` 或本机 uvicorn） | 默认；多设备共用一台 |
| `local-spawn` | 壳启动时拉起 `docker compose up -d`（或本机 `.venv` 的 uvicorn），退出可选停 | 单机"打开就能用" |
| 纯离线（后期） | 壳内置 Python sidecar（PyInstaller 打包） | 不装 Docker 的分发形态 |

P0/P1 只做前两种；`local-spawn` 用一条命令 + 健康轮询即可，不引入进程框架。

---

## 3. 领域模型

```
Course 1 ──< Note 1 ──< Revision
                ├──< NoteImage >── Capture
                ├──< Annotation（锚：整篇 / 单图 / 图上框）
                └──< Message（讨论区，关联某 Revision）

Capture 独立于 Note 存在：截图先落缓冲区，之后才被"任意多张"挑进某个笔记。
```

关键设计：

1. **Capture 是全局缓冲区**，未入笔记时 `note_id IS NULL`。`sha256` 唯一 → 同一张幻灯片截两次自动去重（提示"已存在"）。
2. **Note 与 Capture 多对多**（`note_images` 带 `position`）：同一张图可以进多个笔记（复习时重组）。
3. **Revision 只增不改**：`note_update` / `note_summarize` / `note_apply_patch` 都会先拍快照。回滚 = 把旧 `body_md` 写回并再拍一次（不改历史）。
4. **批注锚点必须可随文移动**：文本用 `TextQuoteSelector`（`quote` + `prefix` + `suffix`）而不是纯 offset —— 笔记被 AI 改过之后 offset 必然漂移。

### 3.1 表结构

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA user_version = 1;            -- 迁移靠它，按序 1→2→3

CREATE TABLE courses (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  instructor  TEXT,
  created_at  TEXT NOT NULL,
  archived    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE notes (
  id          TEXT PRIMARY KEY,
  course_id   TEXT REFERENCES courses(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  body_md     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE captures (
  id          TEXT PRIMARY KEY,
  sha256      TEXT NOT NULL UNIQUE,
  path        TEXT NOT NULL,          -- 相对 media/，便于整目录搬迁
  thumb_path  TEXT,
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  bytes       INTEGER NOT NULL,
  source      TEXT,                   -- 'screen' | 'window' | 'paste' | 'agent'
  app_title   TEXT,                   -- 截屏时的前台窗口标题（便于事后认课）
  created_at  TEXT NOT NULL,
  note_id     TEXT REFERENCES notes(id) ON DELETE SET NULL   -- 兼容旧形态；新代码以 note_images 为准
);

CREATE TABLE note_images (
  note_id     TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  capture_id  TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  PRIMARY KEY (note_id, capture_id)
);

CREATE TABLE annotations (
  id          TEXT PRIMARY KEY,
  note_id     TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,          -- 'note' | 'text' | 'image'
  anchor      TEXT NOT NULL,          -- JSON，见 §3.2
  body_md     TEXT NOT NULL,
  color       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  note_id     TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,          -- 'user' | 'assistant' | 'system'
  body        TEXT NOT NULL,
  revision_id TEXT,                   -- assistant 回复基于/产生的版本
  created_at  TEXT NOT NULL
);

CREATE TABLE revisions (
  id          TEXT PRIMARY KEY,
  note_id     TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  body_md     TEXT NOT NULL,
  reason      TEXT NOT NULL,          -- 'manual' | 'ai_summary' | 'ai_patch' | 'rollback'
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_notes_course   ON notes(course_id, updated_at DESC);
CREATE INDEX idx_captures_unused ON captures(note_id, created_at DESC);
CREATE INDEX idx_messages_note  ON messages(note_id, created_at);
```

### 3.2 批注锚点三种形态

```jsonc
// 整篇
{ "kind": "note", "anchor": { "type": "note" } }

// 文本：优先 quote（可随文移动），offset 仅作快速定位
{ "kind": "text", "anchor": {
    "type": "text",
    "quote": "中值定理的三个条件",
    "prefix": "…本节讲",
    "suffix": "，必须都满足",
    "offset": 128 } }

// 单图上的框选：rect 为归一化坐标 [x, y, w, h]，0..1，与显示尺寸无关
{ "kind": "image", "anchor": {
    "type": "rect",
    "capture_id": "cap_01H…",
    "rect": [0.12, 0.31, 0.44, 0.18] } }
```

`rect` 归一化的理由：缩略图与原图分辨率不同，坐标必须与显示无关；前端按 `element.clientWidth` 换算。

---

## 4. 平台插件接口（按驱动平台既有契约）

```
src/driver_platform/plugins/pho_note/
  __init__.py        # 导出 PhoNotePlugin
  plugin.py          # class PhoNotePlugin(Plugin): plugin_id="pho_note", version="0.1.0"
  store.py           # SQLite + 文件，纯同步；所有 SQL 只在这里
  tools.py           # 每个工具一个 Tool 子类
  llm.py             # Provider 协议 + openai / anthropic / manual
  api.py             # 给桌面壳用的 REST router（不进工具表）
  web/               # 可选：无构建静态页（浏览器兜底，默认关）
```

`Plugin.tools()` 返回下列工具；`contract_version = "1.0"`。

| 工具 | 作用 | 关键入参 |
|------|------|----------|
| `note_add_capture` | 登记一张图进缓冲区（幂等：同 sha256 直接返回已有） | `image_b64` \| `image_url`、`source`、`app_title` |
| `note_list_captures` | 列缓冲区 | `unused_only`、`course_id`、`limit` |
| `note_course_upsert` | 建/改课程 | `course_id?`、`name`、`instructor?` |
| `note_course_list` | 课程树（含每课笔记数） | `include_archived` |
| `note_compose` | **任意多张** Capture 组成新笔记 | `capture_ids[]`、`title`、`course_id` |
| `note_list` / `note_get` | 列表（按课程/关键词）/ 详情（正文+图+批注+版本） | `course_id?`、`q?`；`note_id` |
| `note_update` | 改标题/正文/课程（自动拍 Revision） | `note_id`、`title?`、`body_md?`、`course_id?` |
| `note_delete` | 删笔记（默认不删图，`purge_images=true` 才删） | `note_id`、`purge_images` |
| `note_attach_capture` | 给已有笔记追加图 | `note_id`、`capture_ids[]`、`position?` |
| `note_detach_capture` | 从笔记移除图（图片留在缓冲区） | `note_id`、`capture_id` |
| `note_annotate` | 加批注（三种锚） | `note_id`、`kind`、`anchor`、`body_md`、`color?` |
| `note_annotate_delete` | 删批注 | `note_id`、`annotation_id` |
| `note_summarize` | 生成/重写总结（落新 Revision） | `note_id`、`style`（`outline`/`exam`/`brief`） |
| `note_chat` | 讨论区一轮对话 | `note_id`、`message`、`stream?` |
| `note_apply_patch` | 应用 AI 建议（find/replace） | `note_id`、`edits[]`、`reason` |
| `note_ingest_ai_reply` | **manual 模式**：把网页版回答灌回来 | `note_id`、`text`、`as`（`summary`/`patch`/`message`） |
| `note_revisions` / `note_rollback` | 版本列表 / 回滚 | `note_id`；`note_id`、`revision_id` |
| `note_export` | 导出 Markdown（含图片相对路径），可 zip | `note_id`、`format` |
| `note_backup` | 把数据目录打包到 `backups/` | `label?` |

### 4.1 两个接口示例（Agent 真正看到的契约）

```json
{ "name": "note_compose", "contract_version": "1.0",
  "description": "把若干张已截取的图片组成一条笔记。图片来自缓冲区（note_id 为空的 captures）。",
  "input_schema": {
    "type": "object",
    "properties": {
      "capture_ids": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
      "title":       { "type": "string", "minLength": 1 },
      "course_id":   { "type": "string" }
    },
    "required": ["capture_ids", "title"],
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

### 4.2 错误码（沿用平台 `code` + `status_code` 表）

| code | 状态 | 场景 |
|------|------|------|
| `note_not_found` | 404 | 笔记 / 图片 / 版本不存在 |
| `ai_not_configured` | 400 | 调了 `note_summarize`/`note_chat` 但 `DRIVER_NOTES_LLM=off` |
| `ai_unavailable` | 502 | provider 超时、返回非 2xx、返回内容不是契约 JSON |
| `ai_reply_unparsable` | 422 | manual 灌回的回答解析不出 edits/summary |

其余一律复用：`invalid_arguments`(422)、`permission_denied`(403)、`tool_not_found`(404)。

### 4.3 REST 端点（给桌面壳，不进工具表）

| 方法 | 路径 | 用途 |
|------|------|------|
| `POST` | `/notes/api/captures` | `multipart/form-data` 上传截图（壳用），返回 capture 元数据 |
| `GET` | `/notes/api/captures/{id}/image` | 原图（`Cache-Control: immutable`，内容按 sha256 寻址） |
| `GET` | `/notes/api/captures/{id}/thumb` | 缩略图 |
| `GET` | `/notes/api/tree` | 课程 → 笔记树（一次拿全，省 N+1） |
| `GET` | `/notes/api/notes/{id}` | 笔记详情（正文 + 图 + 批注 + 最近 N 版本） |
| `PATCH` | `/notes/api/notes/{id}` | 改正文/标题（自动 Revision） |
| `POST` | `/notes/api/notes/{id}/chat` | 讨论区（`stream=true` 时 SSE） |
| `POST` | `/notes/api/notes/{id}/apply` | 应用 edits |
| `GET` | `/notes/api/notes/{id}/export` | Markdown / zip |
| `POST` | `/notes/api/backup` | 打包 `backups/` |

**为什么 REST 与工具两套入口**：工具给 Agent（要 schema、要审计、要走统一错误信封），REST 给界面（要 multipart 上传大图、要流式、要字节级缓存）。二者共用 `store.py`，业务逻辑只有一份。

**UI 挂载策略（不改插件契约）**：`Plugin` 现在只有 `tools()/setup()/teardown()`，没有挂载路由的能力。只有一个插件需要 UI，**不值得为此抽象契约**；由 `main.py` 显式挂载：

```python
# main.py，新增 4 行
if resolved.notes_enabled and resolved.notes_ui:
    from driver_platform.plugins.pho_note.api import build_notes_router
    app.include_router(build_notes_router(resolved))   # 内部已挂 /notes/api + 鉴权依赖
```

等第二个需要界面的插件出现，再把这条提升成 `Plugin.web()`（契约 1.1）。

---

## 5. 截图管线（壳里最核心的一段）

快捷键 → 静默取帧 → 上传 → 落缓冲区，全程不打断听课。Electron 里的真实调用链：

```js
// main.js —— 注册系统级热键（任何窗口前台都有效）
const { globalShortcut, desktopCapturer, session } = require('electron')

app.whenReady().then(() => {
  globalShortcut.register('Control+Shift+S', () => captureNow())
})

async function captureNow() {
  // 1) 静默选定主屏，避免弹"选择共享内容"对话框
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
  const primary = sources[0]

  session.defaultSession.setDisplayMediaRequestHandler((req, cb) => {
    cb({ video: primary })          // 只给主屏，且不给音频
  }, { useSystemPicker: false })

  // 2) 让隐藏的抓帧窗口拿一帧原始分辨率画面
  const res = await frameWindow.grabOnce()   // 内部: getDisplayMedia({video:{width:{ideal:3840}}}) → ImageCapture → canvas
  // 3) 上传（multipart，字段名 file），带上前台窗口标题便于认课
  const meta = await api.upload('/notes/api/captures', { blob: res.blob, app_title: res.foregroundTitle })
  notify(`已入缓冲区（${meta.width}×${meta.height}）`)
}
```

要点与坑：

1. **分辨率**：`desktopCapturer.getSources` 的 `thumbnail` 会被缩放；要原始像素必须 `getDisplayMedia` 抓流后 `ImageCapture`/`canvas` 取帧（本设计走这条）。
2. **多显示器**：枚举 `sources`，热键默认主屏；`Ctrl+Shift+D` 切下一块屏；配置项记忆选择（`settings.json`）。
3. **DPI 缩放**：Windows 缩放 125%/150% 时 `getDisplayMedia` 给的是物理像素，尺寸以实际帧为准，不要用 `screen.getPrimaryDisplay().size`。
4. **剪贴板兜底**：`globalShortcut` 注册失败（被别的软件占用）或用户用 `Win+Shift+S` 时，监听窗口 `paste` 事件直接吃剪贴板图片。
5. **不弹窗打断**：截图后只发一个 3 秒托盘通知，缓冲区在图片区里标记"新增"。**不要**每次截图都强制切到 PhoNote 窗口——这是这类工具最容易做错的地方。
6. **隐私**：截图只在本地与自己的平台之间流动；`manual` 模式下也只有你主动复制才离开本机。

---

## 6. 四分区界面

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ PhoNote   课程: [高数 · 第 3 讲 ▾]      Ctrl+Shift+S 截图   ⚙   [备份]   ● 在线 │
├──────────────┬──────────────────────────────────┬──────────────────────────────┤
│ ① 图片区      │ ③ 现有笔记区                      │ ④ 讨论区                      │
│              │                                  │                              │
│ 未归档 3 张   │ # 中值定理                        │ 你：把第二段的证明补全        │
│ ┌──┐┌──┐┌──┐ │                                   │ AI：好的，补充如下…           │
│ │  ││  ││  │ │ 若 f 在 [a,b] 连续 …[1]          │ ─────────────────────        │
│ └──┘└──┘└──┘ │                                   │ [应用修改] [重答] [复制]      │
│ [组成笔记]    │ [1] 老师强调这三个条件必须同时满足 │                              │
│              │                                   ├──────────────────────────────┤
│ 本课 12 张    │ ─────────────────────────────     │ ② 批注区                      │
│ ┌──┐┌──┐┌──┐ │ ✎ 编辑    🕘 版本   ⤓ 导出        │ · 图1 框选「ε-δ」：这里没听懂 │
│ │  ││  ││  │ │                                   │ · 正文[1]：考试重点           │
│ └──┘└──┘└──┘ │                                   │ [+ 新批注]                    │
└──────────────┴──────────────────────────────────┴──────────────────────────────┘
```

| 区 | 数据来源 | 写操作 | 交互要点 |
|----|----------|--------|----------|
| ① 图片区 | `GET /notes/api/tree` + `/captures` | 拖拽调整、多选 `POST /notes/api/notes`（compose） | 多选框 + 「组成笔记」；已入笔记的图显示所属笔记角标；右键「删除/下载」 |
| ③ 笔记区 | `GET /notes/api/notes/{id}` | `PATCH`（防抖 800 ms 自动存）、版本切换、导出 | 预览/编辑双态；批注以角标 `[n]` 内联；版本对比用左右 diff |
| ④ 讨论区 | `GET /notes/{id}` 里的 messages | `POST /chat`（SSE）、`/apply` | AI 回复里的 `edits` 渲染成「建议卡片」，逐条勾选应用；保留原始消息 |
| ② 批注区 | 同笔记详情 | `POST/DELETE annotations` | 选中文本/框选图片后浮出"加批注"按钮；点击批注滚动定位并高亮锚点 |

布局自适应：窄窗（<1200px）时 ② 收进右侧抽屉，① 变成顶部横条。

---

## 7. AI 接入

### 7.1 Provider 协议

```python
# llm.py
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

三个实现：

| 实现 | 何时用 | 关键点 |
|------|--------|--------|
| `OpenAICompatibleProvider` | `DRIVER_NOTES_LLM=openai` | 一把 `base_url` 覆盖 DeepSeek / 通义 / Kimi / Ollama / vLLM；多模态用 `image_url` + `data:` URI |
| `AnthropicProvider` | `DRIVER_NOTES_LLM=anthropic` | `messages` + `image`(base64) 块；system 单独字段 |
| `ManualProvider` | `DRIVER_NOTES_LLM=manual` | **不联网**：把上下文包成文本返回（见 7.3），由用户粘贴到网页版 |

配置（默认全关）：

```
DRIVER_NOTES_LLM=off|openai|anthropic|manual
DRIVER_NOTES_LLM_BASE_URL=https://api.deepseek.com/v1
DRIVER_NOTES_LLM_API_KEY=...
DRIVER_NOTES_LLM_MODEL=deepseek-chat
DRIVER_NOTES_LLM_MAX_IMAGES=6          # 单次喂给模型的最大图片数
DRIVER_NOTES_LLM_MAX_PX=1024           # 送模型前的长边上限（另存原图）
```

### 7.2 让 AI "修改"而不是"重写全文"

模型统一输出 **edits 协议**（增量补丁），平台负责校验与应用：

```json
{ "summary": "本节课讲了中值定理的三个条件与两个推论。",
  "edits": [
    { "find": "若 f 在 [a,b] 连续", "replace": "若 f 在闭区间 [a,b] 上连续，在开区间 (a,b) 内可导" }
  ] }
```

- `find` 必须在正文里**唯一出现**，否则该条标记为"未应用"交给人处理；
- 应用成功 → 拍 Revision（`reason='ai_patch'`）→ 可一键回滚；
- 比"让模型重写全文"省 token、可审计、diff 干净；也避免模型顺手删掉你写的批注段落。

提示词里要固定约束：只改 `find` 命中的片段、不新增标题层级改变、保留 `[n]` 批注角标。

### 7.3 manual 模式（网页版免费/付费都能用）

`note_summarize` 在 manual 下返回的不是总结，而是**上下文包**：

```json
{ "mode": "manual",
  "bundle": {
    "prompt": "你是我的复习助手。下面是《高数》第 3 讲的课件截图与我的批注…请按「定义 / 定理 / 易错点」三节总结，输出 JSON：{summary, edits}。",
    "note_md": "…当前正文…",
    "annotations": ["…"],
    "images": ["cap_01H…（第 1 张）", "cap_01H…（第 2 张）"]
  },
  "copy_text": "（完整可粘贴文本，含图片编号说明）",
  "image_dir": "D:\\PhoNote\\exports\\note_xxx\\" }
```

流程：壳把 `copy_text` 放进剪贴板 + 打开导出目录（图片已复制好，可一拖进对话）→ 你贴给 ChatGPT/Claude 网页版 → 把回答复制回来 → `note_ingest_ai_reply(note_id, text="…", as="auto")` 解析成 summary/edits 并预览应用。

为什么不做网页版自动化：没有官方 API，无头浏览器驱动既违反条款又会随前端改版而碎。**manual 是唯一能长期稳定的"免费"路径**，而且永不失效。

### 7.4 成本与上下文控制

1. 送模型的图先缩到长边 1024（WebP q=0.8），原图不参与；
2. 单次最多 `MAX_IMAGES=6`；更多时按"每 6 张先局部总结，再合并"（map-reduce，两次调用）；
3. 正文超过 8k 字符时只送"标题行 + 与问题最相关的段落"（用简单关键词打分，不引入 embedding）；
4. 每次调用把 `tokens_in/out` 写进 `messages`（可选字段），便于月度成本复盘。

---

## 8. 存储、备份与迁移

```
D:\PhoNote\                        # DRIVER_NOTES_DIR，独立目录
├── phonote.db                     # SQLite（WAL）
├── media\2026\11\<sha256>.webp    # 原图（按内容寻址，天然去重）
├── thumbs\<sha256>.webp           # 缩略图（长边 320）
├── exports\note_<id>\             # manual 模式的图片清单 + prompt.txt
└── backups\phonote-20261110-2130.zip
```

- **备份**：`note_backup` 用 `zipfile` 把 `phonote.db`（先 `VACUUM INTO` 一份一致性快照）+ `media/` 打包；不打包 `exports/`。
- **恢复**：解开到新目录 → 改 `DRIVER_NOTES_DIR` 指向它即可（路径都是相对 `media/` 的，可整体搬迁）。
- **迁移**：`PRAGMA user_version` 顺序升级；每步一个函数 + 一条测试（用 `tmp_path` 建 v1 库升到当前版本再断言）。
- **并发**：WAL + 单写者。壳与平台分离时，只有平台进程写库，壳只读缓存。

---

## 9. 与驱动平台的对齐（几乎白拿）

| 机制 | 用法 |
|------|------|
| 鉴权 | 工具名即作用域，精确匹配：`DRIVER_API_KEYS="pho-key:note_get\|note_list\|note_export,full-key"` |
| 错误信封 | `raise PlatformError(...)` → `{"error":{code,message,details,request_id}}` |
| 可观测性 | 自动获得 `driver_tool_calls_total{tool="note_compose"}` 与 `tool_call` 日志 |
| 特性开关 | `DRIVER_NOTES_ENABLED=0`、`DRIVER_NOTES_UI=0`（UI 端点默认关，壳走 REST 时再开） |
| 存储位置 | `DRIVER_NOTES_DIR`（默认 `D:\PhoNote`；容器里映射 `/data/phonote`） |
| 契约 | `contract_version="1.0"`；加可选字段=minor，删字段/改语义=major |

---

## 10. 分期路线（每期都可验收）

| 期 | 范围 | 验收（可执行的判据） |
|----|------|----------------------|
| **P0** | 仓库骨架 + 平台插件三个工具（`note_add_capture`/`note_compose`/`note_get`）+ `store.py` + DB 迁移 v1；Electron 壳能注册热键、静默截主屏、上传、图片区显示 | `pytest tests/test_pho_note_store.py tests/test_pho_note_tools.py` 全绿；壳里按 `Ctrl+Shift+S` 后图片区出现缩略图，`GET /v1/tools` 能看到三个工具；重启后数据还在 |
| **P1** | 课程树 + 笔记 CRUD + 四分区（可编辑）+ 文本/图片批注 + 自动 Revision | 手工走完：建课 → 截 3 张 → 组笔记 → 改正文 → 加两种批注 → 重启 → 内容与角标都在；`note_rollback` 能回到上一版 |
| **P2** | `note_summarize` + 讨论区 + edits 应用 + 版本 diff | 一次真实总结落成 Revision；AI 给 2 条 edits，1 条应用、1 条故意给不唯一 `find` 并正确标"未应用"；回滚验证 |
| **P3** | manual 模式 + 备份/恢复 + 导出 + 多显示器/窗口选择 + 托盘与设置页 | 断网下走完 manual 全流程；`backup` 出 zip，解压到新目录换 `DRIVER_NOTES_DIR` 后数据完整 |

P0 建议一次提交：`feat(pho-note): 截图入缓冲区到笔记的最小闭环`。

---

## 11. 风险与已知限制

| 风险 | 影响 | 应对 |
|------|------|------|
| Electron 首次 `npm install` / 打包需外网 | 装不上就开不了发 | 先配国内镜像；`electron-builder` 只做最终打包，开发期 `npm start` 即可 |
| 全局热键被占用 | 快捷键无反应 | 注册失败即提示并提供"剪贴板兜底"；设置页可改键 |
| 多显示器 + 高 DPI | 截图分辨率/坐标错 | 以实际帧尺寸为准；`rect` 用归一化坐标（已在设计里） |
| 截图含隐私（人脸、付费内容） | 数据泄露 | 默认只存本地；只有用户点"总结"才发送；manual 模式由人决定粘贴内容 |
| SQLite 并发写 | 壳与平台同时写会 `SQLITE_BUSY` | 只让平台写；壳只读缓存；WAL + `busy_timeout=5000` |
| 笔记越写越大 | 上下文超限、成本上升 | §7.4 的分段总结与截断策略；导出后归档 |
| 平台插件默认关 | 用户装了壳却调不通 | 壳启动做一次"能力探测"（`GET /v1/tools` 看有没有 `note_*`），没有就给出一键配置指引 |

明确不做（现阶段）：多人协作、实时同步、自动录屏转写、笔记全文检索（先 `LIKE`，需要再上 FTS5）、浏览器端全局热键。

---

## 12. 未决（不阻塞 P0）

1. 多设备同步：只做"备份 zip + 手动搬"，还是接 WebDAV/OneDrive？（倾向先手动）
2. 图片是否长期保留原图（磁盘 ×2）？默认只留 WebP 1600。
3. 是否需要"讲次"层级（课程 → 第 3 讲 → 笔记），还是笔记标题里写讲次就够？
4. 远程平台是否需要为壳单独发一把只读钥匙（`note_get|note_list`）以免壳持有全权钥匙？

---

## 13. 参考实现（分类；**我未逐个核实其当前维护状态与许可证**）

| 类型 | 举例 | 可借的点 |
|------|------|----------|
| 截图/标注 | ShareX、Flameshot、Snipaste（闭源）、PowerToys Text Extractor | 截图后的即时标注手感、快捷键默认值、剪贴板兜底 |
| 笔记 + AI | Obsidian 的 Copilot 类插件、Logseq、SiYuan、Joplin、Trilium | 本地优先、Markdown 为真话、插件化扩展 |
| 文档问答 | anything-llm、khoj、Reor | 分段总结 + 引用溯源（"这句来自第 3 张图"） |
| 网页/视频摘要 | BibiGPT、Glarity、YouTube Summary | 一键摘要的交互与配额控制 |
| MCP 生态 | 各家 obsidian/notion MCP server | **把笔记暴露成工具给 Agent** —— 正是本设计平台侧的做法 |
| 桌面壳 | Electron + `desktopCapturer` / `globalShortcut` 官方示例 | 静默取帧与热键注册的坑 |

以上名称来自记忆，作为架构对照可以，不要当结论引用。
