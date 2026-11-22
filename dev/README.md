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
python verify_daily.py           # 47 个场景，全绿即通过
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
| `verify_daily.py` | 47 个行为场景（模拟器，不需要实例） |
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
