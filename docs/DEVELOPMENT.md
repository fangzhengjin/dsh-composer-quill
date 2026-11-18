# 开发与验证

> 适用版本：0.14.1 ｜ 无构建步骤：宿主与浏览器两端都是手写 ESM

## 1. 目录结构

```
dsh-composer-quill/
├── index.js            宿主：三条路由、缓存、模型调用、SSE
├── client.js           浏览器：dock 行、灰字层、状态机、设置卡片
├── cordis.patch.yml    把包插入 Cordis 启动图（用包名，不用相对路径）
├── package.json        dsh.bundle.patch / dsh.client 声明、engines 门禁
├── locale/{zh,en}.json 插件市场的标题与描述（UI 文案在 client.js 内联）
├── docs/               架构、协议、本文件
├── dev/                开发工具（不随包发布）
│   ├── harness/        浏览器模拟器（假 DSH + 假 fetch）
│   └── verify_*.py     真机验证脚本（Playwright）
├── smoke-test.mjs      不依赖宿主的单元/集成测试（Node 直接跑）
└── icon.svg
```

验证工具在 `dev/` 下（不随包发布，详见 [dev/README.md](../dev/README.md)）：

```
dev/harness/         模拟器：src.js → esbuild → bundle.js（用 file:// 打开）
dev/verify_daily.py  22 个行为场景（模拟器驱动）
dev/verify_*.py      真机脚本：空行锚点、设置页、刷新复用、流式重绘……
```

## 2. 安装与运行

```powershell
# 链接进某个 profile（示例用 ghosttest）
$dsh = "%USERPROFILE%\.dsh\desktop-preview-test\app\resources\runtime\cli\bin\dsh.cmd"
& $dsh profile add ghosttest            # 若无
& $dsh plugin add --link "C:\…\dsh-composer-quill" --profile ghosttest

# 启动一个隔离实例（不干扰桌面端）
& $dsh --profile ghosttest --port 0 --no-open
# 输出 dsh web: http://127.0.0.1:PORT/?token=…  → 用 Playwright 打开
```

**改动必须彻底重启 DSH**：客户端 bundle 按 rev 钉在启动图里，刷新页面仍加载旧包。日志里的 `build` 字段是唯一可靠的版本证据：

```powershell
Get-Content "$env:USERPROFILE\.dsh\composer-quill.log" -Tail 20 | Select-String '"build"'
```

## 3. 三层测试

### 3.1 单测（`node smoke-test.mjs`）

不依赖 DSH，直接用假的 `ctx` / 假 `res` 驱动真实代码。覆盖：

- 解析器：`parseCandidates` / `parseComposed` / `parseComposeReply` / `parseSentence` / `joinSentence` / `shorten`
- 会话数据：`transcriptOf`（含 emoji 不爆、保留最新用户消息）、`historyOf`、`maskSecrets`
- 路由：鉴权矩阵、SSE 帧时序、缓存命中、单飞（数字/流式各一条）、日志轮转
- 客户端纯函数：`followRemainder`、`bestHistoryMatch`、`normalizeConfig`、建议持久化、`hydrate`

约 40 条断言，`ALL CHECKS PASSED` 是唯一通过标志。

### 3.2 模拟器（`python dev/verify_daily.py`）

`dev/harness/` 在浏览器里模拟 DSH 的 composer（Lexical 风格的 `<p><span>` 结构 + 假 fetch）。改 `src.js` 后必须重建：

```powershell
cd dev/harness; node node_modules/esbuild/bin/esbuild src.js --bundle --format=iife --target=chrome120 --outfile=bundle.js
```

22 个场景（S1–S19）覆盖：逐字输入、快速连打、Esc 抑制、失败重试、长草稿、切会话、超短草稿、空行锚点、历史补全、逐词/整条采纳、清空重弹、行常驻、覆盖区间零调用、流式增长。

### 3.3 真机脚本（`python dev/verify_*.py <url>`）

每个脚本自带断言与截图，按需跑：

