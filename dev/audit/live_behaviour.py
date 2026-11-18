"""Independent behaviour audit of the running plugin.

Fresh scenarios written for this audit: no reuse of the earlier probes. Every
scenario records what the user would see plus any page error.
"""

import json
import sys
import time
from playwright.sync_api import sync_playwright

URL = sys.argv[1]
CHROME = r"%USERPROFILE%\AppData\Local\ms-playwright\chromium-1148\chrome-win\chrome.exe"

STATE = """() => {
  const row = document.querySelector('[data-composer-quill="dock"]');
  const chip = document.querySelector('[data-composer-quill="dock-suggestion"]');
  const hint = document.querySelector('[data-composer-quill="dock-hint"]');
  const pending = document.querySelector('[data-composer-quill="dock-pending"]');
  const ghost = document.querySelector('[data-composer-quill="text"]');
  const editor = document.querySelector('[data-composer-input]');
  return {
    row: Boolean(row),
    chip: chip ? (chip.textContent || '') : '',
    hint: hint ? (hint.textContent || '') : '',
    pending: Boolean(pending),
    ghost: ghost && getComputedStyle(ghost).display !== 'none' ? (ghost.textContent || '') : '',
    draft: editor ? (editor.textContent || '') : '',
  };
}"""

results = []


def record(ok, name, detail):
    results.append((ok, name, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name} — {detail}")


def focus(page):
    page.evaluate(
        """() => {
            const editor = document.querySelector('[data-composer-input]');
            editor.focus();
            const range = document.createRange();
            range.selectNodeContents(editor);
            range.collapse(false);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        }"""
    )


def clear(page):
    focus(page)
    page.keyboard.press("Control+a")
    page.keyboard.press("Backspace")
    page.evaluate("() => localStorage.removeItem('dsh.composer-quill.suggestions')")
    page.wait_for_timeout(300)


def type_text(page, text, gap=120):
    for ch in text:
        page.keyboard.insert_text(ch)
        page.wait_for_timeout(gap)


def wait_for(page, predicate, seconds=20):
    deadline = time.time() + seconds
    last = None
    while time.time() < deadline:
        last = page.evaluate(STATE)
        if predicate(last):
            return last
        page.wait_for_timeout(150)
    return last


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=CHROME)
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.goto(URL, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector("[data-composer-input]", timeout=45000)
    page.wait_for_timeout(1500)
    for label in ("继续", "Continue", "知道了"):
        button = page.locator(f"button:has-text('{label}')")
        if button.count() > 0:
            button.first.click()
            page.wait_for_timeout(400)
            break

    # A. The row exists even before any interaction.
    state = page.evaluate(STATE)
    record(state["row"], "A 刚打开就有建议行", f"row={state['row']} hint={state['hint'][:20]!r}")

    # B. Typing a normal draft produces an inline ghost.
    clear(page)
    type_text(page, "帮我把这段日志", gap=130)
    state = wait_for(page, lambda s: bool(s["ghost"] or s["chip"]), seconds=20)
    record(bool(state["ghost"] or state["chip"]), "B 打字后出现建议", f"ghost={state['ghost'][:24]!r} chip={state['chip'][:24]!r}")

    # C. One more keystroke keeps something on screen (no full blank frame).
    page.keyboard.insert_text("按")
    blanks = 0
    for _ in range(40):
        s = page.evaluate(STATE)
        if not (s["ghost"] or s["chip"] or s["pending"] or "·" in s["hint"]):
            blanks += 1
        page.wait_for_timeout(50)
    record(blanks <= 2, "C 追加输入不出现空白帧", f"空白 {blanks}/40")

    # D. Tab accepts and the row stops repeating the accepted text.
    state = wait_for(page, lambda s: bool(s["ghost"] or s["chip"]), seconds=20)
    before = state["draft"]
    page.keyboard.press("Tab")
    page.wait_for_timeout(800)
    after = page.evaluate(STATE)
    record(len(after["draft"]) > len(before), "D Tab 采纳写入输入框", f"{before[:12]!r}({len(before)}) → {after['draft'][:16]!r}({len(after['draft'])})")
    record(
        after["draft"].strip() == "" or after["draft"].strip() not in after["chip"],
        "D2 采纳后不再重复显示同样的文本",
        f"chip={after['chip'][:26]!r}",
    )

    # E. Escape dismisses, and the same draft is not requested again immediately.
    state = wait_for(page, lambda s: bool(s["ghost"] or s["chip"]), seconds=20)
    page.keyboard.press("Escape")
    page.wait_for_timeout(500)
    dismissed = page.evaluate(STATE)
    record(not dismissed["ghost"] and not dismissed["chip"], "E Esc 立即清空建议", f"ghost={dismissed['ghost'][:12]!r} chip={dismissed['chip'][:12]!r}")

    # F. A brand new draft after Esc still gets a suggestion (no permanent dismissal).
    type_text(page, "再看下", gap=150)
    state = wait_for(page, lambda s: bool(s["ghost"] or s["chip"]), seconds=20)
    record(bool(state["ghost"] or state["chip"]), "F Esc 之后新草稿仍能出建议", f"chip={state['chip'][:26]!r}")

    # G. Long idle must not leave a stuck "补写中…".
    page.wait_for_timeout(9000)
    state = page.evaluate(STATE)
    record(not state["pending"], "G 静置 9 秒后不卡在补写中", f"pending={state['pending']} chip={state['chip'][:20]!r} hint={state['hint'][:20]!r}")

    # H. Clearing the composer does not crash or throw.
    clear(page)
    page.wait_for_timeout(1500)
    state = page.evaluate(STATE)
    record(state["row"], "H 清空后行仍在", f"row={state['row']} draft={state['draft']!r}")

    # I. No uncaught page errors during the whole run.
    record(len(errors) == 0, "I 全程无页面异常", f"{errors[:2]}")

    page.screenshot(path="audit-live.png")
    browser.close()

failed = [item for item in results if not item[0]]
print(f"\n=== 汇总 {len(results) - len(failed)}/{len(results)} 通过 ===")
for _, name, detail in failed:
    print(f"  FAIL {name} — {detail}")
sys.exit(0 if not failed else 1)
