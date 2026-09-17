// 可选的原生划词助手：AX/Text Marker 直读选中文本；
// --force-menu-copy 时执行目标应用 Copy 菜单并备份/恢复剪贴板。
import Foundation
import ApplicationServices
import AppKit

let selectedTextMarkerRangeAttribute = "AXSelectedTextMarkerRange" as CFString
let stringForTextMarkerRangeAttribute = "AXStringForTextMarkerRange" as CFString

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

func axBoolean(_ el: AXUIElement, _ attr: CFString) -> Bool? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(el, attr, &value) == .success else { return nil }
    return value as? Bool
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &value) == .success,
          let children = value as? [AXUIElement] else { return [] }
    return children
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

    // Safari and some WebKit views expose selection only through text markers.
    if let text = normalizedSelectedText(selectedTextByTextMarkerRange(el)) {
        return text
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

func selectedTextByTextMarkerRange(_ el: AXUIElement) -> String? {
    var markerRangeValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, selectedTextMarkerRangeAttribute, &markerRangeValue) == .success,
          let markerRange = markerRangeValue else { return nil }

    var textValue: CFTypeRef?
    guard AXUIElementCopyParameterizedAttributeValue(
        el,
        stringForTextMarkerRangeAttribute,
        markerRange,
        &textValue
    ) == .success else { return nil }
    return textValue as? String
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
        "supportsSelectedText": names.contains(kAXSelectedTextAttribute as String),
        "supportsTextMarker": names.contains(selectedTextMarkerRangeAttribute as String)
    ]
    if let text = axString(el, kAXSelectedTextAttribute as CFString) {
        info["selectedText"] = text
    }
    if let range = axRange(el, kAXSelectedTextRangeAttribute as CFString) {
        info["selectedTextRange"] = [
            "location": range.location,
            "length": range.length
        ]
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

let copyMenuTitles: Set<String> = [
    "Copy", "拷贝", "复制", "拷貝", "複製", "コピー", "복사",
    "Copier", "Copiar", "Copia", "Kopieren", "Копировать"
]

func isCopyMenuItem(_ el: AXUIElement) -> Bool {
    if axString(el, kAXIdentifierAttribute as CFString) == "copy:" { return true }
    guard let title = axString(el, kAXTitleAttribute as CFString),
          copyMenuTitles.contains(title) else { return false }
    // A bare localized title can collide with custom menu items. Require the
    // standard Cmd+C marker unless the app omits both identifier and shortcut.
    let cmdChar = axString(el, "AXMenuItemCmdChar" as CFString)
    return cmdChar == nil || cmdChar?.lowercased() == "c"
}

func findCopyMenuItem(in root: AXUIElement, budget: Int = 1200) -> AXUIElement? {
    var stack: [(element: AXUIElement, depth: Int)] = [(root, 0)]
    var visited = Set<ObjectIdentifier>()
    var remaining = budget

    while !stack.isEmpty, remaining > 0 {
        let item = stack.removeLast()
        remaining -= 1
        let key = ObjectIdentifier(item.element)
        guard !visited.contains(key) else { continue }
        visited.insert(key)

        if isCopyMenuItem(item.element) { return item.element }
        guard item.depth < 8 else { continue }
        for child in axChildren(item.element).reversed() {
            stack.append((child, item.depth + 1))
        }
    }
    return nil
}

func findCopyMenuItem(inApp app: AXUIElement) -> AXUIElement? {
    var menuBarValue: AnyObject?
    guard AXUIElementCopyAttributeValue(app, kAXMenuBarAttribute as CFString, &menuBarValue) == .success,
          let menuBarObject = menuBarValue else { return nil }
    let menuBar = menuBarObject as! AXUIElement

    let menus = axChildren(menuBar)
    // The Edit menu is normally the fourth top-level menu. Search outward from
    // it, then cover the remaining menus for apps with non-standard layouts.
    let preferred = [3, 2, 4, 1, 5, 0, 6].filter { $0 < menus.count }
    let order = preferred + menus.indices.filter { !preferred.contains($0) }
    for index in order {
        if let item = findCopyMenuItem(in: menus[index]) { return item }
    }
    return nil
}

func backupPasteboard() -> [[String: Data]] {
    guard let items = NSPasteboard.general.pasteboardItems else { return [] }
    return items.map { item in
        var flavors: [String: Data] = [:]
        for type in item.types {
            if let data = item.data(forType: type) {
                flavors[type.rawValue] = data
            }
        }
        return flavors
    }
}

func restorePasteboard(_ items: [[String: Data]]) -> Bool {
    guard !items.isEmpty else { return false }
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    let restored = items.map { flavors in
        let item = NSPasteboardItem()
        for (type, data) in flavors { item.setData(data, forType: NSPasteboard.PasteboardType(rawValue: type)) }
        return item
    }
    return pasteboard.writeObjects(restored)
}

func restorePasteboardBackup(_ items: [[String: Data]]) -> Bool {
    guard !items.isEmpty else { return NSPasteboard.general.clearContents() >= 0 }
    return restorePasteboard(items)
}

func postCommandCToProcess(_ pid: pid_t) {
    let source = CGEventSource(stateID: .combinedSessionState)
    for keyDown in [true, false] {
        guard let event = CGEvent(
            keyboardEventSource: source,
            virtualKey: 8,
            keyDown: keyDown
        ) else { continue }
        event.flags = [.maskCommand]
        event.postToPid(pid)
        usleep(20_000)
    }
}

func copySelectedText(
    action: () throws -> Void,
    timeout: TimeInterval,
    info: [String: Any]
) -> (text: String?, info: [String: Any]) {
    var info = info
    let pasteboard = NSPasteboard.general
    let backup = backupPasteboard()

    // Clearing after the backup forces apps to write even when the selection is
    // identical to the user's current clipboard; otherwise changeCount cannot
    // distinguish a real copy from an unchanged pasteboard.
    pasteboard.clearContents()
    let initialChangeCount = pasteboard.changeCount
    do {
        try action()
    } catch {
        info["actionError"] = "\(error)"
        _ = restorePasteboardBackup(backup)
        info["restored"] = true
        return (nil, info)
    }

    var captured: String?
    var acceptedChangeCount = initialChangeCount
    var capturedAt: Date?
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if pasteboard.changeCount != initialChangeCount {
            if captured == nil {
                acceptedChangeCount = pasteboard.changeCount
                if let text = normalizedSelectedText(pasteboard.string(forType: .string)) {
                    captured = text
                    capturedAt = Date()
                }
            }
        }
        if let capturedAt, Date().timeIntervalSince(capturedAt) >= 0.05 { break }
        usleep(20_000)
    }

    let changed = pasteboard.changeCount != initialChangeCount
    let thirdPartyChanged = pasteboard.changeCount != acceptedChangeCount
    info["changed"] = changed
    info["restored"] = false
    if !thirdPartyChanged {
        info["restoreAttempted"] = true
        info["restored"] = restorePasteboardBackup(backup)
    }
    return (captured, info)
}

