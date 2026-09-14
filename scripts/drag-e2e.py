# 端到端拖选回归测试（需 pyobjc-framework-Quartz + 辅助功能权限）：
#   1) 在 Electron 目标文本窗口合成真实鼠标拖选 → 断言 GLM问问 工具条(540x80)出现
#   2) 合成双击选词 → 断言工具条出现（双击触发）
#   3) 点击他处 → 工具条收起
#   4) ⌘⇧Space 快捷键开合复验
#   5) （可选）截图模式抑制：⌘⌥A 后拖选不弹条，窗口期后恢复
# 用法: python3 scripts/drag-e2e.py [shot_ms]
# 注意：运行前先退出其他 GLM问问 实例（脚本按进程名定位，要求唯一）。
import Quartz, subprocess, sys, time, json, os

LEFT = Quartz.kCGMouseButtonLeft

def post_mouse(etype, x, y, clicks=1):
    e = Quartz.CGEventCreateMouseEvent(None, etype, (x, y), LEFT)
    Quartz.CGEventSetIntegerValueField(e, Quartz.kCGMouseEventClickState, clicks)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)

def drag(x1, y1, x2, y2):
    post_mouse(Quartz.kCGEventLeftMouseDown, x1, y1)
    time.sleep(0.08)
    steps = 10
    for i in range(1, steps + 1):
        post_mouse(Quartz.kCGEventLeftMouseDragged,
                   x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps)
        time.sleep(0.02)
    post_mouse(Quartz.kCGEventLeftMouseUp, x2, y2)

def dblclick(x, y):
    for clicks in (1, 2):
        post_mouse(Quartz.kCGEventLeftMouseDown, x, y, clicks=clicks)
        post_mouse(Quartz.kCGEventLeftMouseUp, x, y, clicks=clicks)
        time.sleep(0.05)

def click(x, y):
    post_mouse(Quartz.kCGEventLeftMouseDown, x, y)
    post_mouse(Quartz.kCGEventLeftMouseUp, x, y)

def key(code, flags=0):
    for down in (True, False):
        e = Quartz.CGEventCreateKeyboardEvent(None, code, down)
        if flags:
            Quartz.CGEventSetFlags(e, flags)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)
        time.sleep(0.03)

CMD = Quartz.kCGEventFlagMaskCommand
ALT = Quartz.kCGEventFlagMaskAlternate
SHIFT = Quartz.kCGEventFlagMaskShift

def onscreen_windows(owner=None):
    opts = Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements
    wins = Quartz.CGWindowListCopyWindowInfo(opts, Quartz.kCGNullWindowID) or []
    out = []
    for w in wins:
        name = w.get('kCGWindowOwnerName', '')
        if owner and name != owner:
            continue
        b = w.get('kCGWindowBounds', {})
        out.append((name, int(b.get('X', 0)), int(b.get('Y', 0)),
                    int(b.get('Width', 0)), int(b.get('Height', 0))))
    return out

def glm_window_sizes():
    # CG 窗口列表同时支持打包实例（GLM问问）和开发实例（Electron）。
    opts = Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements
    wins = Quartz.CGWindowListCopyWindowInfo(opts, Quartz.kCGNullWindowID) or []
    return ','.join(f"{int(w.get('kCGWindowBounds', {}).get('Width', 0))}x{int(w.get('kCGWindowBounds', {}).get('Height', 0))}"
                    for w in wins
                    if w.get('kCGWindowOwnerName') in ('GLM问问', 'Electron'))

def has_toolbar():
    # 新版工具条宽度随内容自适应；只按浮动条的实际高度识别。
    opts = Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements
    wins = Quartz.CGWindowListCopyWindowInfo(opts, Quartz.kCGNullWindowID) or []
    for w in wins:
        if w.get('kCGWindowOwnerName') not in ('GLM问问', 'Electron'):
            continue
        b = w.get('kCGWindowBounds', {})
        width, height = int(b.get('Width', 0)), int(b.get('Height', 0))
        if 180 <= width <= 720 and height == 52:
            return True
    return False

def wait_toolbar(timeout=2.5):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if has_toolbar():
            return True
        time.sleep(0.12)
    return False

results = {}

