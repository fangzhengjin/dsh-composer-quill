"""How many model requests does a realistic typing session cost?

Counts the Host log's `request` lines while the scripted session runs, and checks
the settings card in the same pass.
"""

import json
import os
import sys
import time
from playwright.sync_api import sync_playwright

URL = sys.argv[1]
CHROME = r"%USERPROFILE%\AppData\Local\ms-playwright\chromium-1148\chrome-win\chrome.exe"
LOG = os.path.expanduser(r"~\.dsh\profiles\desktop\composer-quill.log")

STATE = """() => {
  const chip = document.querySelector('[data-composer-quill="dock-suggestion"]');
  const ghost = document.querySelector('[data-composer-quill="text"]');
  const editor = document.querySelector('[data-composer-input]');
  return {
    chip: chip ? (chip.textContent || '') : '',
    ghost: ghost && getComputedStyle(ghost).display !== 'none' ? (ghost.textContent || '') : '',
    draft: editor ? (editor.textContent || '') : '',
  };
}"""


def request_count():
    if not os.path.exists(LOG):
        return 0
    total = 0
    with open(LOG, encoding="utf-8", errors="ignore") as handle:
        for line in handle:
            if '"event":"request"' in line:
                total += 1
    return total


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=CHROME)
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(URL, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector("[data-composer-input]", timeout=45000)
    page.wait_for_timeout(1500)
    for label in ("继续", "Continue", "知道了"):
        button = page.locator(f"button[aria-label='{label}'], button:has-text('{label}')")
        if button.count() > 0:
            button.first.click()
            page.wait_for_timeout(400)
            break

    def focus():
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

    focus()
    page.keyboard.press("Control+a")
    page.keyboard.press("Backspace")
    page.evaluate("() => localStorage.removeItem('dsh.composer-quill.suggestions')")
    page.wait_for_timeout(500)

    start = request_count()
    draft = "帮我把这段日志按时间排序再统计每个错误的出现次数"
    for ch in draft:
        page.keyboard.insert_text(ch)
        page.wait_for_timeout(110)
    # Wait for a suggestion to appear (or give up after 20 s).
    appeared = False
    for _ in range(100):
        page.wait_for_timeout(200)
        state = page.evaluate(STATE)
        if state["ghost"] or state["chip"]:
            appeared = True
            break
    # Sit idle for 6 s: the safety net must not keep re-asking.
    idle_start = request_count()
    page.wait_for_timeout(6000)
    idle_end = request_count()
    total = request_count() - start

    chars = len(draft)
    print(f"输入 {chars} 字（110ms/键）→ 共 {total} 次模型请求，平均 {total / chars:.2f} 次/字")
    print(f"建议出现：{appeared}；静置 6 秒期间新增请求：{idle_end - idle_start}")

    # Settings card.
    focus()
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    page.keyboard.press("Control+Alt+Comma")
    page.wait_for_timeout(1200)
    general = page.locator("text=通用设置")
    if general.count() > 0:
        general.first.click()
        page.wait_for_timeout(800)
    controls = page.evaluate(
        """() => Array.from(document.querySelectorAll('[data-composer-quill^="settings-"]'))
            .map((node) => node.getAttribute('data-composer-quill') + '=' + (node.value ?? ''))"""
    )
    print("设置控件：", controls)
    language = page.locator("[data-composer-quill='settings-language']").first
    language.select_option("en")
    page.wait_for_timeout(300)
    stored = page.evaluate("() => localStorage.getItem('dsh.composer-quill.config')")
    print("持久化：", stored)
    language.select_option("auto")
    page.wait_for_timeout(200)

    ok = appeared and total <= max(6, chars // 3) and (idle_end - idle_start) == 0 and len(controls) >= 4 and '"language":"en"' in (stored or "")
    print("PASS 请求量、静置与设置项均符合预期" if ok else "FAIL 见上方数据")
    page.screenshot(path="audit-cost.png")
    browser.close()
    sys.exit(0 if ok else 1)
