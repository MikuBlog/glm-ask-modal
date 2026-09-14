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

var out: [String: Any] = ["bundleId": "", "appName": "", "text": "", "err": -1]

let sys = AXUIElementCreateSystemWide()
var frontApp: AnyObject?
let fr = AXUIElementCopyAttributeValue(sys, kAXFocusedApplicationAttribute as CFString, &frontApp)
out["err"] = Int(fr.rawValue)

if fr == .success, let app = frontApp {
    let axApp = app as! AXUIElement
    if let t = axString(axApp, kAXSelectedTextAttribute as CFString) {
        out["text"] = t
    } else {
        var focused: AnyObject?
        let fr2 = AXUIElementCopyAttributeValue(axApp, kAXFocusedUIElementAttribute as CFString, &focused)
        if fr2 == .success, let el = focused {
            out["text"] = axString(el as! AXUIElement, kAXSelectedTextAttribute as CFString) ?? ""
        }
    }
}

if let running = NSWorkspace.shared.frontmostApplication {
    out["bundleId"] = running.bundleIdentifier ?? ""
    if let name = running.localizedName, (out["appName"] as? String ?? "").isEmpty {
        out["appName"] = name
    }
}

if let data = try? JSONSerialization.data(withJSONObject: out),
   let s = String(data: data, encoding: .utf8) {
    print(s)
}
