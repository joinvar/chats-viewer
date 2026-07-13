# TODO：使用统计页面

> 状态：未实现（曾做过一版后按需求撤销，需要时再生成）  
> 目标：在 chats-viewer 中增加「使用统计」视图，按时间查看 Agent / 对话 / 模型 / Token。

---

## 产品约定

- **入口**：顶栏「浏览 | 统计」切换（`appMode: browse | stats`），不引入 react-router。
- **Agent** = 工具来源 `ToolSource`：Claude / Cursor / Codex / Grok。
- **对话** = session 数；消息数一并展示。
- **模型** = assistant / session meta 中的 `model`。
- **Token** = Claude JSONL 的 `message.usage`（`input_tokens` / `output_tokens` / cache 读写）；其它来源多为 0，UI 注明「部分来源无 token 数据」。
- **时间**：`1d` / `1w` / `1m` / 自定义起止日期。
- **图表**：趋势可切换曲线 / 柱状；Agent、模型用分布条/柱；要有动画，但切换筛选要快。

---

## 架构

```
顶栏「统计」→ StatsPage
                │
                ▼
     GET /api/stats?source=&since=&until=
                │
                ▼
     server/src/stats.ts
       · 枚举各工具会话文件
       · 流式扫 JSONL（不走完整 parseSession）
       · 按文件 mtime 缓存扫描摘要
       · 内存聚合 byAgent / byModel / timeline
                │
                ▼
     recharts 渲染 + 现有 CSS 变量（奶油底 / 珊瑚强调）
```

### API 响应形状

```ts
{
  since, until, source,  // source: all | claude | cursor | codex | grok
  totals: {
    sessions, messages,
    tokens: { input, output, cacheRead, cacheCreation, total },
    sessionsWithTokens, sessionsWithoutTokens,
    agentCount, modelCount
  },
  byAgent:  [{ key, label, sessions, messages, tokens }],
  byModel:  [{ key, sessions, messages, tokens }],
  timeline: [{ t, sessions, messages, tokens }]
  // 桶：时间跨度 ≤2 天按小时，否则按天
}
```

---

## 实现清单

### 后端

- [ ] 新增 `server/src/stats.ts`
  - [ ] 枚举 Claude / Cursor / Codex / Grok 会话文件（可参考 `search.ts` / `listCodexFiles` / `listGrokFiles`）
  - [ ] 各源轻量扫描：时间戳、messageCount、model、Claude `usage`
  - [ ] 会话与 `[since, until]` 相交才计入
  - [ ] **按文件路径 + mtime 缓存扫描结果**（切换时间/来源只做内存聚合，避免反复读 JSONL）
  - [ ] corpus 短 TTL（约 60s）+ 结果缓存 `source|since|until`
  - [ ] `invalidateStatsCache()`，在删除 project/session 时调用
- [ ] `server/src/index.ts` 注册 `GET /api/stats`
- [ ] `server/src/types.ts`（及 client 镜像）增加 `StatsResult` 等类型

### 前端

- [ ] `client` 安装 `recharts`
- [ ] `client/src/api.ts` 增加 `api.stats(source, since, until)`
- [ ] 新增 `client/src/components/StatsPage.tsx`
  - [ ] 时间段 / 来源 / 曲线|柱状 控件（风格对齐现有 `unified-seg`）
  - [ ] 四张汇总：Agent、对话、模型、Token
  - [ ] 活动趋势（双轴：对话 + Token）
  - [ ] Agent 分布、模型分布（Top N + 其它）
  - [ ] 客户端结果缓存 + 预取常用 `1d/1w/1m × 各来源`，切换近乎即时
  - [ ] 图表保留动画（约 360–420ms ease-out），勿为性能永久关掉
- [ ] `App.tsx`：`appMode` + 顶栏切换；stats 时隐藏三列浏览 UI
- [ ] `styles.css`：统计页样式，沿用 `--bg` / `--accent` 等变量，避免另起仪表盘风

### 性能与内存（实测经验）

- 首次冷扫可能数秒；之后筛选切换应在 **1ms 级**（内存聚合）。
- 缓存只存会话摘要，不存整份 JSONL；约千级会话额外内存大约 **1–2 MB**。
- 预设时间的 `until` 建议对齐到整分，避免每次 `new Date()` 打穿缓存 key。

### 明确不做

- 不把 usage 挂到每条 `AssistantEntry` 的 transcript 展示。
- 不估算 Cursor / Codex / Grok 的虚构 token。
- 不引入路由库。

---

## 关键文件（实现时）

| 路径 | 作用 |
|------|------|
| `server/src/stats.ts` | 扫描与聚合 |
| `server/src/index.ts` | 路由 |
| `server/src/types.ts` / `client/src/types.ts` | 类型 |
| `client/src/api.ts` | 客户端 API |
| `client/src/components/StatsPage.tsx` | 统计页 UI |
| `client/src/App.tsx` | 模式切换 |
| `client/src/styles.css` | 样式 |
| `client/package.json` | `recharts` |

---

## 触发说明

需要落地时，直接说「按 `TODO-使用统计.md` 实现统计页」即可。
