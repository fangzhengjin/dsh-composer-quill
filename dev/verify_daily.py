"""Daily-usage simulation for dsh-composer-quill.

Drives the real plugin client bundle in Chromium against a faithful composer
mock, with human-like typing (per-character input, pauses, corrections, IME
composition, Esc, Tab, Enter) and records every UI state change at 50 ms.

Each scenario prints PASS/FAIL with the evidence used.
"""

import json
import sys
import time
from playwright.sync_api import sync_playwright

URL = "file:///%USERPROFILE%/Documents/deepseek-harness/default-workspace/dsh-composer-quill/dev/harness/index.html"
CHROME = r"%USERPROFILE%\AppData\Local\ms-playwright\chromium-1148\chrome-win\chrome.exe"

results: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, evidence: str) -> None:
    results.append((name, ok, evidence))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {evidence}")


def longest_run(samples, pred):
    best = 0
    start = None
    for sample in samples:
        if pred(sample):
            if start is None:
                start = sample["t"]
            best = max(best, sample["t"] - start)
        else:
            start = None
    return best


def proposal_of(snap):
    """Text of the suggestion chip (the dock row is always present now)."""
    return (snap.get("proposal") or {}).get("text", "")


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME)
        page = browser.new_page(viewport={"width": 980, "height": 480})
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(URL, wait_until="load")
        page.wait_for_function("() => window.__harnessReady === true || window.__harnessError", timeout=15000)
        if page.evaluate("() => window.__harnessError || ''"):
            print("HARNESS ERROR", page.evaluate("() => window.__harnessError"))
            return 1

        h = lambda expr: page.evaluate(f"() => window.__harness.{expr}")

        def reset(draft=""):
            h("resetLearning()")
            h(f"type({json.dumps(draft)})")

        def compose_calls():
            return len([c for c in h("calls") if c["mode"] == "compose"])

        # ---- S1 日常短句：逐字输入 -> 停顿 -> 建议 -> Tab
        reset("")
        h("typeLive('帮我看下这个报错')")
        page.wait_for_timeout(1600)
        snap = h("snapshot()")
        chip = proposal_of(snap)
        ghost = snap["text"]["text"] if snap["text"] else ""
        ok = bool(chip) and ("按 Tab" in chip) and bool(ghost)
        record("S1 逐字输入后给出建议", ok, f"chip={chip[:28]!r} ghost={ghost!r}")
        h("accept()")
        page.wait_for_timeout(150)
        inserted = page.evaluate("() => window.__harnessInserted || null")
        record("S1 Tab 采纳", bool(inserted), f"inserted={inserted!r}")

        # ---- S2 快速连打：不应卡在补写中，也不应长时间空白
        reset("")
        h("rec.start(50)")
        h("typeLive('帮我把这段日志整理一下顺便把报错的行标出来再给下一步建议', {delay: 70})")
        page.wait_for_timeout(2500)
        samples = h("rec.stop()")
        stuck = longest_run(samples, lambda s: s["pending"])
        tail = samples[-10:]
        responded = any(s["proposal"] or s["ghost"] for s in tail)
        record("S2 快速连打不卡在补写中", stuck <= 4000, f"最长 pending={stuck}ms samples={len(samples)}")
        record("S2 停顿后 2.5s 内有反馈", responded, f"末尾状态={tail[-1]['proposal'][:24]!r}")

        # ---- S3 中途改主意：旧建议不得覆盖新输入
        reset("")
        h("typeLive('帮我把这段日志', {delay: 60})")
        page.wait_for_timeout(1600)
        page.evaluate("() => { window.__harnessSetDraft = null; window.__harnessInserted = null }")
        h("typeLive('，另外贴一下配置文件', {delay: 60})")
        page.wait_for_timeout(250)
        h("accept()")
        page.wait_for_timeout(150)
        applied = page.evaluate("() => ({ inserted: window.__harnessInserted, setDraft: window.__harnessSetDraft })")
        stale = applied["setDraft"] is not None and "另外" not in (applied["setDraft"] or "")
        record("S3 改主意后不套用过时改写", not stale, f"applied={applied}")
        # Wait until a fresh proposal is actually on screen (the request for the
        # extended draft has to land first), then accept it.
        deadline = time.time() + 6.0
        ready = False
        while time.time() < deadline:
            snap = h("snapshot()")
            button = page.evaluate("() => Boolean(document.querySelector('[data-composer-quill=\"dock-suggestion\"]'))")
            if button:
                ready = True
                break
            page.wait_for_timeout(150)
        page.evaluate("() => { window.__harnessInserted = null; window.__harnessSetDraft = null }")
        h("accept(true)")
        page.wait_for_timeout(200)
        fresh = page.evaluate("() => ({ inserted: window.__harnessInserted, setDraft: window.__harnessSetDraft })")
        ok = fresh["inserted"] is not None or (fresh["setDraft"] is not None and "另外" in fresh["setDraft"])
        recent = page.evaluate("() => [...new Set(window.__harness.calls.filter(c => c.mode === 'compose').map(c => c.draft))].slice(-3)")
        record("S3b 新建议仍可采纳", ready and ok, f"applied={fresh} ready={ready} compose_drafts={recent}")

        # ---- S4 错字：整段改写
        reset("")
        h("typeLive('帮我把这段曰志', {delay: 60})")
        page.wait_for_timeout(1600)
        snap = h("snapshot()")
        chip = proposal_of(snap)
        page.evaluate("() => { window.__harnessSetDraft = null }")
        h("accept()")
        page.wait_for_timeout(150)
        applied = page.evaluate("() => window.__harnessSetDraft || null")
        ok = "采用改写" in chip and applied is not None and "日志" in applied
        record("S4 错字走整段改写", ok, f"chip={chip[:24]!r} setDraft={str(applied)[:24]!r}")

        # ---- S5 Esc 忽略：同一草稿不再自动弹出
        reset("")
        h("typeLive('帮我把这段日志', {delay: 60})")
        page.wait_for_timeout(1600)
        h("press({key: 'Escape'})")
        page.wait_for_timeout(2200)
        snap = h("snapshot()")
        chip = proposal_of(snap)
        ghost = snap["text"]["text"] if snap["text"] else ""
        record("S5 Esc 后同草稿不再重弹", chip == "" and ghost == "", f"chip={chip!r} ghost={ghost!r}")

        # ---- S6 请求失败一次：自动重试并恢复
        h("setComposeMode('fail-once')")
        reset("")
        h("typeLive('这段日志重新试一下', {delay: 60})")
        page.wait_for_timeout(4200)
        snap = h("snapshot()")
        chip = proposal_of(snap)
        record("S6 失败后自动重试恢复", "按 Tab" in chip, f"chip={chip[:28]!r}")
        h("setComposeMode('ok')")

        # ---- S7 IME 组字期间不发新请求
        reset("")
        h("typeLive('这段日志', {delay: 60})")
        page.wait_for_timeout(1600)
        before = compose_calls()
        page.evaluate(
            """() => {
                const editor = document.querySelector('[data-composer-input]');
                editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
                editor.textContent = '这段日志还有';
                editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '还有' }));
            }"""
        )
        page.wait_for_timeout(1400)
        during = compose_calls()
        page.evaluate("() => document.querySelector('[data-composer-input]').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))")
        h("key('。')")
        page.wait_for_timeout(1800)
        after = compose_calls()
        record("S7 组字期间不打断", during == before and after > during, f"calls before/during/after={before}/{during}/{after}")

        # ---- S8 发送后清空，不残留
        h("press({key: 'Enter'})")
        page.wait_for_timeout(400)
        snap = h("snapshot()")
        chip = proposal_of(snap)
        record("S8 发送后清空建议", chip == "", f"chip={chip!r}")

        # ---- S10 长草稿（150 字）
        long_draft = "帮我把这段日志按时间顺序整理成一张表，标出错误行，并给出下一步排查建议。" * 4
        reset("")
        h(f"typeLive({json.dumps(long_draft)}, {{delay: 8}})")
        page.wait_for_timeout(2000)
        snap = h("snapshot()")
        chip = proposal_of(snap)
        record("S10 长草稿仍给建议", "按 Tab" in chip, f"len={len(long_draft)} chip={chip[:26]!r}")

        # ---- S11 单字草稿也会请求（0.9.0 取消了 3 字下限）
        reset("")
        before = compose_calls()
        h("typeLive('好', {delay: 60})")
        page.wait_for_timeout(1500)
        after = compose_calls()
        snap = h("snapshot()")
        record(
            "S11 单字草稿也给建议",
            after > before and bool(proposal_of(snap) or (snap["text"]["text"] if snap["text"] else "")),
            f"compose calls {before}->{after} chip={proposal_of(snap)[:20]!r}",
        )

        # ---- S12 切会话不串建议
        reset("")
        h("typeLive('这段日志', {delay: 60})")
        page.wait_for_timeout(1600)
        page.evaluate("() => window.__harness.setSession('s-other')")
        page.wait_for_timeout(300)
        snap = h("snapshot()")
        chip = proposal_of(snap)
        ghost = snap["text"]["text"] if snap["text"] else ""
        record("S12 切会话后不显示旧会话建议", chip == "" and ghost == "", f"chip={chip!r} ghost={ghost!r}")
        page.evaluate("() => window.__harness.setSession('s-harness')")

        # ---- S13 灰字必须和正文落在同一个行盒里
        reset("")
        h("typeLive('帮我把这个报错的现象描述清楚', {delay: 60})")
        page.wait_for_timeout(1500)
        align = h("align()")
        ok = bool(align) and align.get("delta") is not None and abs(align["delta"]) <= 1.0
        record("S13 灰字与正文行盒对齐", ok, f"align={align}")

        # ---- S14 本地历史补全：模型还没回，历史就该先顶上
        reset("")
        h("typeLive('帮我把这段日志', {delay: 40})")
        started = time.time()
        first_chip = None
        chip_text = ""
        while time.time() - started < 2.0:
            snap = h("snapshot()")
            chip = proposal_of(snap)
            if chip:
                first_chip = time.time() - started
                chip_text = chip
                break
            page.wait_for_timeout(30)
        record(
            "S14 本地历史补全毫秒级兜底",
            first_chip is not None and first_chip < 0.45 and "历史" in chip_text,
            f"首个建议 {first_chip and round(first_chip, 2)}s chip={chip_text[:24]!r}",
        )

        # ---- S15 Tab 一次取完整条建议（0.9.0 取消逐词）
        reset("")
        h("typeLive('帮我把这段日志', {delay: 40})")
        page.wait_for_timeout(1500)
        before_len = len(h("draft()"))
        page.evaluate("() => { window.__harnessInserted = null }")
        h("accept(false)")
        page.wait_for_timeout(300)
        inserted = page.evaluate("() => window.__harnessInserted")
        after_len = len(h("draft()"))
        state = h("snapshot()")
        record(
            "S15 Tab 一次取完建议",
            bool(inserted) and after_len > before_len and not proposal_of(state),
            f"插入={str(inserted)[:18]!r} 长度 {before_len}->{after_len} 仍在显示={bool(proposal_of(state))}",
        )

        # ---- S16 采纳后清空文本，建议应重新弹出
        reset("")
        h("typeLive('帮我把这段日志', {delay: 40})")
        page.wait_for_timeout(1500)
        h("accept(true)")
        page.wait_for_timeout(300)
        after_accept = h("draft()")
        h("type('')")                      # 把输入框清空
        deadline = time.time() + 4.0
        chip = ghost = ""
        while time.time() < deadline:
            snap = h("snapshot()")
            chip = proposal_of(snap)
            ghost = snap["text"]["text"] if snap["text"] else ""
            if "按 Tab 采纳" in chip:
                break
            page.wait_for_timeout(120)
        record(
            "S16 清空文本后建议重新弹出",
            bool(chip) and ("按 Tab 采纳" in chip),
            f"采纳后={after_accept[:12]!r} 清空后 chip={chip[:26]!r} ghost={ghost[:16]!r}",
        )

        # ---- S22 切换会话：键没变时复用存储，而不是重新采样
        reset("")
        h("setSession('sess-a')")
        chip = ""
        for _ in range(24):
            page.wait_for_timeout(250)
            chip = proposal_of(h("snapshot()"))
            if "按 Tab 采纳" in chip:
                break
        first_chip = chip
        h("setSession('sess-b')")
        page.wait_for_timeout(1500)
        # Only look at what happens after coming back to the first Session.
        h("calls.length = 0")
        h("setSession('sess-a')")
        page.wait_for_timeout(2000)
        hydrated = [c for c in h("calls") if c.get("mode") == "beacon" and c.get("event") == "hydrated"]
        predicts = [c for c in h("calls") if c.get("mode") in ("next", "compose")]
        print('   [S22 全部调用]', [(c.get('mode'), c.get('event'), c.get('draft')) for c in h('calls')])
        again = proposal_of(h("snapshot()"))
        record(
            "S22 切回会话命中存储（hydrated）",
            bool(first_chip) and bool(hydrated) and bool(again),
            f"首次={first_chip[:14]!r} 切回={again[:14]!r} hydrated={len(hydrated)} 模型请求={[(c.get('mode'), c.get('draft')) for c in predicts]}",
        )

        # ---- S17 dock 行常驻：空闲时也在，且高度不跳
        reset("")
        page.wait_for_timeout(600)
        idle = h("snapshot()")
        idle_dock = idle["dock"]
        idle_hint = (idle.get("hint") or {}).get("text", "")
        page.wait_for_timeout(1500)
        typing = h("snapshot()")
        dock_heights = [x["dock"]["rect"]["h"] for x in (idle, typing) if x["dock"]]
        record(
            "S17 建议行常驻不消失",
            bool(idle_dock) and bool(typing["dock"]) and len(set(dock_heights)) <= 1
            and bool(idle_hint or (idle.get("proposal") or {}).get("text")),
            f"空闲 hint={idle_hint[:16]!r} proposal={((idle.get('proposal') or {}).get('text') or '')[:16]!r} 高度={dock_heights}",
        )

        # ---- S18 草稿在建议之内继续输入：复用旧尾巴，延后请求
        reset("")
        h("typeLive('帮我把这段日志', {delay: 40})")
        page.wait_for_timeout(2000)
        base_calls = compose_calls()
        # 继续打「建议尾巴」里的字：此刻建议仍然覆盖草稿
        h("typeLive('，找出', {delay: 60})")
        page.wait_for_timeout(1000)          # 小于延后的 1.2 s
        during = compose_calls()
        ghost_now = h("snapshot()")
        tail_visible = bool((ghost_now["text"]["text"] if ghost_now["text"] else "") or proposal_of(ghost_now))
        page.wait_for_timeout(2200)          # 超过延后阈值
        after = compose_calls()
        record(
            "S18 前缀延长期间复用旧建议",
            during == base_calls and after > base_calls and tail_visible,
            f"calls {base_calls}->{during}->{after} 期间仍有建议={tail_visible}",
        )

        # ---- S19 流式期间灰字要逐步变长（不是只画第一个 delta）
        reset("")
        h("rec.start(60)")
        h("typeLive('帮我把这段日志', {delay: 30})")
        page.wait_for_timeout(2200)
        samples = h("rec.stop()")
        ghost_lengths = sorted({len(s["ghost"]) for s in samples if s["ghost"]})
        grew = len(ghost_lengths) >= 2
        record(
            "S19 灰字随流式增长",
            grew,
            f"灰字长度集合={ghost_lengths[-6:]}",
        )

        # ---- S20 采纳反馈：学到的偏好会重排候选（但不会新增/丢弃）
        reset("")
        # The store must not answer this one: the point is to see the ranking run.
        h('clearSuggestions()')
        # 让「长建议」显得更受欢迎
        h("""setLearning({
            "kind:next": {"shown": 10, "accepted": 9},
            "len:l": {"shown": 10, "accepted": 9},
            "len:xs": {"shown": 10, "accepted": 1},
            "open:word": {"shown": 10, "accepted": 5},
            "greet:no": {"shown": 10, "accepted": 9},
            "end:period": {"shown": 10, "accepted": 5},
            "end:open": {"shown": 10, "accepted": 5},
            "script:zh": {"shown": 10, "accepted": 9}
        })""")
        page.wait_for_timeout(1200)
        snap = h("snapshot()")
        chip = proposal_of(snap)
        learned_first = chip.split("：", 1)[-1][:12]
        record(
            "S20 学到偏好后重排候选",
            "把刚才那段报错" in chip and "第 1/2 条" in chip,
            f"首条={learned_first!r}",
        )
        h("resetLearning()")

        record("S9 无页面异常", not errors, f"errors={errors[:2]}")
        page.screenshot(path="daily-final.png")
        browser.close()

    failed = [name for name, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} scenarios passed")
    if failed:
        print("failed:", ", ".join(failed))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())




