// 可选的原生划词助手：经 AX API 读取前台应用选中文本（不污染剪贴板）。
// 由 scripts/vendor.js 在 npm install 时尝试用 swiftc 编译；失败则应用走 Cmd+C 兜底。
import Foundation
import ApplicationServices
import AppKit

func axString(_ el: AXUIElement, _ attr: CFString) -> String? {
    var value: AnyObject?
    let r = AXUIElementCopyAttributeValue(el, attr, &value)
    guard r == .success, let s = value as? String else { return nil }
    return s
}

func axRange(_ el: AXUIElement, _ attr: CFString) -> CFRange? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(el, attr, &value) == .success,
          CFGetTypeID(value) == AXValueGetTypeID(),
          AXValueGetType(value as! AXValue) == .cfRange else { return nil }
    let axValue = value as! AXValue
    var range = CFRange()
    guard AXValueGetValue(axValue, .cfRange, &range) else { return nil }
    return range
}

func setAXFlag(_ app: AXUIElement, _ name: String) -> Bool {
    AXUIElementSetAttributeValue(app, name as CFString, kCFBooleanTrue) == .success
}

func isLikelyChromiumBrowser(_ bundleId: String) -> Bool {
    let bundle = bundleId.lowercased()
    return ["chrome", "chromium", "edge", "brave", "opera", "vivaldi", "arc", "dia"]
        .contains { bundle.contains($0) }
}

func normalizedSelectedText(_ raw: String?) -> String? {
    guard var text = raw else { return nil }
    text = text.replacingOccurrences(of: "\u{FFFC}", with: "")
    text = text.replacingOccurrences(of: "\u{FFFE}", with: "")
    return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : text
}

func selectedTextOnElement(_ el: AXUIElement) -> String? {
    if let direct = normalizedSelectedText(axString(el, kAXSelectedTextAttribute as CFString)) {
        return direct
    }

    // Web content often exposes only a range plus the node value. Derive the
    // selected substring from those attributes while keeping the range bounded.
    if let range = axRange(el, kAXSelectedTextRangeAttribute as CFString),
       let value = axString(el, kAXValueAttribute as CFString),
       range.location >= 0, range.length > 0 {
        let nsValue = value as NSString
        guard range.location < nsValue.length else { return nil }
        let maxLength = min(range.length, nsValue.length - range.location)
        return normalizedSelectedText(nsValue.substring(with: NSRange(location: range.location, length: maxLength)))
    }

    return nil
}

func findSelectedText(_ el: AXUIElement, depth: Int = 0, visited: inout Set<ObjectIdentifier>, budget: inout Int) -> String? {
    guard depth <= 12, budget > 0 else { return nil }
    budget -= 1
    let key = ObjectIdentifier(el)
    if visited.contains(key) { return nil }
    visited.insert(key)

    if let text = selectedTextOnElement(el) { return text }

    var childrenValue: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenValue) == .success,
       let children = childrenValue as? [AXUIElement] {
        for child in children.prefix(48) {
            if let text = findSelectedText(child, depth: depth + 1, visited: &visited, budget: &budget) {
                return text
            }
        }
    }

    // Chromium can expose selection state through the focused item's siblings
    // or ancestors (for example a text area inside a scroll container).
    if depth < 3 {
        var parentValue: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXParentAttribute as CFString, &parentValue) == .success,
           let parentObj = parentValue {
            let parent = parentObj as! AXUIElement
            if let text = findSelectedText(parent, depth: depth + 1, visited: &visited, budget: &budget) {
                return text
            }
        }
    }

    return nil
}

func findSelectedText(_ roots: [AXUIElement?]) -> String? {
    var visited = Set<ObjectIdentifier>()
    var budget = 240
    for root in roots {
        guard let root = root else { continue }
        if let text = findSelectedText(root, visited: &visited, budget: &budget) {
            return text
        }
    }
    return nil
}

func focusedElement(_ app: AXUIElement) -> AXUIElement? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &value) == .success,
          let obj = value else { return nil }
    return obj as! AXUIElement
}

func axAttributeNames(_ el: AXUIElement) -> [String] {
    var value: CFArray?
    guard AXUIElementCopyAttributeNames(el, &value) == .success,
          let names = value as? [String] else { return [] }
    return names
}

func elementInfo(_ el: AXUIElement) -> [String: Any] {
    let names = axAttributeNames(el)
    var info: [String: Any] = [
        "role": axString(el, kAXRoleAttribute as CFString) ?? "",
        "roleDescription": axString(el, kAXRoleDescriptionAttribute as CFString) ?? "",
        "supportsSelectedText": names.contains(kAXSelectedTextAttribute as String)
    ]
    if let text = axString(el, kAXSelectedTextAttribute as CFString) {
        info["selectedText"] = text
    }
    return info
}

