"""Setting says Chinese, draft is English: does it offer a Chinese rewrite?"""

import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1]
CHROME = r"%USERPROFILE%\AppData\Local\ms-playwright\chromium-1148\chrome-win\chrome.exe"
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


def latin_share(text):
    latin = sum(1 for ch in text if ch.isascii() and ch.isalpha())
    cjk = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
    total = latin + cjk
    return 0.0 if total == 0 else latin / total


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=CHROME)
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.goto(URL, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector("[data-composer-input]", timeout=45000)
    page.wait_for_timeout(1500)
    for label in ("继续", "Continue", "知道了"):
        button = page.locator(f"button:has-text('{label}')")
        if button.count() > 0:
            button.first.click()
            page.wait_for_timeout(400)
            break

    # Force Chinese in the settings.
    page.keyboard.press("Control+Alt+Comma")
    page.wait_for_timeout(1200)
    general = page.locator("text=通用设置")
    if general.count() > 0:
        general.first.click()
        page.wait_for_timeout(700)
    page.locator("[data-composer-quill='settings-language']").first.select_option("zh")
    page.wait_for_timeout(300)
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)

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
    page.keyboard.press("Control+a")
    page.keyboard.press("Backspace")
    page.evaluate("() => localStorage.removeItem('dsh.composer-quill.suggestions')")
    page.wait_for_timeout(300)
    for ch in "fix the flaky test in the auth module":
        page.keyboard.insert_text(ch)
        page.wait_for_timeout(110)

    state = {"chip": "", "ghost": "", "draft": ""}
    for _ in range(120):
        page.wait_for_timeout(250)
        state = page.evaluate(STATE)
        if state["chip"] or state["ghost"]:
            break
    proposal = state["chip"] or state["ghost"]
    print("英文草稿 + 中文设置 →", repr(proposal[:60]))
    print("建议部分的拉丁占比：", round(latin_share(proposal), 2))

    # Accept it and look at the resulting draft.
    if proposal:
        page.keyboard.press("Tab")
        page.wait_for_timeout(700)
        after = page.evaluate(STATE)
        print("采纳后的输入框：", repr(after["draft"][:60]))

    page.keyboard.press("Control+Alt+Comma")
    page.wait_for_timeout(900)
    general = page.locator("text=通用设置")
    if general.count() > 0:
        general.first.click()
        page.wait_for_timeout(600)
    page.locator("[data-composer-quill='settings-language']").first.select_option("auto")
    page.wait_for_timeout(300)
    page.keyboard.press("Escape")
    browser.close()
