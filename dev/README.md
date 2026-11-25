## 未解：跨用例的「旧草稿 + 新尾巴」

有个失败反复出现过一次：`trailing newline` 那条断言拿到 `items=["帮我把这段日志，请附上完整日志。"]`——草稿前缀来自**上一个用例**，尾巴是本用例流式返回的。

已排除：

| 猜测 | 结论 |
| --- | --- |
| `__predictRoute` 被重复设置 | 否，两个版本里都是 `set`，没变过 |
| `effectQueue` 残留 | 否，清成 0 之后照样失败 |
| 上一个用例留下的在途请求写回 | 否，让假 fetch 认 `init.signal` 之后照样失败 |
| `clear()` 没清流式暂存（`streamBase`/`acc`） | 已补，仍失败 |

能确定的是：慢用例结束时 ghost store 已被清空（`phase=idle draft="" items=[]`），但下一个用例仍然拼出旧草稿。也就是说旧草稿不是从 store 恢复的，而是**在第二个用例自己的请求里被当成 `forDraft` 用的**。

要往下查，需要在下一次渲染时打印 `streamStart` 的入参和 `props()` 的产物，看是谁先把旧草稿传进去。在那之前：

- 一个用例结束前，把它发出去的请求等回来，可以避开这个坑
- 看到「草稿来自别的用例」这种失败，先怀疑夹具，而不是产品逻辑

`honourSignal()` 这个包装已经保留：它让假 fetch 像真的一样响应 abort，即使这个特例不是它造成的。

## 探针

三个小工具，用来在**不连真机**的情况下看清行为。它们不是测试，不会进 CI。

| 文件 | 看什么 |
| --- | --- |
| `probe-compose-calls.mjs` | 用脚本化的 `ctx.llm` 驱动真实的 `produceCompose`：一次补写发几次调用、每次的输出上限、提示词多大 |
| `probe-short-draft.mjs` | 同上，但带一段 15 轮的长对话，覆盖 2/3/4/10 字草稿与尾巴/改写/SKIP 三种回答 |
| `probe_client_requests.py` | 在夹具里数一次打字停顿到底发几次请求（不是宿主内部重发） |
| `probe_retrigger.py` | 三条重发路径：建议出现后再打字、模型说无改动后静置、首次失败后的自动重试 |

```bash
node dev/probe-short-draft.mjs
python dev/probe_client_requests.py
```

用处：上一轮「建议消失」就是 `probe-short-draft.mjs` 里 2 字草稿走错路径暴露出来的。

# dev/ — 开发与验证工具

这个目录**不随插件发布**（`package.json` 的 `files` 未包含它），只用于本地开发与验证。

```
dev/
├── harness/          浏览器模拟器：在真实 DOM 里跑 client.js，不发任何网络请求
│   ├── src.js        模拟器本体（假 DSH：composer 结构、假 fetch、演示脚本）
│   ├── index.html    承载页面（加载 bundle.js）
│   ├── bundle.js     构建产物（.gitignore 忽略，需本地构建）
│   └── package.json  react / react-dom / esbuild
└── verify_*.py       真机脚本（Playwright 驱动真实 DSH 实例）
```

## 模拟器

```powershell
cd dev/harness
npm install                      # 首次：react / react-dom / esbuild
node node_modules/esbuild/bin/esbuild src.js --bundle --format=iife --target=chrome120 --outfile=bundle.js

cd ..
python verify_daily.py           # 55 个场景，全绿即通过
```

模拟器页面通过 `file://` 打开，`src.js` 里 `await import('../../client.js')` 直接引用**插件源码**，所以改完 `client.js` 必须重新构建 bundle，否则跑的是旧代码（这是本仓库最容易踩的坑）。

页面暴露的调试接口：`window.__harness`（`type` / `typeLive` / `key` / `press` / `rec` / `snapshot` / `store` / `accept` / `setComposeMode` / `setSession`）。

## 真机脚本

都需要一个运行中的实例 URL（`dsh web: http://127.0.0.1:PORT/?token=…`）：

```powershell
python verify_fresh_start.py "http://127.0.0.1:PORT/?token=…"
python verify_emptyline.py  "http://127.0.0.1:PORT/?token=…"
```

| 脚本 | 验证点 |
| --- | --- |
| `verify_daily.py` | 49 个行为场景（模拟器，不需要实例） |
| `verify_harness.py` | 模拟器自身的冒烟检查 |
| `verify_fresh_start.py` | 刚启动时状态行可用、不卡「补写中」 |
| `verify_emptyline.py` | 空行（`<br>` 之后）灰字锚点 |
| `verify_align*.py` | 灰字与正文行盒的像素对齐 |
| `verify_caret_geom.py` | 光标几何测量 |
| `verify_clear_rearm.py` | 采纳后清空是否重新弹出 |
| `verify_reuse_reload.py` | 刷新后是否复用已存建议（0 请求） |
| `verify_no_storm.py` / `verify_covered.py` | 请求次数（无取消风暴 / 覆盖区间零调用） |
| `verify_single_char.py` | 单字草稿即触发 |
| `verify_word_real.py` | Tab 整条采纳 |
| `verify_after_turn.py` | 回合结束后出现「下一句」 |
| `verify_dock_persist.py` | 状态行常驻与高度一致 |
| `verify_settings_ui.py` | 设置卡片渲染与持久化 |
| `verify_stream_real.py` / `verify_stream_repaint.py` | 流式首字延迟 / 灰字随流增长 |
| `verify_history_*.py` | 历史补全（真实会话 / 指定会话） |
| `verify_review_real.py` | 审查后的综合回归 |

脚本都会在结束时打印 PASS/FAIL 并截图（PNG 落在仓库根目录，已被 `.gitignore` 排除）。