func hitElementAt(_ x: Float, _ y: Float) -> AXUIElement? {
    let sys = AXUIElementCreateSystemWide()
    var value: AXUIElement?
    guard AXUIElementCopyElementAtPosition(sys, x, y, &value) == .success,
          let el = value else { return nil }
    return el
}

func frontmostAXApp() -> (running: NSRunningApplication, app: AXUIElement)? {
    guard let running = NSWorkspace.shared.frontmostApplication else { return nil }
    return (running, AXUIElementCreateApplication(running.processIdentifier))
}

func hitAncestorSupportsSelectedText(_ start: AXUIElement) -> Bool {
    var el: AXUIElement? = start
    for _ in 0..<6 {
        guard let current = el else { return false }
        if axAttributeNames(current).contains(kAXSelectedTextAttribute as String) { return true }
        var value: AnyObject?
        guard AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &value) == .success,
              let parent = value else { return false }
        el = (parent as! AXUIElement)
    }
    return false
}

func pasteboardInfo(_ name: String) -> [String: Any] {
    let pb = NSPasteboard(name: NSPasteboard.Name(name))
    return [
        "changeCount": pb.changeCount,
        "types": (pb.types ?? []).map { $0.rawValue }
    ]
}

func dragPasteboards() -> [String: Any] {
    return [
        "drag": pasteboardInfo("Apple CFPasteboard drag"),
        "generic": pasteboardInfo("Apple CFPasteboard generic"),
        "promise": pasteboardInfo("Apple CFPasteboard promise")
    ]
}

var out: [String: Any] = ["bundleId": "", "appName": "", "text": "", "err": -1]

if CommandLine.arguments.dropFirst().contains("--drag-pasteboards") {
    out = [
        "dragPasteboards": [
            "drag": pasteboardInfo("Apple CFPasteboard drag"),
            "generic": pasteboardInfo("Apple CFPasteboard generic"),
            "promise": pasteboardInfo("Apple CFPasteboard promise")
        ]
    ]
    if let data = try? JSONSerialization.data(withJSONObject: out),
       let s = String(data: data, encoding: .utf8) {
        print(s)
    }
    exit(0)
}

let frontmost = frontmostAXApp()
let bundleId = frontmost?.running.bundleIdentifier ?? ""

func querySelectedText(app: AXUIElement, hit: AXUIElement?) -> String? {
    if let text = selectedTextOnElement(app) { return text }
    let focused = focusedElement(app)
    return findSelectedText([focused, hit])
}

if let front = frontmost {
    out["bundleId"] = bundleId
    out["appName"] = front.running.localizedName ?? ""

    // Keep a single unresponsive AX node from consuming the helper's total
    // timeout. Real selected-text attributes answer almost immediately.
    AXUIElementSetMessagingTimeout(front.app, 0.2)

    // Chromium/Electron only builds its external accessibility tree after an
    // assistive client opts in. Set the flag before the first AX query.
    let manualEnabled = setAXFlag(front.app, "AXManualAccessibility")

    let args = CommandLine.arguments
    let hitElement: AXUIElement?
    if args.count >= 3, let x = Float(args[1]), let y = Float(args[2]) {
        hitElement = hitElementAt(x, y)
    } else {
        hitElement = nil
    }
    if let hit = hitElement {
        AXUIElementSetMessagingTimeout(hit, 0.2)
    }

    var text = querySelectedText(app: front.app, hit: hitElement)
    if text == nil {
        // AXManualAccessibility is normally sufficient for Electron. Chromium
        // browsers sometimes need the legacy enhanced-UI switch as a retry.
        let shouldEnhance = isLikelyChromiumBrowser(bundleId)
        let enhancedEnabled = shouldEnhance ? setAXFlag(front.app, "AXEnhancedUserInterface") : false
        if shouldEnhance && !enhancedEnabled {
            out["accessibility"] = ["manual": manualEnabled, "enhanced": false]
        } else {
            usleep(useconds_t(shouldEnhance ? 100_000 : 40_000))
            text = querySelectedText(app: front.app, hit: hitElement)
            out["accessibility"] = ["manual": manualEnabled, "enhanced": shouldEnhance]
        }
    }

    if let text = text {
        out["text"] = text
        out["err"] = 0
    } else {
        out["err"] = -25204
    }

    if let hit = hitElement {
        var info = elementInfo(hit)
        info["ancestorSupportsSelectedText"] = hitAncestorSupportsSelectedText(hit)
        out["hit"] = info
    }
} else {
    out["err"] = -25208
}

out["dragPasteboards"] = dragPasteboards()

if let data = try? JSONSerialization.data(withJSONObject: out),
   let s = String(data: data, encoding: .utf8) {
    print(s)
}
