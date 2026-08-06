import AppKit
import CoreGraphics
import Foundation

let projectDir = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let assetsDir = projectDir.appendingPathComponent("assets", isDirectory: true)
let iconsetDir = assetsDir.appendingPathComponent("AppIcon.iconset", isDirectory: true)
let icnsURL = assetsDir.appendingPathComponent("app-icon.icns")
let pngURL = assetsDir.appendingPathComponent("app-icon.png")

let iconFiles: [(name: String, pixels: Int)] = [
  ("icon_16x16.png", 16),
  ("icon_16x16@2x.png", 32),
  ("icon_32x32.png", 32),
  ("icon_32x32@2x.png", 64),
  ("icon_128x128.png", 128),
  ("icon_128x128@2x.png", 256),
  ("icon_256x256.png", 256),
  ("icon_256x256@2x.png", 512),
  ("icon_512x512.png", 512),
  ("icon_512x512@2x.png", 1024),
]

try FileManager.default.createDirectory(at: assetsDir, withIntermediateDirectories: true)
try? FileManager.default.removeItem(at: iconsetDir)
try FileManager.default.createDirectory(at: iconsetDir, withIntermediateDirectories: true)

for file in iconFiles {
  let image = drawIcon(pixels: file.pixels)
  let bitmap = NSBitmapImageRep(cgImage: image)
  guard let data = bitmap.representation(using: .png, properties: [:]) else {
    throw IconError("Could not encode \(file.name)")
  }
  try data.write(to: iconsetDir.appendingPathComponent(file.name))
}

try? FileManager.default.removeItem(at: pngURL)
try FileManager.default.copyItem(
  at: iconsetDir.appendingPathComponent("icon_512x512@2x.png"),
  to: pngURL
)

try? FileManager.default.removeItem(at: icnsURL)
let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["-c", "icns", iconsetDir.path, "-o", icnsURL.path]
try process.run()
process.waitUntilExit()
if process.terminationStatus != 0 {
  throw IconError("iconutil failed with status \(process.terminationStatus)")
}

print("Created \(icnsURL.path)")

func drawIcon(pixels: Int) -> CGImage {
  let side = 1024.0
  let scale = Double(pixels) / side
  let colorSpace = CGColorSpaceCreateDeviceRGB()
  guard let context = CGContext(
    data: nil,
    width: pixels,
    height: pixels,
    bitsPerComponent: 8,
    bytesPerRow: pixels * 4,
    space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  ) else {
    fatalError("Could not create bitmap context")
  }

  context.scaleBy(x: scale, y: scale)
  context.setAllowsAntialiasing(true)
  context.setShouldAntialias(true)

  let iconRect = CGRect(x: 72, y: 72, width: 880, height: 880)
  let iconPath = CGPath(roundedRect: iconRect, cornerWidth: 204, cornerHeight: 204, transform: nil)

  context.saveGState()
  context.setShadow(offset: CGSize(width: 0, height: -28), blur: 46, color: rgba("#1c3557", 0.18))
  context.setFillColor(rgba("#dce9fb", 1))
  context.addPath(iconPath)
  context.fillPath()
  context.restoreGState()

  context.saveGState()
  context.addPath(iconPath)
  context.clip()
  drawGradient(context, rect: iconRect, top: "#f8fbff", bottom: "#bfd7f4")
  drawGrid(context, rect: iconRect)
  context.restoreGState()

  let shadow = polygon([
    CGPoint(x: 304, y: 236),
    CGPoint(x: 760, y: 316),
    CGPoint(x: 852, y: 690),
    CGPoint(x: 494, y: 806),
    CGPoint(x: 292, y: 620),
  ])
  context.saveGState()
  context.setShadow(offset: CGSize(width: 0, height: -18), blur: 26, color: rgba("#122033", 0.20))
  context.addPath(shadow)
  context.setFillColor(rgba("#244a7a", 0.18))
  context.fillPath()
  context.restoreGState()

  let topFace = [
    CGPoint(x: 322, y: 578),
    CGPoint(x: 500, y: 740),
    CGPoint(x: 828, y: 686),
    CGPoint(x: 672, y: 536),
  ]
  let rightFace = [
    CGPoint(x: 672, y: 278),
    CGPoint(x: 828, y: 414),
    CGPoint(x: 828, y: 686),
    CGPoint(x: 672, y: 536),
  ]
  let frontFace = [
    CGPoint(x: 322, y: 248),
    CGPoint(x: 672, y: 278),
    CGPoint(x: 672, y: 536),
    CGPoint(x: 322, y: 578),
  ]

  fillFace(context, topFace, fill: "#8dd9ff", stroke: "#2672c9")
  fillFace(context, rightFace, fill: "#174c99", stroke: "#123f7e")
  fillFace(context, frontFace, fill: "#2f7de1", stroke: "#1f5fb8")
  drawFaceGrid(context, topFace, alpha: 0.18)
  drawFaceGrid(context, rightFace, alpha: 0.12)
  drawFaceGrid(context, frontFace, alpha: 0.16)

  let labels = [
    (1.22, 1.45, "#ef4444"),
    (2.65, 1.55, "#22c55e"),
    (1.38, 2.85, "#facc15"),
  ]
  for (u, v, hex) in labels {
    drawVoxelDot(context, face: frontFace, u: u / 5.0, v: v / 5.0, color: hex)
  }

  let slicePlane = [
    CGPoint(x: 468, y: 184),
    CGPoint(x: 600, y: 222),
    CGPoint(x: 714, y: 824),
    CGPoint(x: 582, y: 786),
  ]
  context.saveGState()
  context.setBlendMode(.normal)
  context.addPath(polygon(slicePlane))
  context.setFillColor(rgba("#ff9a3d", 0.40))
  context.fillPath()
  context.addPath(polygon(slicePlane))
  context.setStrokeColor(rgba("#f97316", 0.88))
  context.setLineWidth(14)
  context.strokePath()
  context.restoreGState()

  context.saveGState()
  context.move(to: CGPoint(x: 534, y: 204))
  context.addLine(to: CGPoint(x: 648, y: 804))
  context.setStrokeColor(rgba("#fff7ed", 0.72))
  context.setLineWidth(7)
  context.strokePath()
  context.restoreGState()

  context.saveGState()
  context.addPath(iconPath)
  context.setStrokeColor(rgba("#ffffff", 0.56))
  context.setLineWidth(8)
  context.strokePath()
  context.restoreGState()

  guard let image = context.makeImage() else {
    fatalError("Could not create icon image")
  }
  return image
}

