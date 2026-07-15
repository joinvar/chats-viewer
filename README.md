# Chats Viewer

本地查看 `Claude Code`、`Cursor`、`Codex`、`Grok` 历史对话的网页应用。直接只读扫描本地会话文件，不修改原始记录。

## 启动

在项目根目录 `D:\code\chats-viewer` 下，二选一。

### 开发模式（推荐）

改代码自动热更，端口 `5173`：

```bash
npm run dev
```

打开 http://localhost:5173 。

### 生产模式

构建后单进程跑，端口 `4000`：

```bash
npm run build     # 第一次或代码更新后跑
npm start
```

打开 http://localhost:4000 。

> 两种模式不要同时开，会抢端口。

### 关闭

在启动它的那个终端窗口里按 **`Ctrl + C`**，有时要按两下。看到 `^C` 或者命令提示符回来了就是停了。

如果不小心把启动用的终端窗口直接关了（没按 Ctrl+C），进程会留在后台，下次启动会报：

```
Error: listen EADDRINUSE :::4000
```

这时在 **PowerShell** 里按端口找 PID 杀掉：

```powershell
Get-NetTCPConnection -LocalPort 4000 | Select-Object OwningProcess
# 输出的 OwningProcess 就是 PID，比如 17148，然后：
taskkill /PID 17148 /F
```

5173 同理。或者偷懒点直接杀所有 node 进程（**会连带关掉其它用 node 的程序，谨慎**）：

```powershell
taskkill /IM node.exe /F
```

### 首次安装依赖

仓库新克隆下来时：

```bash
npm run install:all
```

会把 root、`server/`、`client/` 三个包的依赖都装好。

## 使用

界面三列，列之间的灰条可以左右拖拽调节宽度，宽度会记住。

- **顶部来源切换**  
  `Claude Code`、`Cursor`、`Codex`、`Grok` 四种来源可随时切换。另外有 **`全部（混合）`** 一项，把各工具汇到一起：
  - 选「全部」后顶栏出现 **按对话 / 按项目** 切换。
  - **按对话**：所有工具的会话拉平成一条按时间倒序的总流，每条左侧带工具图标，点开直接看 transcript。
  - **按项目**：所有工具的项目合并按最近修改排序，项目和会话行都带工具图标。
  - 顶部搜索在「全部」下会跨所有工具一起搜，命中结果带上各自来源。
  - 这套混合视图是独立的，不影响原来按单一工具浏览的模式。

- **左列 · Projects**  
  按来源列出项目/工作区，按最近修改排序。点击切换。

- **中列 · Sessions**  
  当前项目下的所有 session，按结束时间倒序。标题优先用 `customTitle`，退而求其次用 agent 名、首条用户消息、`sessionId`。

- **右列 · Transcript**  
  渲染所选 session。
  - 用户/助手消息、`thinking`（默认折叠）、`tool_use` + 入参、`tool_result` + 超过 20 行自动折叠、attachment chip。
  - 消息里的 `<system-reminder>` 会被折叠成小 chip，避免遮挡正文。
  - 右上角 **⎇ Tree** 按钮打开分支树视图：看到完整的父子链和所有 rewind 产生的分支点；点任意节点，把 transcript 切换到从根到该节点的路径；非当前路径上的节点会变暗。
  - 如果某条 assistant 的 `tool_use` 启动过 Agent（sidechain），sub-conversation 会折叠在那条 tool_use 下面。
  - `Codex` / `Grok` / `Cursor` 会显示 `tool_use` / `tool_result` / `thinking`，并支持复制 resume 命令（`codex resume …` / `agent --resume=…` / `cursor-agent --resume=…`）。

- **顶部搜索框**  
  跨所有项目的所有 session 做子串匹配（大小写无关）。匹配 user/assistant 正文和 thinking，不匹配 metadata。点搜索结果会跳到对应 session 并滚动到命中位置（高亮一下）。首次搜索会走全量索引，稍慢；之后按文件 mtime 增量更新。

## 架构

