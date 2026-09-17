#!/usr/bin/env python3
# 划词助手策略回归测试：
#   1) 在 TextEdit 中创建临时文档并全选真实文本
#   2) 分别强制走「菜单栏 Copy 动作」和「目标进程 Cmd+C」获取选中文本
#   3) 断言文本正确，且用户剪贴板被完整恢复
# 用法: python3 scripts/selection-helper-e2e.py
import json
import Quartz
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HELPER = os.environ.get(
    "GLM_SELECTED_TEXT_HELPER",
    f"{ROOT}/dist/native/selected-text"
)
SENTINEL = "GLM clipboard sentinel \u2328\ufe0f keep all flavors"
TEXT = "The quick brown fox jumps over the lazy dog again and again"
DOC_NAME = "GLM selection strategy test"
CMD = Quartz.kCGEventFlagMaskCommand


def key(code, flags=0):
    for down in (True, False):
        event = Quartz.CGEventCreateKeyboardEvent(None, code, down)
        Quartz.CGEventSetFlags(event, flags)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
        time.sleep(0.03)


def osascript(script):
    return subprocess.run(["osascript", "-e", script], capture_output=True,
                          text=True, timeout=4, check=True).stdout.strip()


def selected_document():
    osascript(f'''
tell application "TextEdit"
  activate
  set d to make new document with properties {{text:"{TEXT}"}}
  set name of d to "{DOC_NAME}"
end tell''')
    time.sleep(0.4)
    key(0, CMD)  # Cmd+A：选中文档中的全部测试文本
    time.sleep(0.2)

def run_helper(flag):
    subprocess.run(["pbcopy"], input=SENTINEL.encode(), check=True)
    raw = subprocess.run([HELPER, flag], capture_output=True,
                         text=True, timeout=6)
    if raw.returncode != 0:
        raise AssertionError(f"helper failed: {raw.stderr.strip()}")
    result = json.loads(raw.stdout)
    restored = subprocess.run(["pbpaste"], capture_output=True, text=True,
                              check=True).stdout

    return result, restored


def main():
    selected_document()
    result, restored = run_helper("--force-menu-copy")
    assert result.get("strategy") == "menu-action", result
    assert result.get("text") == TEXT, result
    assert result.get("pasteboardRestored") is True, result
    assert restored == SENTINEL, repr(restored)

    selected_document()
    result, restored = run_helper("--shortcut-copy")
    assert result.get("strategy") == "shortcut", result
    assert result.get("text") == TEXT, result
    assert result.get("pasteboardRestored") is True, result
    assert restored == SENTINEL, repr(restored)
    print(json.dumps({
        "strategies": ["menu-action", "shortcut"],
        "textLength": len(result.get("text", "")),
        "pasteboardRestored": result.get("pasteboardRestored")
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"selection-helper-e2e: {error}", file=sys.stderr)
        sys.exit(1)
    finally:
        subprocess.run(["osascript", "-e", f'''
tell application "TextEdit"
  close (every document whose name is "{DOC_NAME}") saving no
end tell'''], capture_output=True, text=True, timeout=4)