func drawGradient(_ context: CGContext, rect: CGRect, top: String, bottom: String) {
  let colors = [rgba(top, 1), rgba(bottom, 1)] as CFArray
  guard let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) else {
    return
  }
  context.drawLinearGradient(
    gradient,
    start: CGPoint(x: rect.midX, y: rect.maxY),
    end: CGPoint(x: rect.midX, y: rect.minY),
    options: []
  )
}

func drawGrid(_ context: CGContext, rect: CGRect) {
  context.saveGState()
  context.setStrokeColor(rgba("#ffffff", 0.12))
  context.setLineWidth(2)
  for offset in stride(from: -320.0, through: 1040.0, by: 140.0) {
    context.move(to: CGPoint(x: rect.minX + offset, y: rect.minY))
    context.addLine(to: CGPoint(x: rect.minX + offset + 340, y: rect.maxY))
    context.move(to: CGPoint(x: rect.minX, y: rect.minY + offset))
    context.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + offset + 260))
  }
  context.strokePath()
  context.restoreGState()
}

func fillFace(_ context: CGContext, _ points: [CGPoint], fill: String, stroke: String) {
  context.saveGState()
  context.addPath(polygon(points))
  context.setFillColor(rgba(fill, 0.96))
  context.fillPath()
  context.addPath(polygon(points))
  context.setStrokeColor(rgba(stroke, 1))
  context.setLineWidth(10)
  context.strokePath()
  context.restoreGState()
}

func drawFaceGrid(_ context: CGContext, _ points: [CGPoint], alpha: CGFloat) {
  context.saveGState()
  context.addPath(polygon(points))
  context.clip()
  context.setStrokeColor(rgba("#ffffff", alpha))
  context.setLineWidth(3)
  for i in 2...3 {
    let t = CGFloat(i) / 5.0
    let a = lerp(points[0], points[1], t)
    let b = lerp(points[3], points[2], t)
    context.move(to: a)
    context.addLine(to: b)
    let c = lerp(points[0], points[3], t)
    let d = lerp(points[1], points[2], t)
    context.move(to: c)
    context.addLine(to: d)
  }
  context.strokePath()
  context.restoreGState()
}

func drawVoxelDot(_ context: CGContext, face: [CGPoint], u: CGFloat, v: CGFloat, color: String) {
  let center = bilerp(face[0], face[1], face[2], face[3], u, v)
  let radius = 40.0
  context.saveGState()
  context.setShadow(offset: CGSize(width: 0, height: -3), blur: 5, color: rgba("#0f172a", 0.20))
  context.setFillColor(rgba(color, 0.98))
  context.fillEllipse(in: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
  context.restoreGState()
}

func polygon(_ points: [CGPoint]) -> CGPath {
  let path = CGMutablePath()
  guard let first = points.first else {
    return path
  }
  path.move(to: first)
  for point in points.dropFirst() {
    path.addLine(to: point)
  }
  path.closeSubpath()
  return path
}

func lerp(_ a: CGPoint, _ b: CGPoint, _ t: CGFloat) -> CGPoint {
  CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
}

func bilerp(_ p00: CGPoint, _ p10: CGPoint, _ p11: CGPoint, _ p01: CGPoint, _ u: CGFloat, _ v: CGFloat) -> CGPoint {
  lerp(lerp(p00, p10, u), lerp(p01, p11, u), v)
}

func rgba(_ hex: String, _ alpha: CGFloat) -> CGColor {
  let text = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
  let value = Int(text, radix: 16) ?? 0
  return CGColor(
    srgbRed: CGFloat((value >> 16) & 0xff) / 255.0,
    green: CGFloat((value >> 8) & 0xff) / 255.0,
    blue: CGFloat(value & 0xff) / 255.0,
    alpha: alpha
  )
}

struct IconError: Error, CustomStringConvertible {
  let description: String

  init(_ description: String) {
    self.description = description
  }
}