# 准备：Electron 目标窗口（纯文本，拖选目标；窗口 720x300）
# 选一个不被任何现有窗口覆盖的空位（仅在主屏内搜索，避免多屏变量）
others = onscreen_windows()
main = Quartz.CGDisplayBounds(Quartz.CGMainDisplayID())
MW, MH = int(main.size.width), int(main.size.height)
tx, ty = None, None
placed = False
for cy in range(560, MH - 320, 30):
    for cx in range(20, MW - 740, 40):
        if all(cx + 720 <= ox or ox + ow <= cx or cy + 300 <= oy or oy + oh <= cy
               for (_, ox, oy, ow, oh) in others):
            tx, ty = cx, cy
            placed = True
            break
    if placed:
        break
if not placed:
    tx, ty = 20, MH - 320
target = subprocess.Popen([
    '/Users/xuanzai/Desktop/all-project/glm-ask-modal/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    '/Users/xuanzai/Desktop/all-project/glm-ask-modal/scripts/drag-target.js',
    str(tx), str(ty)
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(4)
# 合成鼠标事件虽然受信任，但先显式激活目标窗口可避免 Chromium 偶发吞掉首击。
subprocess.run(['osascript', '-e', '''
tell application "System Events"
  set frontmost of first process whose unix id is ''' + str(target.pid) + ''' to true
end tell'''], capture_output=True, text=True, timeout=3)
time.sleep(0.3)
bx, by, bw, bh = tx, ty, 720, 300
# macOS 会避免窗口贴边/遮挡，实际 frame 可能与传入参数不同；必须按真实 frame 拖选。
actual = next((w for w in onscreen_windows('Electron') if w[2] == 720 and w[3] == 300), None)
if actual:
    _, bx, by, bw, bh = actual
results['target_frame'] = [bx, by, bw, bh]
# 页面首行文字中心（body margin 24px，font 26px/line-height 2 → 行1中心约 y+50）
ly1 = by + 50
lx1, lx2 = bx + 40, bx + 460

# 收起 GLM问问 弹窗（避免区域重叠干扰 zoneAt 判定），顺带复验快捷键
key(49, CMD | SHIFT)  # ⌘⇧Space
time.sleep(0.8)
results['hotkey_hides_ask'] = '780x640' not in glm_window_sizes()
if not results['hotkey_hides_ask']:
    key(49, CMD | SHIFT)
    time.sleep(0.8)
    results['hotkey_hides_ask'] = '780x640' not in glm_window_sizes()

# 测试 1：激活点击 + 拖选 → 工具条应出现
click(bx + 40, ly1)
time.sleep(0.5)
drag(lx1, ly1, lx2, ly1)
results['drag_shows_toolbar'] = wait_toolbar()

# 测试 2：双击选词 → 工具条应出现；点击他处应收起
# 注：Chromium 页面对「合成」双击可能不产生选词（真实双击正常），
# 因此先用 ⌘C 探测选区是否存在：无选区则跳过断言（记 skip）
click(bx + bw - 60, by + 40)
time.sleep(0.4)
results['toolbar_dismissed_by_click'] = not has_toolbar()
subprocess.run(['pbpaste'], capture_output=True)
dblclick(bx + 160, ly1)
time.sleep(0.3)
key(8, CMD)  # ⌘C 探测选区
time.sleep(0.4)
sel = subprocess.run(['pbpaste'], capture_output=True, text=True).stdout.strip()
results['dblclick_selection'] = sel[:40]
if sel:
    results['dblclick_shows_toolbar'] = wait_toolbar()
else:
    results['dblclick_shows_toolbar'] = 'skip(合成双击无选区)'

# 测试 3（可选，传 shot_ms 参数）：截图模式抑制 —— ⌘⌥A 后拖选不弹条，
# 抑制窗口结束后拖选恢复弹条。应用需以 GLM_SHOT_MS=<窗口毫秒> 启动。
shot_ms = int(sys.argv[1]) if len(sys.argv) > 1 else 0
if shot_ms > 0:
    click(bx + bw - 60, by + 40)
    time.sleep(0.4)
    key(0, CMD | ALT)  # ⌘⌥A
    time.sleep(0.4)
    drag(lx1, ly1, lx2, ly1)
    results['screenshot_no_toolbar'] = not wait_toolbar(1.5)
    key(53)  # Esc 关闭可能触发的截图覆盖层
    time.sleep(0.6)
    click(bx + 40, ly1)
    time.sleep(0.3)
    time.sleep(shot_ms / 1000 + 0.8)
    drag(lx1, ly1, lx2, ly1)
    results['after_window_toolbar'] = wait_toolbar()

# 清理：关闭目标窗口进程
target.terminate()

print(json.dumps(results, ensure_ascii=False, indent=2))
