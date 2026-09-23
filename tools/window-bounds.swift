// Prints "x y w h" (points) of the given process's main on-screen window.
import CoreGraphics
import Foundation

let pid = Int(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
let wins = list.filter { ($0["kCGWindowOwnerPID"] as? Int) == pid && ($0["kCGWindowLayer"] as? Int) == 0 }
guard let w = wins.max(by: {
  let a = $0["kCGWindowBounds"] as! [String: Double], b = $1["kCGWindowBounds"] as! [String: Double]
  return a["Width"]! * a["Height"]! < b["Width"]! * b["Height"]!
}) else { exit(1) }
let b = w["kCGWindowBounds"] as! [String: Double]
print(Int(b["X"]!), Int(b["Y"]!), Int(b["Width"]!), Int(b["Height"]!))
