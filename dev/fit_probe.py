"""How well do completions fit the running conversation?

Takes real user messages from the live desktop host, truncates each to ~60%,
asks the plugin's own /predict for a completion, and compares the suggestion
with what the user actually typed next.
"""

import os
from pathlib import Path
import difflib
import json
import sys
import urllib.request
from playwright.sync_api import sync_playwright

ORIGIN = sys.argv[1] if len(sys.argv) > 1 else ""
SESSION = sys.argv[2] if len(sys.argv) > 2 else "session-e109cb4e-09d1-4d28-bb47-87ca65519fa8"
def _chrome_path():
    """Chromium for Playwright, located at runtime instead of hard-coded."""
    override = os.environ.get("DSH_CHROME")
    if override:
        return override
    roots = [
        Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "")) if os.environ.get("PLAYWRIGHT_BROWSERS_PATH") else None,
        Path.home() / "AppData" / "Local" / "ms-playwright",
        Path.home() / ".cache" / "ms-playwright",
    ]
    patterns = ["chromium-*/chrome-win/chrome.exe", "chromium-*/chrome-linux/chrome", "chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium"]
    for root in roots:
        if root is None or not root.exists():
            continue
        for pattern in patterns:
            for candidate in sorted(root.glob(pattern), reverse=True):
                return str(candidate)
    return None


CHROME = _chrome_path()


def fetch_json(page, path, payload):
    return page.evaluate(
        """async ({ path, payload }) => {
            const response = await fetch(path, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-composer-quill-client': '1' },
                body: JSON.stringify(payload),
            });
            if (!response.ok) return { error: response.status };
            return await response.json();
        }""",
        {"path": path, "payload": payload},
    )


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME or None)
        page = browser.new_page()
        page.goto(ORIGIN + "/", wait_until="domcontentloaded", timeout=30000)

        history = fetch_json(page, "/composer-quill/history", {"sessionId": SESSION})
        items = [entry["text"] for entry in history.get("items", []) if isinstance(entry, dict)]
        print(f"历史消息: {len(items)} 条")
        if not items:
            print("SKIP 该会话没有可用历史")
            browser.close()
            return 0

        # Real user messages long enough to split, most recent last.
        samples = [text for text in items if 16 <= len(text) <= 90][-6:]
        print(f"取样: {len(samples)} 条（16–90 字）")

        rows = []
        for text in samples:
            cut = max(6, int(len(text) * 0.6))
            draft = text[:cut]
            actual = text[cut:].strip()
            reply = fetch_json(page, "/composer-quill/predict", {"sessionId": SESSION, "mode": "compose", "draft": draft})
            if not isinstance(reply, dict) or not reply.get("text"):
                rows.append({"draft": draft, "actual": actual, "tail": "", "sim": 0.0, "status": reply.get("error") if isinstance(reply, dict) else "?"})
                continue
            produced = reply["text"]
            tail = produced[len(draft):] if produced.startswith(draft) else produced
            ratio = difflib.SequenceMatcher(None, tail, actual).ratio() if actual else 0.0
            rows.append({"draft": draft, "actual": actual, "tail": tail.strip(), "sim": round(ratio, 2), "status": "ok"})

        ok = [row for row in rows if row["status"] == "ok"]
        for row in rows:
            print(
                f"\n草稿：{row['draft'][:28]}…\n"
                f"  实际续写：{row['actual'][:30]!r}\n"
                f"  模型建议：{row['tail'][:30]!r}   相似度 {row['sim']}\n"
                f"  状态：{row['status']}"
            )

        if ok:
            mean = sum(row["sim"] for row in ok) / len(ok)
            hit = sum(1 for row in ok if row["sim"] >= 0.3)
            print(f"\n=== 汇总 ===")
            print(f"可评估样本 {len(ok)}；平均相似度 {mean:.2f}；相似度≥0.3 的样本 {hit}/{len(ok)}")
        with open("fit-report.json", "w", encoding="utf-8") as handle:
            json.dump(rows, handle, ensure_ascii=False, indent=1)
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