```
┌───────────────────────────────┐  /api  ┌───────────────────────────────┐
│ 浏览器 · React + Vite          │ ─────▶ │ Node · Express (server/)      │
│                                │ ◀───── │ 解析 JSONL，in-memory 搜索索引│
└───────────────────────────────┘        └──────────────┬────────────────┘
                                                        │ 只读
                                                        ▼
                                        ~/.claude/projects/<项目>/*.jsonl
```

- `server/` · Express + TypeScript，端口 4000。入口 `src/index.ts`，路由：
  - `GET /api/projects`
  - `GET /api/projects/:id/sessions`
  - `GET /api/sessions/:projectId/:sessionId`
  - `GET /api/all/projects`、`GET /api/all/sessions` —「全部（混合）」视图，各工具合并并标注 `source`
  - `GET /api/search?q=...`（`source=all` 时跨所有工具）
- 数据源：
  - `Claude Code` → `~/.claude/projects/<项目>/*.jsonl`
  - `Cursor` → `~/.cursor/projects/<项目>/agent-transcripts/<chatId>/<chatId>.jsonl`
  - `Codex` → `~/.codex/sessions/YYYY/MM/DD/*.jsonl`
  - `Grok` → `~/.grok/sessions/<encoded-cwd>/<sessionId>/`（读 `updates.jsonl` + `summary.json`）
- `client/` · React + Vite + TypeScript，端口 5173。dev 模式下 `/api` 代理到 4000。
- 生产模式下 server 进程同时托管 `client/dist`，一个端口搞定。

## 端口冲突

```
Error: listen EADDRINUSE :::4000
```

多半是之前的进程没退干净。PowerShell 下：

```powershell
Get-NetTCPConnection -LocalPort 4000 | Select-Object OwningProcess
# 输出的 OwningProcess 就是 PID，然后：
taskkill /PID <那个数字> /F
```

5173 同理。参考上面 **关闭** 一节。

## 目录结构

```
chats-viewer/
├── package.json          # 根脚本：dev / build / start
├── README.md
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts      # Express 入口
│       ├── types.ts      # 共享类型
│       ├── projects.ts   # 列项目、列 session、slug 解码
│       ├── all.ts        # 「全部（混合）」多工具合并、按时间总排序
│       ├── parser.ts     # Claude JSONL → Transcript，含分支树 / sidechain
│       ├── cursor.ts     # Cursor 适配
│       ├── codex.ts      # Codex 适配
│       ├── grok.ts       # Grok 适配（~/.grok/sessions）
│       └── search.ts     # 全量索引 + mtime 增量（含跨工具聚合搜索）
└── client/
    ├── package.json
    ├── vite.config.ts    # dev 代理 /api → :4000
    ├── tsconfig.json
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx       # 三列布局 + 拖拽分隔条
        ├── api.ts
        ├── types.ts
        ├── util.ts
        ├── styles.css
        └── components/
            ├── ProjectList.tsx
            ├── SessionList.tsx
            ├── SourceSelect.tsx  # 顶部来源/「全部」切换
            ├── ToolIcon.tsx      # 各工具的共享图标
            ├── Transcript.tsx
            ├── TreeView.tsx
            ├── Entry.tsx
            ├── ToolUse.tsx
            ├── ToolResult.tsx
            ├── Thinking.tsx
            ├── Sidechain.tsx
            ├── Markdown.tsx
            ├── SearchBar.tsx
            └── Splitter.tsx
```

## 已知限制

- Claude Code 项目目录名是 Claude 自己编码的（Windows 的 `D:\code\chats-viewer` → `D--code-chats-viewer`），反解回路径是 best-effort——如果原始路径里就有 `-`，显示的 cwd 可能不准确，但 session 里记录了真实 `cwd`，进入 session 后可以看到。
- Codex session 按日期存放，不按项目分目录；这里会按 session 里的 `cwd` 重新聚合成项目视图。
- Grok 按工作区 URL 编码分目录（如 `D%3A%5Ccode%5Cchats-viewer`）；对话以 `updates.jsonl` 为准，标题与模型信息读 `summary.json`。删除只动 `~/.grok/sessions/...`，不会碰 skills/config。
- 搜索是纯子串匹配，不做分词、不做模糊匹配，中英文都按字面匹配。
- 目前没有虚拟滚动，单 session 消息数量特别大（几千条）时渲染会慢。