func copySelectedTextWithMenuAction(_ app: AXUIElement) -> (text: String?, info: [String: Any]) {
    guard let item = findCopyMenuItem(inApp: app) else {
        return (nil, ["found": false, "state": "missing"])
    }
    AXUIElementSetMessagingTimeout(item, 0.5)

    var info: [String: Any] = [
        "found": true,
        "title": axString(item, kAXTitleAttribute as CFString) ?? "",
        "identifier": axString(item, kAXIdentifierAttribute as CFString) ?? ""
    ]
    if let enabled = axBoolean(item, kAXEnabledAttribute as CFString) {
        info["enabled"] = enabled
        guard enabled else { return (nil, info) }
    } else {
        // Most apps omit AXEnabled for menu items that are available. Treat an
        // explicit false as disabled, but do not reject apps that omit it.
        info["enabled"] = true
    }

    var pressError = AXError.cannotComplete
    var result = copySelectedText(
        action: { pressError = AXUIElementPerformAction(item, "AXPress" as CFString) },
        timeout: bundleId == "com.apple.Safari" ? 0.5 : 0.35,
        info: info
    )
    result.info["pressError"] = Int(pressError.rawValue)
    guard pressError == .success else { return (nil, result.info) }
    return result
}

func copySelectedTextWithShortcut(_ running: NSRunningApplication) -> (text: String?, info: [String: Any]) {
    copySelectedText(
        action: { postCommandCToProcess(running.processIdentifier) },
        timeout: bundleId == "com.apple.Safari" ? 0.5 : 0.35,
        info: [
            "found": true,
            "enabled": true,
            "title": "Cmd+C",
            "postedToPid": Int(running.processIdentifier)
        ]
    )
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
let args = CommandLine.arguments
let forceMenuCopy = args.dropFirst().contains("--force-menu-copy")
let shortcutCopy = args.dropFirst().contains("--shortcut-copy")
let forcedCopy = forceMenuCopy || shortcutCopy

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

    let hitElement: AXUIElement?
    if args.count >= 3, let x = Float(args[1]), let y = Float(args[2]) {
        hitElement = hitElementAt(x, y)
    } else {
        hitElement = nil
    }
    if let hit = hitElement {
        AXUIElementSetMessagingTimeout(hit, 0.2)
    }

    var text = forcedCopy ? nil : querySelectedText(app: front.app, hit: hitElement)
    if text == nil && !forcedCopy {
        // Selection state can be committed slightly after mouse-up in
        // Chromium/Electron. Poll once before deciding the hit was non-text.
        usleep(50_000)
        text = querySelectedText(app: front.app, hit: hitElement)
    }
    if text == nil && !forcedCopy {
        // AXManualAccessibility is normally sufficient for Electron. Chromium
        // browsers sometimes need the legacy enhanced-UI switch as a retry.
        let shouldEnhance = isLikelyChromiumBrowser(bundleId)
        let enhancedEnabled = shouldEnhance ? setAXFlag(front.app, "AXEnhancedUserInterface") : false
        if shouldEnhance && !enhancedEnabled {
            out["accessibility"] = ["manual": manualEnabled, "enhanced": false]
        } else {
            usleep(useconds_t(shouldEnhance ? 120_000 : 100_000))
            text = querySelectedText(app: front.app, hit: hitElement)
            out["accessibility"] = ["manual": manualEnabled, "enhanced": shouldEnhance]
        }
    }

    if let text = text {
        out["text"] = text
        out["err"] = 0
        out["strategy"] = "accessibility"
    } else {
        out["err"] = -25204
    }

    // This mode is used after the Electron main process has excluded object
    // drags and known non-text targets. It mirrors SelectedTextKit's preferred
    // fallback: press the target app's own Edit > Copy item instead of sending
    // a global Cmd+C event.
    if text == nil && forcedCopy {
        let copyResult = forceMenuCopy
            ? copySelectedTextWithMenuAction(front.app)
            : copySelectedTextWithShortcut(front.running)
        out["menu"] = copyResult.info
        if let text = copyResult.text {
            out["text"] = text
            out["err"] = 0
            out["strategy"] = forceMenuCopy ? "menu-action" : "shortcut"
        }
        if let restored = copyResult.info["restored"] as? Bool {
            out["pasteboardRestored"] = restored
        }
    }

    if let hit = hitElement {
        var info = elementInfo(hit)
        info["ancestorSupportsSelectedText"] = hitAncestorSupportsSelectedText(hit)
        out["hit"] = info
    }
    if args.count >= 5, let x2 = Float(args[3]), let y2 = Float(args[4]),
       let endHit = hitElementAt(x2, y2) {
        var info = elementInfo(endHit)
        info["ancestorSupportsSelectedText"] = hitAncestorSupportsSelectedText(endHit)
        out["hitEnd"] = info
    }
    if let focused = focusedElement(front.app) {
        out["focused"] = elementInfo(focused)
    }
} else {
    out["err"] = -25208
}

out["dragPasteboards"] = dragPasteboards()

if let data = try? JSONSerialization.data(withJSONObject: out),
   let s = String(data: data, encoding: .utf8) {
    print(s)
}
