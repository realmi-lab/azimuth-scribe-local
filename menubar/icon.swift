import AppKit
import Foundation

let target = URL(fileURLWithPath: CommandLine.arguments[1])
var chunks = Data()
func integer(_ value: UInt32) -> Data {
    var value = value.bigEndian
    return Data(bytes: &value, count: 4)
}
for (size, kind) in [(128, "ic07"), (256, "ic08"), (512, "ic09"), (1024, "ic10")] {
    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()
    let side = CGFloat(size)
    let rect = NSRect(x: side * 0.045, y: side * 0.045, width: side * 0.91, height: side * 0.91)
    NSColor(calibratedRed: 0.09, green: 0.29, blue: 0.46, alpha: 1).setFill()
    NSBezierPath(roundedRect: rect, xRadius: side * 0.20, yRadius: side * 0.20).fill()
    NSColor.white.setStroke()
    let mic = NSBezierPath(roundedRect: NSRect(x: side * 0.405, y: side * 0.39, width: side * 0.19, height: side * 0.37), xRadius: side * 0.095, yRadius: side * 0.095)
    mic.lineWidth = side * 0.029
    mic.stroke()
    let stand = NSBezierPath()
    stand.lineWidth = side * 0.029
    stand.lineCapStyle = .round
    stand.move(to: NSPoint(x: side * 0.31, y: side * 0.50))
    stand.curve(to: NSPoint(x: side * 0.69, y: side * 0.50), controlPoint1: NSPoint(x: side * 0.31, y: side * 0.18), controlPoint2: NSPoint(x: side * 0.69, y: side * 0.18))
    stand.move(to: NSPoint(x: side * 0.50, y: side * 0.26))
    stand.line(to: NSPoint(x: side * 0.50, y: side * 0.17))
    stand.move(to: NSPoint(x: side * 0.40, y: side * 0.17))
    stand.line(to: NSPoint(x: side * 0.60, y: side * 0.17))
    stand.stroke()
    image.unlockFocus()
    let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
    let png = bitmap.representation(using: .png, properties: [:])!
    chunks.append(kind.data(using: .ascii)!)
    chunks.append(integer(UInt32(png.count + 8)))
    chunks.append(png)
}
var output = "icns".data(using: .ascii)!
output.append(integer(UInt32(chunks.count + 8)))
output.append(chunks)
try output.write(to: target)
