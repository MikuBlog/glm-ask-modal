# 切桌面自动隐藏 + 快捷键开关语义 测试
# 前置：GLM问问 运行中（唯一实例）
import Quartz, subprocess, time, json, sys

CMD = Quartz.kCGEventFlagMaskCommand
SHIFT = Quartz.kCGEventFlagMaskShift
CTRL = Quartz.kCGEventFlagMaskControl

def key(code, flags=0):
    for down in (True, False):
        e = Quartz.CGEventCreateKeyboardEvent(None, code, down)
        if flags:
            Quartz.CGEventSetFlags(e, flags)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)
        time.sleep(0.03)

def glm_window_sizes():
    # CG 窗口列表同时支持打包实例（GLM问问）和开发实例（Electron）。
    opts = Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements
    wins = Quartz.CGWindowListCopyWindowInfo(opts, Quartz.kCGNullWindowID) or []
    return ','.join(f"{int(w.get('kCGWindowBounds', {}).get('Width', 0))}x{int(w.get('kCGWindowBounds', {}).get('Height', 0))}"
                    for w in wins
                    if w.get('kCGWindowOwnerName') in ('GLM问问', 'Electron'))

def ask_visible():
    return '780x640' in glm_window_sizes()

def marker_on_screen():
    # 拖选目标窗口（720x300）作为空间标记：它只在创建它的那个空间显示
    opts = Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements
    wins = Quartz.CGWindowListCopyWindowInfo(opts, Quartz.kCGNullWindowID) or []
    for w in wins:
        b = w.get('kCGWindowBounds', {})
        if w.get('kCGWindowOwnerName') == 'Electron' and int(b.get('Width', 0)) == 720:
            return True
    return False

# 0. 启动空间标记窗口
marker = subprocess.Popen([
    '/Users/xuanzai/Desktop/all-project/glm-ask-modal/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    '/Users/xuanzai/Desktop/all-project/glm-ask-modal/scripts/drag-target.js', '20', '849'
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(3)

results = {}

# 1. 快捷键开关语义：可见 → 按热键 → 隐藏；再按 → 显示
s0 = ask_visible()
key(49, CMD | SHIFT)  # ⌘⇧Space
time.sleep(0.6)
s1 = ask_visible()
key(49, CMD | SHIFT)
time.sleep(0.6)
s2 = ask_visible()
results['toggle_semantics'] = (s0 != s1 and s1 != s2 and s0 == s2)
results['states'] = [s0, s1, s2]
results['marker_ready'] = marker_on_screen()

# 2. 确保弹窗可见，然后切换桌面 → 应立即隐藏
if not ask_visible():
    key(49, CMD | SHIFT)
    time.sleep(0.6)
results['ask_visible_before_switch'] = ask_visible()
results['marker_before_switch'] = marker_on_screen()
# 依次尝试 Ctrl+← / Ctrl+→，以标记窗口是否从屏幕消失判定空间确实切换
switched = False
for kcode in (123, 124):
    key(kcode, CTRL)
    time.sleep(1.2)
    if not marker_on_screen():
        switched = True
        break
results['space_switched'] = switched
results['hidden_after_space_switch'] = not ask_visible()
if switched:
    key(124 if kcode == 123 else 123, CTRL)  # 切回原桌面
    time.sleep(1.2)
results['visible_after_switch_back'] = ask_visible()
marker.terminate()

print(json.dumps(results, ensure_ascii=False, indent=2))