| 脚本 | 验证点 |
| --- | --- |
| `verify_align[_cases].py` | 灰字与正文行盒的像素对齐 |
| `verify_emptyline.py` | 空行（`<br>` 之后）灰字锚点 |
| `verify_clear_rearm.py` | 采纳后清空是否重新弹出 |
| `verify_fresh_start.py` | 刚启动时行是否可用、会不会卡「补写中」 |
| `verify_reuse_reload.py` | 刷新后是否 0 请求复用已存建议 |
| `verify_no_storm.py` / `verify_covered.py` | 请求次数（无取消风暴、覆盖区间零调用） |
| `verify_settings_ui.py` | 设置卡片渲染与持久化 |
| `quality_probe.py` | 固定 5 条草稿的建议质量对比（改动提示词/排序前后各跑一次，diff 输出） |
| `verify_stream_repaint.py` | 流式期间灰字是否增长（模型吐得快时不稳定，以 S19 为准） |

## 4. 调试

### 4.1 日志

`<profile>/composer-quill.log`（超过 2 MB 轮转为 `.log.1`）。宿主事件：

| 事件 | 含义 |
| --- | --- |
| `request` / `stream` / `result` / `first-delta` | 一次预测的生命周期 |
| `cancelled` | 请求被取消（客户端断开或新请求顶替） |
| `error` / `compose-stream-error` | 失败（含状态码与被遮蔽前的消息） |
| `history` / `history-error` | 历史拉取 |
| `not-live`（客户端上报） | 会话未在宿主加载 → 退避中 |
| `cache-restored` | 启动时从磁盘恢复了多少条缓存 |
| `cache-...` / `client-row` | 缓存与客户端包探测 |

浏览器事件（经 `/beacon` 落到同一文件）：`dock`（挂载时的 props 概况）、`dock-state`（每次判定变化，含 `phase/kind/items/nextActive/pendingCompose/pendingNext/draftEmpty/running`）、`paint`、`hydrated`、`reused`/`dedupe`/`covered`、`not-live`、`render-error`。

### 4.2 常见症状 → 排查路径

| 症状 | 先看什么 |
| --- | --- |
| 行里只有快捷键提示 | `dock-state`：`items` 是否为 0、`running` 是否为 true、`draftEmpty` 是否符合预期 |
| 一直「补写中…」 | `phase` 是否卡在 `loading`；有没有 `error`；`pendingNext` 是否在 manual 模式 |
| 有请求但没结果 | `request` 之后有没有 `first-delta`；`error` 的状态码（409 = 会话没加载） |
| 灰字不增长 | 确认 `paint` 事件是否随 delta 出现（painter 是否订阅了 store） |
| 采纳后又请求一次 | 看 `dedupe`/`reuse` 是否命中；`lastRequested` 认领是否被提前清空 |
| 重启后建议没了 | `cache-restored` 的条目数、`composer-quill-cache.json` 是否可写 |
| `/history` 恒为 0、`next` 报 `empty-thread` | 看日志的 `events` 字段：等于 3（只有引导事件）= 宿主没持有该会话的 transcript，插件无能为力（见 ARCHITECTURE 已知限制 1） |

### 4.3 环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_COMPOSER_QUILL_NO_CACHE=1` | 关闭宿主磁盘缓存（读与写都跳过）。单测默认开启，避免污染真实缓存 |

## 5. 发布清单

1. 改 `client.js` 的 `BUILD` 与 `package.json` 的 `version`（必须同步，`build` 是排障时的版本凭证）。
2. `node smoke-test.mjs` 全绿。
3. `python verify_daily.py` 全绿（改过 `_harness/src.js` 要先重建 bundle）。
4. 相关真机脚本跑一遍，确认没有回归。
5. 更新 `docs/` 与 `README.md` 的变更表。
6. 提醒使用者**彻底退出 DSH 再打开**。

## 6. 容易踩的坑

1. **按行号切代码会连声明一起删掉**——本仓库踩过一次（`retriedFor` 被误删导致 `ReferenceError`）。改完必须 `node --check` 并跑单测。
2. **CRLF**：脚本里做多行替换前先 `.replace(/\r\n/g, '\n')`，否则模式匹配不到。
3. **测试污染真实缓存**：宿主缓存会落盘，单测必须带 `DSH_COMPOSER_QUILL_NO_CACHE=1`。
4. **渲染期副作用**：任何 `fetch`/上报都要放 effect，否则并发渲染会重复发送。
5. **不要把共享工作绑在单个请求的 AbortSignal 上**：浏览器每次按键都会 abort 上一个流。
6. **`final` 是权威值**：客户端显示必须以它为准，不能用增量拼出来的文本。
