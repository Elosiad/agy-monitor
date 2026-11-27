import AppKit
import CoreGraphics
import Foundation
import ImageIO
import QuartzCore

// MARK: - Models

struct CustomPetFrameRef {
    let filename: String
    let mime: String
}

struct CustomPetEntry {
    let id: String
    let name: String
    let kind: String
    let fps: Int
    let filename: String
    let mime: String
    let frames: [CustomPetFrameRef]
    let stateFrames: [String: [CustomPetFrameRef]]
}

struct PetConfig {
    var enabled: Bool = false
    var activePetId: String = "neko"
    var displayMode: String = "auto"
    var size: Int = 100
    var opacity: Int = 95
    var alwaysOnTop: Bool = true
    var showSpeechBubble: Bool = true
    var bubbleTemplate: String = "入 {in} · 出 {out}"
    var autoWander: Bool = true
    var selectable: Bool = true
    var posX: Int? = nil
    var posY: Int? = nil
    var petsDir: String = ""
    var customImagePath: String = ""
    var activeCustomPet: CustomPetEntry? = nil
    var customPets: [CustomPetEntry] = []
}

struct SessionProgressItem {
    let id: String
    let name: String
    let status: String
    let progress: Int
    let tag: String
    let content: String
}

struct PetTelemetry {
    var percent: Int = 0
    var tokPerSec: Double? = nil
    var cacheHitPct: Int? = nil
    var latestInputTokens: Int64 = 0
    var latestOutputTokens: Int64 = 0
    var latestStepAtMs: Int64 = 0
    var upstreamModelId: String = ""
    var activeSessionCount: Int = 0
    var unreadSessionCount: Int = 0
    var agentState: String = "idle"
    var quotaGemini5h: Int? = nil
    var quotaGeminiWeekly: Int? = nil
    var quotaClaude5h: Int? = nil
    var quotaClaudeWeekly: Int? = nil
    var sessionProgress: [SessionProgressItem] = []
}

struct PetThemePalette {
    var accent: String = "#5B8CFF"
    var contrast: String = "#E5A84B"
    var tertiary: String = "#3DC2A7"
    var canvas: String = "#14161D"
    var chrome: String = "#1B1E28"
    var bubble: String = "#212533"
    var radius: Int = 10
}

// MARK: - Helpers

func clampInt(_ v: Int, _ minVal: Int, _ maxVal: Int) -> Int {
    return max(minVal, min(maxVal, v))
}

func clampDouble(_ v: Double, _ minVal: Double, _ maxVal: Double) -> Double {
    return max(minVal, min(maxVal, v))
}

func colorFromHex(_ hex: String, alpha: CGFloat = 1.0, fallback: NSColor = .systemBlue) -> NSColor {
    var clean = hex.trimmingCharacters(in: .whitespacesAndNewlines)
    if clean.hasPrefix("#") { clean.removeFirst() }
    if clean.count == 3 {
        clean = clean.map { "\($0)\($0)" }.joined()
    }
    guard clean.count == 6, let val = UInt32(clean, radix: 16) else {
        return fallback.withAlphaComponent(alpha)
    }
    let r = CGFloat((val >> 16) & 0xFF) / 255.0
    let g = CGFloat((val >> 8) & 0xFF) / 255.0
    let b = CGFloat(val & 0xFF) / 255.0
    return NSColor(srgbRed: r, green: g, blue: b, alpha: alpha)
}

func isDarkColor(_ color: NSColor) -> Bool {
    guard let rgb = color.usingColorSpace(.sRGB) else { return true }
    let lum = 0.299 * rgb.redComponent + 0.587 * rgb.greenComponent + 0.114 * rgb.blueComponent
    return lum < 0.5
}

func formatTokenCount(_ count: Int64) -> String {
    if count >= 1_000_000 {
        return String(format: "%.1fM", Double(count) / 1_000_000.0)
    }
    if count >= 1_000 {
        return String(format: "%.1fk", Double(count) / 1_000.0)
    }
    return "\(max(0, count))"
}

func stripUtf8Bom(_ data: Data) -> Data {
    if data.count >= 3 && data[0] == 0xEF && data[1] == 0xBB && data[2] == 0xBF {
        return data.subdata(in: 3..<data.count)
    }
    return data
}

func atomicWriteData(_ data: Data, to path: String) throws {
    let url = URL(fileURLWithPath: path)
    let dir = url.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let tmpPath = "\(path).\(getpid()).\(UUID().uuidString.prefix(8)).tmp"
    let tmpUrl = URL(fileURLWithPath: tmpPath)
    try data.write(to: tmpUrl, options: .atomic)
    _ = rename(tmpPath, path)
    if FileManager.default.fileExists(atPath: tmpPath) {
        try? FileManager.default.removeItem(atPath: tmpPath)
    }
}

func jsonInt(_ obj: Any?) -> Int? {
    if let n = obj as? NSNumber { return n.intValue }
    if let s = obj as? String, let v = Int(s) { return v }
    return nil
}

func jsonInt64(_ obj: Any?) -> Int64? {
    if let n = obj as? NSNumber { return n.int64Value }
    if let s = obj as? String, let v = Int64(s) { return v }
    return nil
}

func jsonDouble(_ obj: Any?) -> Double? {
    if let n = obj as? NSNumber { return n.doubleValue }
    if let s = obj as? String, let v = Double(s) { return v }
    return nil
}

func jsonBool(_ obj: Any?) -> Bool? {
    if let b = obj as? Bool { return b }
    if let n = obj as? NSNumber { return n.boolValue }
    if let s = obj as? String {
        let lower = s.lowercased()
        if lower == "true" || lower == "1" { return true }
        if lower == "false" || lower == "0" { return false }
    }
    return nil
}

func jsonString(_ obj: Any?) -> String? {
    if let s = obj as? String { return s }
    return nil
}

// MARK: - Pet Stage View

final class PetStageView: NSView {
    var petId: String = "neko"
    var theme: PetThemePalette = PetThemePalette()
    var agentState: String = "idle"
    var facingRight: Bool = true
    var bobOffset: CGFloat = 0
    var squashX: CGFloat = 1.0
    var squashY: CGFloat = 1.0
    var tiltDegrees: CGFloat = 0
    var eyeScaleY: CGFloat = 1.0
    var phase: Double = 0
    var customImage: NSImage? = nil

    var onDragStart: ((NSPoint) -> Void)?
    var onDragMove: ((NSPoint) -> Void)?
    var onDragEnd: ((Bool) -> Void)?
    var onSingleClick: (() -> Void)?
    var onDoubleClick: (() -> Void)?
    var onRightMenu: ((NSEvent) -> Void)?

    private var dragOriginScreen: NSPoint = .zero
    private var didDrag: Bool = false

    override var isFlipped: Bool { return false }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        return true
    }

    override func mouseDown(with event: NSEvent) {
        dragOriginScreen = NSEvent.mouseLocation
        didDrag = false
        onDragStart?(dragOriginScreen)
    }

    override func mouseDragged(with event: NSEvent) {
        let cur = NSEvent.mouseLocation
        let dx = cur.x - dragOriginScreen.x
        let dy = cur.y - dragOriginScreen.y
        if !didDrag && hypot(dx, dy) >= 4.0 {
            didDrag = true
        }
        if didDrag {
            onDragMove?(cur)
        }
    }

    override func mouseUp(with event: NSEvent) {
        if didDrag {
            didDrag = false
            onDragEnd?(true)
            return
        }
        onDragEnd?(false)
        if event.clickCount >= 2 {
            onDoubleClick?()
        } else {
            onSingleClick?()
        }
    }

    override func rightMouseDown(with event: NSEvent) {
        onRightMenu?(event)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }

        ctx.saveGState()
        let cx = bounds.midX
        let cy = bounds.midY + bobOffset

        ctx.translateBy(x: cx, y: cy)
        ctx.rotate(by: tiltDegrees * .pi / 180.0)
        let flipX: CGFloat = facingRight ? 1.0 : -1.0
        ctx.scaleBy(x: flipX * squashX, y: squashY)

        if let img = customImage {
            let side = min(bounds.width, bounds.height) * 0.90
            let dest = CGRect(x: -side / 2.0, y: -side / 2.0, width: side, height: side)
            // Preserve aspect ratio within stage square
            let imgSize = img.size
            if imgSize.width > 0 && imgSize.height > 0 {
                let ratio = min(side / imgSize.width, side / imgSize.height)
                let drawW = imgSize.width * ratio
                let drawH = imgSize.height * ratio
                let aspectRect = CGRect(x: -drawW / 2.0, y: -drawH / 2.0, width: drawW, height: drawH)
                img.draw(in: aspectRect, from: .zero, operation: .sourceOver, fraction: 1.0)
            } else {
                img.draw(in: dest, from: .zero, operation: .sourceOver, fraction: 1.0)
            }
        } else {
            let scale = min(bounds.width, bounds.height) / 112.0
            ctx.scaleBy(x: scale, y: scale)
            drawBuiltinPet(ctx: ctx)
        }
        ctx.restoreGState()

        // Mood badge in top-right (never flipped)
        drawMoodBadge(ctx: ctx)
    }

    private func drawBuiltinPet(ctx: CGContext) {
        let accent = colorFromHex(theme.accent, fallback: .systemBlue)
        let contrast = colorFromHex(theme.contrast, fallback: .systemOrange)
        let tertiary = colorFromHex(theme.tertiary, fallback: .systemTeal)

        switch petId {
        case "ghost":
            drawGhost(ctx: ctx, accent: accent, tertiary: tertiary)
        case "mecha":
            drawMecha(ctx: ctx, accent: accent, contrast: contrast, tertiary: tertiary)
        default:
            drawNeko(ctx: ctx, accent: accent, contrast: contrast)
        }
    }

    private func drawNeko(ctx: CGContext, accent: NSColor, contrast: NSColor) {
        let bodyColor = NSColor(srgbRed: 0.14, green: 0.16, blue: 0.22, alpha: 1.0)
        let innerEarColor = accent.withAlphaComponent(0.65)
        let eyeColor = contrast

        // Shadow
        ctx.setFillColor(NSColor.black.withAlphaComponent(0.20).cgColor)
        ctx.fillEllipse(in: CGRect(x: -26, y: -42, width: 52, height: 10))

        // Tail
        let tailWag = CGFloat(sin(phase * 2.2)) * 6.0
        let tailPath = CGMutablePath()
        tailPath.move(to: CGPoint(x: -20, y: -22))
        tailPath.addCurve(
            to: CGPoint(x: -38, y: 2 + tailWag),
            control1: CGPoint(x: -36, y: -24),
            control2: CGPoint(x: -44, y: -6 + tailWag * 0.5)
        )
        ctx.setStrokeColor(bodyColor.cgColor)
        ctx.setLineWidth(7.0)
        ctx.setLineCap(.round)
        ctx.addPath(tailPath)
        ctx.strokePath()

        // Body
        ctx.setFillColor(bodyColor.cgColor)
        ctx.fillEllipse(in: CGRect(x: -24, y: -36, width: 48, height: 38))

        // Head
        ctx.fillEllipse(in: CGRect(x: -27, y: -12, width: 54, height: 44))

        // Ears
        for sign: CGFloat in [-1, 1] {
            let ear = CGMutablePath()
            ear.move(to: CGPoint(x: sign * 24, y: 18))
            ear.addLine(to: CGPoint(x: sign * 27, y: 40))
            ear.addLine(to: CGPoint(x: sign * 8, y: 28))
            ear.closeSubpath()
            ctx.setFillColor(bodyColor.cgColor)
            ctx.addPath(ear)
            ctx.fillPath()

            let inner = CGMutablePath()
            inner.move(to: CGPoint(x: sign * 22, y: 21))
            inner.addLine(to: CGPoint(x: sign * 24, y: 34))
            inner.addLine(to: CGPoint(x: sign * 12, y: 27))
            inner.closeSubpath()
            ctx.setFillColor(innerEarColor.cgColor)
            ctx.addPath(inner)
            ctx.fillPath()
        }

        // Collar
        ctx.setStrokeColor(accent.cgColor)
        ctx.setLineWidth(3.0)
        ctx.move(to: CGPoint(x: -16, y: -10))
        ctx.addLine(to: CGPoint(x: 16, y: -10))
        ctx.strokePath()
        ctx.setFillColor(contrast.cgColor)
        ctx.fillEllipse(in: CGRect(x: -4, y: -16, width: 8, height: 8))

        // Eyes
        let eyeH = max(1.5, 9.0 * eyeScaleY)
        let eyeY = 9.0 - eyeH / 2.0
        ctx.setFillColor(eyeColor.cgColor)
        ctx.fillEllipse(in: CGRect(x: -15, y: eyeY, width: 8, height: eyeH))
        ctx.fillEllipse(in: CGRect(x: 7, y: eyeY, width: 8, height: eyeH))

        if eyeScaleY > 0.5 {
            ctx.setFillColor(NSColor.white.withAlphaComponent(0.9).cgColor)
            ctx.fillEllipse(in: CGRect(x: -11, y: eyeY + eyeH * 0.5, width: 2.5, height: 2.5))
            ctx.fillEllipse(in: CGRect(x: 11, y: eyeY + eyeH * 0.5, width: 2.5, height: 2.5))
        }

        // Nose & mouth
        ctx.setFillColor(NSColor(srgbRed: 0.96, green: 0.56, blue: 0.68, alpha: 1.0).cgColor)
        ctx.fillEllipse(in: CGRect(x: -2.5, y: 1, width: 5, height: 3.5))
    }

    private func drawGhost(ctx: CGContext, accent: NSColor, tertiary: NSColor) {
        let glow = accent.withAlphaComponent(0.24)
        ctx.setFillColor(glow.cgColor)
        ctx.fillEllipse(in: CGRect(x: -36, y: -36, width: 72, height: 72))

        let wave = CGFloat(sin(phase * 3.0)) * 2.5
        let bodyPath = CGMutablePath()
        bodyPath.move(to: CGPoint(x: -26, y: -26))
        bodyPath.addLine(to: CGPoint(x: -26, y: 8))
        bodyPath.addCurve(
            to: CGPoint(x: 26, y: 8),
            control1: CGPoint(x: -26, y: 40),
            control2: CGPoint(x: 26, y: 40)
        )
        bodyPath.addLine(to: CGPoint(x: 26, y: -26))
        bodyPath.addQuadCurve(to: CGPoint(x: 9, y: -26), control: CGPoint(x: 17, y: -34 + wave))
        bodyPath.addQuadCurve(to: CGPoint(x: -9, y: -26), control: CGPoint(x: 0, y: -18 - wave))
        bodyPath.addQuadCurve(to: CGPoint(x: -26, y: -26), control: CGPoint(x: -17, y: -34 + wave))
        bodyPath.closeSubpath()

        ctx.setFillColor(NSColor(srgbRed: 0.88, green: 0.94, blue: 1.0, alpha: 0.94).cgColor)
        ctx.addPath(bodyPath)
        ctx.fillPath()
        ctx.setStrokeColor(accent.withAlphaComponent(0.85).cgColor)
        ctx.setLineWidth(2.2)
        ctx.addPath(bodyPath)
        ctx.strokePath()

        // Eyes
        let eyeH = max(1.5, 9.0 * eyeScaleY)
        let eyeY = 8.0 - eyeH / 2.0
        ctx.setFillColor(accent.cgColor)
        ctx.fillEllipse(in: CGRect(x: -14, y: eyeY, width: 7.5, height: eyeH))
        ctx.fillEllipse(in: CGRect(x: 6.5, y: eyeY, width: 7.5, height: eyeH))

        // Cheeks
        ctx.setFillColor(tertiary.withAlphaComponent(0.55).cgColor)
        ctx.fillEllipse(in: CGRect(x: -21, y: -2, width: 7, height: 4.5))
        ctx.fillEllipse(in: CGRect(x: 14, y: -2, width: 7, height: 4.5))
    }

    private func drawMecha(ctx: CGContext, accent: NSColor, contrast: NSColor, tertiary: NSColor) {
        let shellColor = NSColor(srgbRed: 0.19, green: 0.22, blue: 0.30, alpha: 1.0)
        let screenColor = NSColor(srgbRed: 0.08, green: 0.10, blue: 0.15, alpha: 1.0)

        // Shadow
        ctx.setFillColor(NSColor.black.withAlphaComponent(0.22).cgColor)
        ctx.fillEllipse(in: CGRect(x: -26, y: -42, width: 52, height: 10))

        // Antenna
        ctx.setStrokeColor(accent.cgColor)
        ctx.setLineWidth(3.0)
        ctx.move(to: CGPoint(x: 0, y: 26))
        ctx.addLine(to: CGPoint(x: 0, y: 38))
        ctx.strokePath()
        let bulbColor = agentState == "running" ? contrast : tertiary
        ctx.setFillColor(bulbColor.cgColor)
        ctx.fillEllipse(in: CGRect(x: -5, y: 36, width: 10, height: 10))

        // Body
        let bodyRect = CGRect(x: -20, y: -34, width: 40, height: 24)
        let bodyPath = CGPath(roundedRect: bodyRect, cornerWidth: 8, cornerHeight: 8, transform: nil)
        ctx.setFillColor(shellColor.cgColor)
        ctx.addPath(bodyPath)
        ctx.fillPath()

        // Head
        let headRect = CGRect(x: -28, y: -12, width: 56, height: 40)
        let headPath = CGPath(roundedRect: headRect, cornerWidth: 12, cornerHeight: 12, transform: nil)
        ctx.setFillColor(shellColor.cgColor)
        ctx.addPath(headPath)
        ctx.fillPath()
        ctx.setStrokeColor(accent.cgColor)
        ctx.setLineWidth(2.4)
        ctx.addPath(headPath)
        ctx.strokePath()

        // Visor
        let visorRect = CGRect(x: -21, y: -4, width: 42, height: 24)
        let visorPath = CGPath(roundedRect: visorRect, cornerWidth: 7, cornerHeight: 7, transform: nil)
        ctx.setFillColor(screenColor.cgColor)
        ctx.addPath(visorPath)
        ctx.fillPath()

        // LED Eyes
        let eyeH = max(2.0, 8.0 * eyeScaleY)
        let eyeY = 8.0 - eyeH / 2.0
        ctx.setFillColor(tertiary.cgColor)
        ctx.fill(CGRect(x: -14, y: eyeY, width: 9, height: eyeH))
        ctx.fill(CGRect(x: 5, y: eyeY, width: 9, height: eyeH))
    }

    private func drawMoodBadge(ctx: CGContext) {
        let symbol: String
        let bgColor: NSColor
        if agentState == "running" {
            symbol = "⚡"
            bgColor = colorFromHex(theme.contrast, fallback: .systemOrange)
        } else if agentState == "unread" {
            symbol = "★"
            bgColor = colorFromHex(theme.tertiary, fallback: .systemGreen)
        } else {
            return
        }

        let badgeSize: CGFloat = 20
        let rect = CGRect(x: bounds.width - badgeSize - 4, y: bounds.height - badgeSize - 4, width: badgeSize, height: badgeSize)
        ctx.saveGState()
        ctx.setFillColor(bgColor.withAlphaComponent(0.92).cgColor)
        ctx.fillEllipse(in: rect)
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .bold),
            .foregroundColor: NSColor.white,
        ]
        let str = NSAttributedString(string: symbol, attributes: attrs)
        let strSize = str.size()
        str.draw(at: NSPoint(x: rect.midX - strSize.width / 2.0, y: rect.midY - strSize.height / 2.0))
        ctx.restoreGState()
    }
}

// MARK: - Lock Unlock Badge Panel

final class LockBadgeView: NSView {
    var accentColor: NSColor = .systemBlue
    var bgColor: NSColor = NSColor(srgbRed: 0.12, green: 0.14, blue: 0.20, alpha: 0.94)
    var onUnlockClick: (() -> Void)?

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        return true
    }

    override func mouseDown(with event: NSEvent) {
        onUnlockClick?()
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let rect = bounds.insetBy(dx: 2, dy: 2)
        let path = CGPath(roundedRect: rect, cornerWidth: rect.height / 2.0, cornerHeight: rect.height / 2.0, transform: nil)
        ctx.setFillColor(bgColor.cgColor)
        ctx.addPath(path)
        ctx.fillPath()
        ctx.setStrokeColor(accentColor.withAlphaComponent(0.85).cgColor)
        ctx.setLineWidth(1.5)
        ctx.addPath(path)
        ctx.strokePath()

        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
            .foregroundColor: NSColor.white,
        ]
        let str = NSAttributedString(string: "🔒 解锁", attributes: attrs)
        let sz = str.size()
        str.draw(at: NSPoint(x: bounds.midX - sz.width / 2.0, y: bounds.midY - sz.height / 2.0))
    }
}

// MARK: - Speech Bubble View

final class PetBubbleView: NSView {
    var bgColor: NSColor = NSColor(srgbRed: 0.13, green: 0.15, blue: 0.20, alpha: 0.95)
    var borderColor: NSColor = NSColor.systemBlue
    var textColor: NSColor = .white
    var cornerRadius: CGFloat = 10.0
    var message: String = ""

    override var isFlipped: Bool { return false }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard !message.isEmpty, let ctx = NSGraphicsContext.current?.cgContext else { return }
        let rect = bounds.insetBy(dx: 2, dy: 2)
        let r = min(cornerRadius, rect.height / 2.0)
        let path = CGPath(roundedRect: rect, cornerWidth: r, cornerHeight: r, transform: nil)
        ctx.setFillColor(bgColor.cgColor)
        ctx.addPath(path)
        ctx.fillPath()
        ctx.setStrokeColor(borderColor.withAlphaComponent(0.70).cgColor)
        ctx.setLineWidth(1.2)
        ctx.addPath(path)
        ctx.strokePath()

        let para = NSMutableParagraphStyle()
        para.lineBreakMode = .byWordWrapping
        para.lineSpacing = 2.0
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11.5, weight: .medium),
            .foregroundColor: textColor,
            .paragraphStyle: para,
        ]
        let attrStr = NSAttributedString(string: message, attributes: attrs)
        let textRect = rect.insetBy(dx: 10, dy: 7)
        attrStr.draw(with: textRect, options: [.usesLineFragmentOrigin, .usesFontLeading])
    }
}

// MARK: - Main Desktop Pet Controller

final class PetHostController: NSObject {
    private let dataDir: String
    private let parentPid: Int32
    private let petConfigPath: String
    private let petStatusPath: String
    private let hudTelemetryPath: String
    private let themesPath: String
    private let pidFilePath: String

    private var config = PetConfig()
    private var telemetry = PetTelemetry()
    private var theme = PetThemePalette()

    private var petPanel: NSPanel!
    private var rootView: NSView!
    private var stageView: PetStageView!
    private var bubbleView: PetBubbleView!
    private var sparkleLabel: NSTextField!
    private var lockPanel: NSPanel!
    private var lockBadgeView: LockBadgeView!

    private var animTimer: Timer?
    private var pollTimer: Timer?
    private var bubbleHideTimer: Timer?
    private var sigTermSource: DispatchSourceSignal?
    private var sigIntSource: DispatchSourceSignal?

    private var lastConfigMtime: Date = .distantPast
    private var lastConfigSize: UInt64 = 0
    private var lastHudMtime: Date = .distantPast
    private var lastHudSize: UInt64 = 0
    private var lastThemeMtime: Date = .distantPast
    private var lastThemeSize: UInt64 = 0
    private var lastStatusWriteTime: Date = .distantPast

    private var lastStepAtMs: Int64 = 0
    private var lastAgentState: String = "idle"
    private var lastBubbleTemplate: String = ""

    // Physics & animation state
    private var lastTickTime: TimeInterval = ProcessInfo.processInfo.systemUptime
    private var lastInteractTime: TimeInterval = ProcessInfo.processInfo.systemUptime
    private var phase: Double = 0.0
    private var walkPhase: Double = 0.0
    private var blinkCountdown: Double = 3.2
    private var blinkProgress: Double = 0.0
    private var interactRemaining: Double = 0.0
    private var hopRemaining: Double = 0.0
    private var landBounceRemaining: Double = 0.0
    private var isDragging: Bool = false
    private var isMenuOpen: Bool = false
    private var dragStartOrigin: NSPoint = .zero
    private var dragStartMouse: NSPoint = .zero
    private var lastDragMouseX: CGFloat = 0
    private var dragVelocityX: CGFloat = 0
    private var dragTiltAngle: Double = 0.0

    // Wander state
    private var wanderMoving: Bool = false
    private var wanderTargetX: CGFloat = 0.0
    private var wanderTargetY: CGFloat = 0.0
    private var wanderFacing: CGFloat = 1.0
    private var wanderCooldownSec: Double = 7.5

    // Sparkle state
    private var sparkleRemaining: Double = 0.0
    private var sparkleTicks: Int = 0

    // Custom image / frames cache
    private var loadedImagePath: String = ""
    private var loadedImageMtime: Date = .distantPast
    private var gifFrames: [NSImage] = []
    private var gifDelaysSec: [Double] = []
    private var gifIndex: Int = 0
    private var gifAccumSec: Double = 0

    private var loadedFramesSig: String = ""
    private var customTrackImages: [String: [NSImage]] = [:]
    private var activeCustomTrack: String = "idle"
    private var customFrameIndex: Int = 0
    private var customFrameAccumSec: Double = 0

    // Dynamic layout tracking
    private var stageSide: CGFloat = 112.0
    private var bubbleHeight: CGFloat = 0.0
    private var bubbleWidth: CGFloat = 220.0
    private var lastAppliedTopLeft: NSPoint? = nil
    private var lockBadgeCheckAccum: Double = 0.0
    private var lockBadgeGrace: Double = 0.0
    private var disposed: Bool = false

    init(dataDir: String, parentPid: Int32) {
        self.dataDir = dataDir
        self.parentPid = parentPid
        self.petConfigPath = (dataDir as NSString).appendingPathComponent("pet_config.json")
        self.petStatusPath = (dataDir as NSString).appendingPathComponent("pet_status.json")
        self.hudTelemetryPath = (dataDir as NSString).appendingPathComponent("hud_telemetry.json")
        self.themesPath = (dataDir as NSString).appendingPathComponent("themes.json")
        let binDir = (dataDir as NSString).appendingPathComponent("bin")
        self.pidFilePath = (binDir as NSString).appendingPathComponent("agy_desktop_pet_mac.pid")
        super.init()
    }

    func start() {
        writePidFile()
        installSignalHandlers()
        setupWindows()

        reloadThemePalette(force: true)
        reloadTelemetry(force: true)
        reloadPetConfig(force: true)

        if !config.enabled || config.displayMode == "panel" {
            shutdownGracefully()
            return
        }

        lastStepAtMs = telemetry.latestStepAtMs
        lastAgentState = resolveAgentState()
        lastBubbleTemplate = config.bubbleTemplate

        applyConfigAndPosition(forcePosition: true)
        petPanel.orderFrontRegardless()
        writeStatusFile(running: true)

        lastTickTime = ProcessInfo.processInfo.systemUptime
        animTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            let now = ProcessInfo.processInfo.systemUptime
            let dt = min(0.05, max(0.001, now - self.lastTickTime))
            self.lastTickTime = now
            self.onAnimTick(dt: dt)
        }
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in
            self?.onPollTick()
        }
    }

    private func writePidFile() {
        let dir = (pidFilePath as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        if let data = "\(getpid())\n".data(using: .utf8) {
            try? atomicWriteData(data, to: pidFilePath)
        }
    }

    private func installSignalHandlers() {
        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)
        let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        term.setEventHandler { [weak self] in self?.shutdownGracefully() }
        term.resume()
        sigTermSource = term

        let intr = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        intr.setEventHandler { [weak self] in self?.shutdownGracefully() }
        intr.resume()
        sigIntSource = intr
    }

    private func setupWindows() {
        petPanel = NSPanel(
            contentRect: NSRect(x: 200, y: 200, width: 264, height: 170),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        petPanel.isOpaque = false
        petPanel.backgroundColor = .clear
        petPanel.hasShadow = false
        petPanel.hidesOnDeactivate = false
        petPanel.isMovable = false
        petPanel.level = .floating
        petPanel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]

        rootView = NSView(frame: NSRect(x: 0, y: 0, width: 264, height: 170))
        rootView.wantsLayer = true
        petPanel.contentView = rootView

        stageView = PetStageView(frame: NSRect(x: 76, y: 8, width: 112, height: 112))
        stageView.onDragStart = { [weak self] mouse in self?.handleDragStart(mouse) }
        stageView.onDragMove = { [weak self] mouse in self?.handleDragMove(mouse) }
        stageView.onDragEnd = { [weak self] moved in self?.handleDragEnd(moved: moved) }
        stageView.onSingleClick = { [weak self] in self?.handleSingleClick() }
        stageView.onDoubleClick = { [weak self] in self?.handleDoubleClick() }
        stageView.onRightMenu = { [weak self] ev in self?.showContextMenu(event: ev) }
        rootView.addSubview(stageView)

        bubbleView = PetBubbleView(frame: NSRect(x: 22, y: 124, width: 220, height: 34))
        bubbleView.isHidden = true
        bubbleView.wantsLayer = true
        rootView.addSubview(bubbleView)

        sparkleLabel = NSTextField(labelWithString: "✨")
        sparkleLabel.font = NSFont.systemFont(ofSize: 16)
        sparkleLabel.isHidden = true
        sparkleLabel.isBezeled = false
        sparkleLabel.drawsBackground = false
        sparkleLabel.isEditable = false
        sparkleLabel.isSelectable = false
        rootView.addSubview(sparkleLabel)

        // Hover unlock badge panel when selectable == false
        lockPanel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 76, height: 28),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        lockPanel.isOpaque = false
        lockPanel.backgroundColor = .clear
        lockPanel.hasShadow = false
        lockPanel.hidesOnDeactivate = false
        lockPanel.level = .statusBar
        lockPanel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        lockBadgeView = LockBadgeView(frame: NSRect(x: 0, y: 0, width: 76, height: 28))
        lockBadgeView.onUnlockClick = { [weak self] in
            guard let self = self else { return }
            self.config.selectable = true
            self.savePetConfigToDisk()
            self.lockPanel.orderOut(nil)
            self.applyConfigAndPosition(forcePosition: false)
            self.showBubble("🔓 已恢复可选中", duration: 2.2)
        }
        lockPanel.contentView = lockBadgeView
    }

    // MARK: - Coordinate Conversion (Top-Left <-> AppKit Bottom-Left)

    private var primaryMaxY: CGFloat {
        return NSScreen.screens.first?.frame.maxY ?? NSScreen.main?.frame.maxY ?? 1080.0
    }

    private func screenForStageTopLeft(_ pt: NSPoint) -> NSScreen {
        let appKitY = primaryMaxY - pt.y - stageSide / 2.0
        let testPt = NSPoint(x: pt.x + stageSide / 2.0, y: appKitY)
        for s in NSScreen.screens {
            if s.frame.contains(testPt) { return s }
        }
        return NSScreen.main ?? NSScreen.screens.first!
    }

    private func clampStageTopLeft(_ pt: NSPoint) -> NSPoint {
        let screen = screenForStageTopLeft(pt)
        let vf = screen.visibleFrame
        let minTopY = primaryMaxY - vf.maxY
        let maxTopY = primaryMaxY - vf.minY - stageSide
        let minX = vf.minX
        let maxX = vf.maxX - stageSide
        let cx = max(minX, min(maxX, pt.x))
        let cy = max(minTopY, min(maxTopY, pt.y))
        return NSPoint(x: cx, y: cy)
    }

    private func defaultStageTopLeft() -> NSPoint {
        let screen = NSScreen.main ?? NSScreen.screens.first!
        let vf = screen.visibleFrame
        let margin: CGFloat = 28.0
        let x = vf.maxX - stageSide - margin
        let bottomAppKitY = vf.minY + margin
        let topY = primaryMaxY - bottomAppKitY - stageSide
        return clampStageTopLeft(NSPoint(x: x, y: topY))
    }

    private func currentStageTopLeft() -> NSPoint {
        if let f = petPanel?.frame {
            let stageOriginInWindow = stageView.frame.origin
            let stageAppKitBottomLeft = NSPoint(x: f.origin.x + stageOriginInWindow.x, y: f.origin.y + stageOriginInWindow.y)
            let topY = primaryMaxY - stageAppKitBottomLeft.y - stageSide
            return NSPoint(x: stageAppKitBottomLeft.x, y: topY)
        }
        return defaultStageTopLeft()
    }

    private func applyLayout(stageTopLeft: NSPoint) {
        let clamped = clampStageTopLeft(stageTopLeft)
        let padBottom: CGFloat = 8.0
        let gapBubble: CGFloat = 6.0
        let panelW = max(240.0, max(stageSide + 36.0, bubbleWidth + 16.0))
        let bH = bubbleView.isHidden ? 0.0 : bubbleHeight
        let panelH = padBottom + stageSide + (bH > 0 ? gapBubble + bH + 6.0 : 28.0)

        let stageAppKitY = primaryMaxY - clamped.y - stageSide
        let panelX = clamped.x - (panelW - stageSide) / 2.0
        let panelY = stageAppKitY - padBottom

        petPanel.setFrame(NSRect(x: panelX, y: panelY, width: panelW, height: panelH), display: true)
        rootView.frame = NSRect(x: 0, y: 0, width: panelW, height: panelH)
        stageView.frame = NSRect(x: (panelW - stageSide) / 2.0, y: padBottom, width: stageSide, height: stageSide)

        if !bubbleView.isHidden {
            bubbleView.frame = NSRect(
                x: (panelW - bubbleWidth) / 2.0,
                y: padBottom + stageSide + gapBubble,
                width: bubbleWidth,
                height: bubbleHeight
            )
        }
        sparkleLabel.frame = NSRect(
            x: (panelW / 2.0) - 12.0,
            y: padBottom + stageSide - 4.0,
            width: 24,
            height: 22
        )
        lastAppliedTopLeft = clamped
    }

    // MARK: - Config / Telemetry / Theme Loading

    private func fileMeta(_ path: String) -> (Date, UInt64)? {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path) else { return nil }
        let mtime = (attrs[.modificationDate] as? Date) ?? .distantPast
        let size = (attrs[.size] as? NSNumber)?.uint64Value ?? 0
        return (mtime, size)
    }

    private func reloadThemePalette(force: Bool = false) {
        guard let (mtime, size) = fileMeta(themesPath) else { return }
        if !force && mtime == lastThemeMtime && size == lastThemeSize { return }
        guard let raw = try? Data(contentsOf: URL(fileURLWithPath: themesPath)) else { return }
        lastThemeMtime = mtime
        lastThemeSize = size
        guard let doc = try? JSONSerialization.jsonObject(with: stripUtf8Bom(raw)) as? [String: Any] else { return }
        var next = PetThemePalette()
        next.radius = clampInt(jsonInt(doc["radius"]) ?? 10, 4, 18)
        if let colors = doc["colors"] as? [String: Any] {
            next.accent = jsonString(colors["accent"]) ?? next.accent
            next.contrast = jsonString(colors["contrast"]) ?? next.contrast
            next.tertiary = jsonString(colors["tertiary"]) ?? next.tertiary
            next.canvas = jsonString(colors["canvas"]) ?? next.canvas
            next.chrome = jsonString(colors["chrome"]) ?? next.chrome
            next.bubble = jsonString(colors["bubble"]) ?? next.bubble
        }
        theme = next
        applyBubbleTheme()
    }

    private func reloadTelemetry(force: Bool = false) {
        guard let (mtime, size) = fileMeta(hudTelemetryPath) else { return }
        if !force && mtime == lastHudMtime && size == lastHudSize { return }
        guard let raw = try? Data(contentsOf: URL(fileURLWithPath: hudTelemetryPath)) else { return }
        lastHudMtime = mtime
        lastHudSize = size
        guard let doc = try? JSONSerialization.jsonObject(with: stripUtf8Bom(raw)) as? [String: Any] else { return }

        var spList: [SessionProgressItem] = []
        if let rawArr = doc["sessionProgress"] as? [[String: Any]] {
            for item in rawArr {
                guard let spId = jsonString(item["id"]), !spId.isEmpty else { continue }
                spList.append(SessionProgressItem(
                    id: spId,
                    name: jsonString(item["name"]) ?? spId,
                    status: jsonString(item["status"]) ?? "done",
                    progress: clampInt(jsonInt(item["progress"]) ?? 0, 0, 100),
                    tag: jsonString(item["tag"]) ?? "",
                    content: jsonString(item["content"]) ?? ""
                ))
            }
        }

        telemetry = PetTelemetry(
            percent: clampInt(jsonInt(doc["percent"]) ?? 0, 0, 999),
            tokPerSec: jsonDouble(doc["tokPerSec"]),
            cacheHitPct: jsonInt(doc["cacheHitPct"]),
            latestInputTokens: max(0, jsonInt64(doc["latestInputTokens"]) ?? 0),
            latestOutputTokens: max(0, jsonInt64(doc["latestOutputTokens"]) ?? 0),
            latestStepAtMs: max(0, jsonInt64(doc["latestStepAtMs"]) ?? 0),
            upstreamModelId: jsonString(doc["upstreamModelId"]) ?? "",
            activeSessionCount: clampInt(jsonInt(doc["activeSessionCount"]) ?? 0, 0, 999),
            unreadSessionCount: clampInt(jsonInt(doc["unreadSessionCount"]) ?? 0, 0, 999),
            agentState: jsonString(doc["agentState"]) ?? "idle",
            quotaGemini5h: jsonInt(doc["quotaGemini5h"]),
            quotaGeminiWeekly: jsonInt(doc["quotaGeminiWeekly"]),
            quotaClaude5h: jsonInt(doc["quotaClaude5h"]),
            quotaClaudeWeekly: jsonInt(doc["quotaClaudeWeekly"]),
            sessionProgress: spList
        )
    }

    private func parseFrameRefs(_ raw: Any?) -> [CustomPetFrameRef] {
        guard let arr = raw as? [[String: Any]] else { return [] }
        var out: [CustomPetFrameRef] = []
        for d in arr {
            guard let fn = jsonString(d["filename"]), !fn.isEmpty else { continue }
            let cleanFn = (fn as NSString).lastPathComponent
            out.append(CustomPetFrameRef(filename: cleanFn, mime: jsonString(d["mime"]) ?? "image/png"))
        }
        return out
    }

    private func reloadPetConfig(force: Bool = false) {
        guard let (mtime, size) = fileMeta(petConfigPath) else {
            config = PetConfig()
            return
        }
        if !force && mtime == lastConfigMtime && size == lastConfigSize { return }
        guard let raw = try? Data(contentsOf: URL(fileURLWithPath: petConfigPath)) else { return }
        lastConfigMtime = mtime
        lastConfigSize = size
        guard let doc = try? JSONSerialization.jsonObject(with: stripUtf8Bom(raw)) as? [String: Any] else { return }

        let petsDir = (dataDir as NSString).appendingPathComponent("pets")
        var next = PetConfig()
        next.enabled = jsonBool(doc["enabled"]) ?? false
        next.activePetId = jsonString(doc["activePetId"]) ?? "neko"
        next.displayMode = jsonString(doc["displayMode"]) ?? "auto"
        next.size = clampInt(jsonInt(doc["size"]) ?? 100, 60, 500)
        next.opacity = clampInt(jsonInt(doc["opacity"]) ?? 95, 40, 100)
        next.alwaysOnTop = jsonBool(doc["alwaysOnTop"]) ?? true
        next.showSpeechBubble = jsonBool(doc["showSpeechBubble"]) ?? true
        next.bubbleTemplate = jsonString(doc["bubbleTemplate"]) ?? "入 {in} · 出 {out}"
        next.autoWander = jsonBool(doc["autoWander"]) ?? true
        next.selectable = jsonBool(doc["selectable"]) ?? true
        next.posX = jsonInt(doc["posX"])
        next.posY = jsonInt(doc["posY"])
        next.petsDir = petsDir

        var list: [CustomPetEntry] = []
        if let rawCustom = doc["customPets"] as? [[String: Any]] {
            for item in rawCustom {
                guard let cid = jsonString(item["id"]), !cid.isEmpty else { continue }
                let kind = jsonString(item["kind"]) ?? "image"
                let fps = clampInt(jsonInt(item["fps"]) ?? 8, 1, 30)
                let fn = (jsonString(item["filename"]) ?? "")
                let cleanFn = fn.isEmpty ? "" : (fn as NSString).lastPathComponent
                let frames = parseFrameRefs(item["frames"])
                var sfMap: [String: [CustomPetFrameRef]] = [:]
                if let rawSf = item["stateFrames"] as? [String: Any] {
                    for (k, v) in rawSf {
                        let refs = parseFrameRefs(v)
                        if !refs.isEmpty { sfMap[k] = refs }
                    }
                }
                let entry = CustomPetEntry(
                    id: cid,
                    name: jsonString(item["name"]) ?? cid,
                    kind: kind,
                    fps: fps,
                    filename: cleanFn,
                    mime: jsonString(item["mime"]) ?? "image/png",
                    frames: frames,
                    stateFrames: sfMap
                )
                list.append(entry)
                if cid == next.activePetId {
                    next.activeCustomPet = entry
                    if !cleanFn.isEmpty {
                        let cand = (petsDir as NSString).appendingPathComponent(cleanFn)
                        if FileManager.default.fileExists(atPath: cand) {
                            next.customImagePath = cand
                        }
                    }
                }
            }
        }
        next.customPets = list
        config = next
    }

    private func savePetConfigToDisk() {
        do {
            var doc: [String: Any] = [:]
            if let raw = try? Data(contentsOf: URL(fileURLWithPath: petConfigPath)),
               let existing = try? JSONSerialization.jsonObject(with: stripUtf8Bom(raw)) as? [String: Any] {
                doc = existing
            } else {
                doc["version"] = 1
                doc["customPets"] = []
                doc["displayMode"] = config.displayMode
                doc["opacity"] = config.opacity
                doc["bubbleTemplate"] = config.bubbleTemplate
            }
            doc["enabled"] = config.enabled
            doc["activePetId"] = config.activePetId
            doc["size"] = config.size
            doc["alwaysOnTop"] = config.alwaysOnTop
            doc["showSpeechBubble"] = config.showSpeechBubble
            doc["autoWander"] = config.autoWander
            doc["selectable"] = config.selectable
            doc["posX"] = config.posX != nil ? config.posX! : NSNull()
            doc["posY"] = config.posY != nil ? config.posY! : NSNull()
            doc["updatedAt"] = Int64(Date().timeIntervalSince1970 * 1000.0)

            let outData = try JSONSerialization.data(withJSONObject: doc, options: [.prettyPrinted])
            try atomicWriteData(outData, to: petConfigPath)
            if let (mtime, size) = fileMeta(petConfigPath) {
                lastConfigMtime = mtime
                lastConfigSize = size
            }
        } catch {}
    }

    private func writeStatusFile(running: Bool) {
        do {
            lastStatusWriteTime = Date()
            let epochMs = Int64(Date().timeIntervalSince1970 * 1000.0)
            let payload: [String: Any] = [
                "pid": Int(getpid()),
                "running": running,
                "supportsPet": true,
                "petEnabled": config.enabled,
                "petVisible": running && (petPanel?.isVisible ?? false),
                "updatedAtMs": epochMs,
            ]
            let data = try JSONSerialization.data(withJSONObject: payload, options: [])
            try atomicWriteData(data, to: petStatusPath)
        } catch {}
    }

    // MARK: - Media & Visual Application

    private func applyBubbleTheme() {
        let bubbleCol = colorFromHex(theme.bubble, alpha: 0.96, fallback: .darkGray)
        let borderCol = colorFromHex(theme.accent, alpha: 0.85, fallback: .systemBlue)
        bubbleView.bgColor = bubbleCol
        bubbleView.borderColor = borderCol
        bubbleView.textColor = isDarkColor(bubbleCol) ? .white : .black
        bubbleView.cornerRadius = CGFloat(clampInt(theme.radius, 6, 16))
        bubbleView.needsDisplay = true

        lockBadgeView.accentColor = colorFromHex(theme.accent, fallback: .systemBlue)
        lockBadgeView.bgColor = colorFromHex(theme.chrome, alpha: 0.94, fallback: .darkGray)
        lockBadgeView.needsDisplay = true
    }

    private func loadMediaAssetsIfNeeded() {
        let active = config.activeCustomPet
        if let entry = active, entry.kind == "frames", !entry.frames.isEmpty {
            // Multi-track frames
            var sigParts = [entry.id, "\(entry.fps)"]
            for f in entry.frames { sigParts.append("idle:\(f.filename)") }
            for k in entry.stateFrames.keys.sorted() {
                for f in entry.stateFrames[k] ?? [] {
                    sigParts.append("\(k):\(f.filename)")
                }
            }
            let sig = sigParts.joined(separator: "|")
            if sig != loadedFramesSig {
                loadedFramesSig = sig
                customTrackImages.removeAll()
                let loadTrack = { [weak self] (refs: [CustomPetFrameRef]) -> [NSImage] in
                    guard let self = self else { return [] }
                    var imgs: [NSImage] = []
                    for r in refs {
                        let p = (self.config.petsDir as NSString).appendingPathComponent(r.filename)
                        if let img = NSImage(contentsOfFile: p) {
                            imgs.append(img)
                        }
                    }
                    return imgs
                }
                customTrackImages["idle"] = loadTrack(entry.frames)
                for (k, refs) in entry.stateFrames {
                    let imgs = loadTrack(refs)
                    if !imgs.isEmpty { customTrackImages[k] = imgs }
                }
                customFrameIndex = 0
                customFrameAccumSec = 0
            }
            loadedImagePath = ""
            gifFrames.removeAll()
            gifDelaysSec.removeAll()
            return
        }

        loadedFramesSig = ""
        customTrackImages.removeAll()

        let imgPath = config.customImagePath
        if !imgPath.isEmpty && FileManager.default.fileExists(atPath: imgPath) {
            let mtime = fileMeta(imgPath)?.0 ?? .distantPast
            if imgPath != loadedImagePath || mtime != loadedImageMtime {
                loadedImagePath = imgPath
                loadedImageMtime = mtime
                gifFrames.removeAll()
                gifDelaysSec.removeAll()
                gifIndex = 0
                gifAccumSec = 0

                let url = URL(fileURLWithPath: imgPath) as CFURL
                if let src = CGImageSourceCreateWithURL(url, nil) {
                    let count = CGImageSourceGetCount(src)
                    for i in 0..<count {
                        if let cg = CGImageSourceCreateImageAtIndex(src, i, nil) {
                            let img = NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
                            gifFrames.append(img)
                            var delay = 0.1
                            if let props = CGImageSourceCopyPropertiesAtIndex(src, i, nil) as? [String: Any],
                               let gifDict = props[kCGImagePropertyGIFDictionary as String] as? [String: Any] {
                                if let u = gifDict[kCGImagePropertyGIFUnclampedDelayTime as String] as? Double, u > 0.01 {
                                    delay = u
                                } else if let d = gifDict[kCGImagePropertyGIFDelayTime as String] as? Double, d > 0.01 {
                                    delay = d
                                }
                            }
                            gifDelaysSec.append(max(0.02, delay))
                        }
                    }
                }
                if gifFrames.isEmpty, let single = NSImage(contentsOfFile: imgPath) {
                    gifFrames.append(single)
                    gifDelaysSec.append(0.1)
                }
            }
        } else {
            loadedImagePath = ""
            gifFrames.removeAll()
            gifDelaysSec.removeAll()
        }
    }

    private func applyConfigAndPosition(forcePosition: Bool) {
        if !config.enabled || config.displayMode == "panel" {
            shutdownGracefully()
            return
        }

        let scale = CGFloat(clampInt(config.size, 60, 500)) / 100.0
        stageSide = 112.0 * scale

        petPanel.alphaValue = CGFloat(clampInt(config.opacity, 40, 100)) / 100.0
        petPanel.level = config.alwaysOnTop ? .floating : .normal
        petPanel.ignoresMouseEvents = !config.selectable
        if config.selectable {
            lockPanel.orderOut(nil)
        }

        stageView.petId = config.activePetId
        stageView.theme = theme
        stageView.agentState = resolveAgentState()
        applyBubbleTheme()
        loadMediaAssetsIfNeeded()

        if !config.showSpeechBubble {
            hideBubbleImmediate()
        }

        let targetTopLeft: NSPoint
        if let px = config.posX, let py = config.posY, (forcePosition || lastAppliedTopLeft == nil) {
            targetTopLeft = NSPoint(x: px, y: py)
        } else if let cur = lastAppliedTopLeft, !forcePosition {
            targetTopLeft = cur
        } else if let px = config.posX, let py = config.posY {
            targetTopLeft = NSPoint(x: px, y: py)
        } else {
            targetTopLeft = defaultStageTopLeft()
        }
        applyLayout(stageTopLeft: targetTopLeft)
    }

    // MARK: - Bubble Template Engine

    private static let listBlockRegex = try! NSRegularExpression(pattern: "\\[([^\\[\\]]+)\\](?:\\(([^()]*)\\))?", options: [])
    private static let sessionVarRegex = try! NSRegularExpression(pattern: "\\{(schedule|content)(?::([a-zA-Z0-9_-]+))?\\}", options: [.caseInsensitive])

    private func resolveQuotaPair() -> (String, String) {
        let m = telemetry.upstreamModelId.lowercased()
        let isClaudeOrGpt = m.contains("claude") || m.contains("gpt") || m.contains("sonnet") || m.contains("opus") || m.contains("haiku") || m.contains("openai")
        let raw5 = isClaudeOrGpt ? (telemetry.quotaClaude5h ?? telemetry.quotaGemini5h) : (telemetry.quotaGemini5h ?? telemetry.quotaClaude5h)
        let rawW = isClaudeOrGpt ? (telemetry.quotaClaudeWeekly ?? telemetry.quotaGeminiWeekly) : (telemetry.quotaGeminiWeekly ?? telemetry.quotaClaudeWeekly)
        return (raw5.map { "\($0)" } ?? "--", rawW.map { "\($0)" } ?? "--")
    }

    private func formatQuotaText() -> String {
        let (q5, qw) = resolveQuotaPair()
        if q5 == "--" && qw == "--" {
            let g5 = telemetry.quotaGemini5h.map { "\($0)" } ?? "--"
            let c5 = telemetry.quotaClaude5h.map { "\($0)" } ?? "--"
            if g5 != "--" || c5 != "--" {
                return "G \(g5)% · C \(c5)%"
            }
            return "--"
        }
        return "5h \(q5)%/周 \(qw)%"
    }

    private func resolveSessionField(kind: String, convId: String) -> String {
        let list = telemetry.sessionProgress
        var target: SessionProgressItem? = nil
        if !convId.isEmpty {
            target = list.first { $0.id == convId }
        } else {
            target = list.first { $0.status.caseInsensitiveCompare("active") == .orderedSame }
                ?? list.first { $0.status.caseInsensitiveCompare("unread") == .orderedSame }
                ?? list.first
        }

        if kind.caseInsensitiveCompare("schedule") == .orderedSame {
            guard let t = target else {
                if !convId.isEmpty {
                    return "\(String(convId.prefix(8))) · 待机"
                }
                return "待机"
            }
            let rawName = !t.name.isEmpty ? t.name : String(t.id.prefix(8))
            let shortName = String(rawName.prefix(20))
            if t.status.caseInsensitiveCompare("active") == .orderedSame {
                return "⚡ \(shortName) · \(t.progress)%"
            }
            if t.status.caseInsensitiveCompare("unread") == .orderedSame {
                return "★ \(shortName) · 未读"
            }
            return "✓ \(shortName) · 已完成"
        }

        guard let t = target else { return "暂无进展" }
        let txt = !t.content.isEmpty ? t.content : (!t.tag.isEmpty ? t.tag : (!t.name.isEmpty ? t.name : "推进中"))
        return String(txt.prefix(38))
    }

    private func renderSessionVars(_ text: String, overrideId: String) -> String {
        let ns = text as NSString
        let matches = Self.sessionVarRegex.matches(in: text, options: [], range: NSRange(location: 0, length: ns.length))
        if matches.isEmpty { return text }
        var result = ""
        var cursor = 0
        for m in matches {
            result += ns.substring(with: NSRange(location: cursor, length: m.range.location - cursor))
            let kind = ns.substring(with: m.range(at: 1))
            let cid: String
            if !overrideId.isEmpty {
                cid = overrideId
            } else if m.range(at: 2).location != NSNotFound {
                cid = ns.substring(with: m.range(at: 2))
            } else {
                cid = ""
            }
            result += resolveSessionField(kind: kind, convId: cid)
            cursor = m.range.location + m.range.length
        }
        result += ns.substring(from: cursor)
        return result
    }

    private func renderListItems(_ items: [String], overrideId: String) -> String {
        var lines: [String] = []
        for item in items {
            let resolved = renderSessionVars(item, overrideId: overrideId).trimmingCharacters(in: .whitespacesAndNewlines)
            if !resolved.isEmpty { lines.append(resolved) }
        }
        return lines.joined(separator: "\n")
    }

    private func renderBubbleTemplate(_ template: String) -> String {
        let tpl = template.isEmpty ? "入 {in} · 出 {out}" : template
        let inStr = formatTokenCount(telemetry.latestInputTokens)
        let outStr = formatTokenCount(telemetry.latestOutputTokens)
        let tpsStr = (telemetry.tokPerSec ?? 0) > 0 ? String(format: "%.1f", telemetry.tokPerSec!) : "--"
        let pctStr = "\(telemetry.percent)"
        let modelStr = telemetry.upstreamModelId.isEmpty ? "待机" : telemetry.upstreamModelId
        let cacheStr = telemetry.cacheHitPct.map { "\($0)" } ?? "--"
        let unreadStr = "\(max(0, telemetry.unreadSessionCount))"
        let (q5Str, q7Str) = resolveQuotaPair()
        let quotaStr = formatQuotaText()

        let scalar = tpl
            .replacingOccurrences(of: "{in}", with: inStr)
            .replacingOccurrences(of: "{out}", with: outStr)
            .replacingOccurrences(of: "{tps}", with: tpsStr)
            .replacingOccurrences(of: "{pct}", with: pctStr)
            .replacingOccurrences(of: "{model}", with: modelStr)
            .replacingOccurrences(of: "{cache}", with: cacheStr)
            .replacingOccurrences(of: "{unread}", with: unreadStr)
            .replacingOccurrences(of: "{quota5h}", with: q5Str)
            .replacingOccurrences(of: "{quota7d}", with: q7Str)
            .replacingOccurrences(of: "{quota}", with: quotaStr)

        let ns = scalar as NSString
        let matches = Self.listBlockRegex.matches(in: scalar, options: [], range: NSRange(location: 0, length: ns.length))
        if matches.isEmpty {
            return renderSessionVars(scalar, overrideId: "")
        }

        var renderedIds = Set<String>()
        var totalBlocks = 0
        let maxListBlocks = 6
        var out = ""
        var cursor = 0
        var prevEndedWithList = false

        for m in matches {
            let between = ns.substring(with: NSRange(location: cursor, length: m.range.location - cursor))
            let inner = ns.substring(with: m.range(at: 1))
            let modsRaw = m.range(at: 2).location != NSNotFound ? ns.substring(with: m.range(at: 2)) : ""
            let items = inner.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
            let modParts = modsRaw.lowercased().split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            let wantActive = modParts.contains("active")
            let wantUnread = modParts.contains("unread")

            var explicitIds: [String] = []
            for item in items {
                let ins = item as NSString
                for im in Self.sessionVarRegex.matches(in: item, options: [], range: NSRange(location: 0, length: ins.length)) {
                    if im.range(at: 2).location != NSNotFound {
                        let cid = ins.substring(with: im.range(at: 2))
                        if !cid.isEmpty && !explicitIds.contains(cid) { explicitIds.append(cid) }
                    }
                }
            }

            var blocks: [String] = []
            if !explicitIds.isEmpty {
                if totalBlocks < maxListBlocks {
                    let bt = renderListItems(items, overrideId: "")
                    if !bt.isEmpty { blocks.append(bt); totalBlocks += 1 }
                }
                for cid in explicitIds { renderedIds.insert(cid) }
            } else if !wantActive && !wantUnread {
                if totalBlocks < maxListBlocks {
                    let bt = renderListItems(items, overrideId: "")
                    if !bt.isEmpty { blocks.append(bt); totalBlocks += 1 }
                }
            }

            if wantActive || wantUnread {
                for sp in telemetry.sessionProgress where totalBlocks < maxListBlocks {
                    if renderedIds.contains(sp.id) { continue }
                    let isAct = sp.status.caseInsensitiveCompare("active") == .orderedSame
                    let isUnr = sp.status.caseInsensitiveCompare("unread") == .orderedSame
                    if (wantActive && isAct) || (wantUnread && isUnr) {
                        renderedIds.insert(sp.id)
                        let bt = renderListItems(items, overrideId: sp.id)
                        if !bt.isEmpty { blocks.append(bt); totalBlocks += 1 }
                    }
                }
            }

            let combined = blocks.joined(separator: "\n\n")
            if !between.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                out += between
                if !combined.isEmpty {
                    if !out.isEmpty && !out.hasSuffix("\n") { out += "\n" }
                    out += combined
                    prevEndedWithList = true
                } else {
                    prevEndedWithList = false
                }
            } else if !combined.isEmpty {
                if !out.isEmpty && prevEndedWithList { out += "\n\n" }
                else if !out.isEmpty && !out.hasSuffix("\n") { out += "\n" }
                out += combined
                prevEndedWithList = true
            }
            cursor = m.range.location + m.range.length
        }

        if cursor < ns.length {
            let tail = ns.substring(from: cursor)
            if !tail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                if !out.isEmpty && !out.hasSuffix("\n") && !tail.hasPrefix("\n") { out += "\n" }
                out += tail
            }
        }
        let finalStr = out.trimmingCharacters(in: .whitespacesAndNewlines)
        return renderSessionVars(finalStr.isEmpty ? "暂无活动会话" : finalStr, overrideId: "")
    }

    private func showBubble(_ text: String, duration: Double = 4.5) {
        guard config.showSpeechBubble else { return }
        let msg = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !msg.isEmpty else { return }

        let para = NSMutableParagraphStyle()
        para.lineBreakMode = .byWordWrapping
        para.lineSpacing = 2.0
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11.5, weight: .medium),
            .paragraphStyle: para,
        ]
        let attr = NSAttributedString(string: msg, attributes: attrs)
        let maxW: CGFloat = 250.0
        let bounds = attr.boundingRect(with: NSSize(width: maxW, height: 340.0), options: [.usesLineFragmentOrigin, .usesFontLeading])
        bubbleWidth = max(96.0, min(maxW + 24.0, ceil(bounds.width) + 24.0))
        bubbleHeight = max(30.0, ceil(bounds.height) + 18.0)

        bubbleView.message = msg
        bubbleView.isHidden = false
        bubbleView.alphaValue = 0.0
        bubbleView.needsDisplay = true

        applyLayout(stageTopLeft: currentStageTopLeft())

        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.16
            bubbleView.animator().alphaValue = 1.0
        }

        bubbleHideTimer?.invalidate()
        bubbleHideTimer = Timer.scheduledTimer(withTimeInterval: duration, repeats: false) { [weak self] _ in
            self?.hideBubbleSmooth()
        }
    }

    private func hideBubbleSmooth() {
        guard !bubbleView.isHidden else { return }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.18
            bubbleView.animator().alphaValue = 0.0
        }, completionHandler: { [weak self] in
            guard let self = self else { return }
            self.bubbleView.isHidden = true
            self.bubbleHeight = 0.0
            self.applyLayout(stageTopLeft: self.currentStageTopLeft())
        })
    }

    private func hideBubbleImmediate() {
        bubbleHideTimer?.invalidate()
        bubbleHideTimer = nil
        if !bubbleView.isHidden {
            bubbleView.isHidden = true
            bubbleHeight = 0.0
            applyLayout(stageTopLeft: currentStageTopLeft())
        }
    }

    // MARK: - Animation & Polling Ticks

    private func resolveAgentState() -> String {
        if telemetry.activeSessionCount > 0 || telemetry.agentState.caseInsensitiveCompare("running") == .orderedSame {
            return "running"
        }
        if telemetry.unreadSessionCount > 0 || telemetry.agentState.caseInsensitiveCompare("unread") == .orderedSame {
            return "unread"
        }
        return "idle"
    }

    private func isMouseOverStage() -> Bool {
        guard let panelFrame = petPanel?.frame, petPanel.isVisible else { return false }
        let stageRect = NSRect(
            x: panelFrame.origin.x + stageView.frame.origin.x,
            y: panelFrame.origin.y + stageView.frame.origin.y,
            width: stageView.frame.width,
            height: stageView.frame.height
        )
        return stageRect.insetBy(dx: -6, dy: -6).contains(NSEvent.mouseLocation)
    }

    private func updateAutonomousWander(dt: Double, agentState: String) {
        if !config.autoWander || isDragging || isMenuOpen || hopRemaining > 0 || interactRemaining > 0 || agentState == "running" || isMouseOverStage() {
            if wanderMoving && (isDragging || isMenuOpen || agentState == "running") {
                wanderMoving = false
                wanderCooldownSec = Double.random(in: 5.5...11.5)
            }
            return
        }

        let cur = currentStageTopLeft()
        if !wanderMoving {
            wanderCooldownSec -= dt
            if wanderCooldownSec > 0 { return }

            let screen = screenForStageTopLeft(cur)
            let vf = screen.visibleFrame
            let minX = vf.minX + 8.0
            let maxX = max(minX + 40.0, vf.maxX - stageSide - 8.0)
            let dist = CGFloat(Double.random(in: 110.0...340.0))
            var dir: CGFloat = Bool.random() ? -1.0 : 1.0
            var candX = cur.x + dir * dist
            if candX < minX || candX > maxX {
                dir = -dir
                candX = max(minX, min(maxX, cur.x + dir * dist))
            }
            if abs(candX - cur.x) < 28.0 {
                wanderCooldownSec = 6.0
                return
            }

            let minTopY = primaryMaxY - vf.maxY + 12.0
            let maxTopY = max(minTopY + 20.0, primaryMaxY - vf.minY - stageSide - 10.0)
            let candY = max(minTopY, min(maxTopY, cur.y + CGFloat(Double.random(in: -12.0...12.0))))

            wanderTargetX = candX
            wanderTargetY = candY
            wanderFacing = candX < cur.x ? -1.0 : 1.0
            wanderMoving = true
            return
        }

        let dx = wanderTargetX - cur.x
        let dy = wanderTargetY - cur.y
        let rem = hypot(dx, dy)
        let walkSpeed: CGFloat = 66.0
        let step = walkSpeed * CGFloat(dt)
        if rem <= step + 1.5 {
            applyLayout(stageTopLeft: NSPoint(x: round(wanderTargetX), y: round(wanderTargetY)))
            wanderMoving = false
            wanderCooldownSec = Double.random(in: 8.0...18.0)
        } else {
            wanderFacing = dx < 0 ? -1.0 : 1.0
            let nextPt = NSPoint(x: cur.x + (dx / rem) * step, y: cur.y + (dy / rem) * step)
            applyLayout(stageTopLeft: nextPt)
            walkPhase += dt * 13.5
        }
    }

    private func onAnimTick(dt: Double) {
        if disposed { return }

        let agentState = resolveAgentState()
        let now = ProcessInfo.processInfo.systemUptime
        let sleepy = agentState == "idle" && !wanderMoving && !isDragging && (now - lastInteractTime) > 45.0

        updateAutonomousWander(dt: dt, agentState: agentState)

        let speedMult = agentState == "running" ? 2.1 : (agentState == "unread" ? 1.5 : (sleepy ? 0.55 : 1.0))
        phase += dt * 2.6 * speedMult

        // Blink timer
        blinkCountdown -= dt
        if blinkCountdown <= 0 {
            blinkProgress += dt * 7.5
            if blinkProgress >= 1.0 {
                blinkProgress = 0.0
                blinkCountdown = Double.random(in: 2.6...6.0)
            }
        }
        let eyeY = sleepy ? 0.22 : (blinkCountdown <= 0 ? max(0.14, abs(cos(blinkProgress * .pi))) : 1.0)

        // Interact & hop timers
        if interactRemaining > 0 { interactRemaining = max(0, interactRemaining - dt) }

        // Sparkle animation
        if sparkleRemaining > 0 {
            sparkleRemaining = max(0, sparkleRemaining - dt)
            sparkleLabel.isHidden = false
            let progress = 1.0 - (sparkleRemaining / 0.85)
            sparkleLabel.alphaValue = CGFloat(max(0.0, 1.0 - progress))
            let baseY = 8.0 + stageSide - 4.0
            sparkleLabel.frame.origin.y = baseY + CGFloat(progress * 26.0)
            if sparkleRemaining <= 0 {
                sparkleLabel.isHidden = true
            }
        }

        // Determine active track & advance media frames
        // Priority matches AgyDesktopPet.cs: drag > interact > walk > running > unread > idle
        let desiredTrack: String
        if isDragging && customTrackImages["drag"]?.isEmpty == false { desiredTrack = "drag" }
        else if interactRemaining > 0 && customTrackImages["interact"]?.isEmpty == false { desiredTrack = "interact" }
        else if wanderMoving && customTrackImages["walk"]?.isEmpty == false { desiredTrack = "walk" }
        else if agentState == "running" && customTrackImages["running"]?.isEmpty == false { desiredTrack = "running" }
        else if agentState == "unread" && customTrackImages["unread"]?.isEmpty == false { desiredTrack = "unread" }
        else { desiredTrack = "idle" }

        if !customTrackImages.isEmpty {
            let trackImgs = (customTrackImages[desiredTrack]?.isEmpty == false ? customTrackImages[desiredTrack] : customTrackImages["idle"]) ?? []
            if desiredTrack != activeCustomTrack {
                activeCustomTrack = desiredTrack
                customFrameIndex = 0
                customFrameAccumSec = 0
            }
            if !trackImgs.isEmpty {
                let fps = Double(clampInt(config.activeCustomPet?.fps ?? 8, 1, 30))
                let frameDur = 1.0 / fps
                customFrameAccumSec += dt
                while customFrameAccumSec >= frameDur {
                    customFrameAccumSec -= frameDur
                    customFrameIndex = (customFrameIndex + 1) % trackImgs.count
                }
                stageView.customImage = trackImgs[customFrameIndex % trackImgs.count]
            } else {
                stageView.customImage = nil
            }
        } else if !gifFrames.isEmpty {
            if gifFrames.count > 1 {
                gifAccumSec += dt
                let delay = gifDelaysSec[gifIndex % gifDelaysSec.count]
                if gifAccumSec >= delay {
                    gifAccumSec -= delay
                    gifIndex = (gifIndex + 1) % gifFrames.count
                }
            }
            stageView.customImage = gifFrames[gifIndex % gifFrames.count]
        } else {
            stageView.customImage = nil
        }

        stageView.facingRight = wanderMoving ? (wanderFacing >= 0) : true

        // Physics transforms matching AgyDesktopPet.cs
        var hopY = 0.0
        var squashX = 1.0
        var squashY = 1.0
        var extraTilt = 0.0

        if isDragging {
            let targetAngle = max(-24.0, min(24.0, Double(-dragVelocityX) * 1.45))
            dragTiltAngle += (targetAngle - dragTiltAngle) * 0.28
            dragVelocityX *= 0.72
            squashX = 0.94
            squashY = 1.08
            hopY = 4.0 - sin(phase * 2.2) * 1.8
        } else {
            dragTiltAngle *= 0.74
            if hopRemaining > 0 {
                hopRemaining = max(0.0, hopRemaining - dt)
                let p = max(0.0, min(1.0, 1.0 - (hopRemaining / 0.58)))
                hopY = abs(sin(p * .pi * 2.0)) * 13.5
                squashX = 1.0 + sin(p * .pi * 2.0) * 0.09
                squashY = 1.0 - sin(p * .pi * 2.0) * 0.08
                extraTilt = sin(p * .pi * 3.0) * 5.5
            } else if landBounceRemaining > 0 {
                landBounceRemaining = max(0.0, landBounceRemaining - dt)
                let p = max(0.0, min(1.0, 1.0 - (landBounceRemaining / 0.42)))
                let damp = sin(p * .pi * 2.0) * (1.0 - p)
                squashX = 1.0 + damp * 0.16
                squashY = 1.0 - damp * 0.14
                hopY = min(0.0, -damp * 4.0)
            } else if wanderMoving {
                hopY = abs(sin(walkPhase)) * 5.5
                squashX = 1.0 + sin(walkPhase * 2.0) * 0.03
                squashY = 1.0 - sin(walkPhase * 2.0) * 0.03
                extraTilt = sin(walkPhase) * 4.2
            }
        }

        let bobAmp = (isDragging || wanderMoving) ? 0.0 : (agentState == "running" ? 2.6 : (sleepy ? 1.5 : 3.2))
        let bob = sin(phase) * bobAmp + hopY
        let tilt = isDragging
            ? dragTiltAngle
            : (sin(phase * 0.7) * (agentState == "running" ? 3.5 : 1.8) + dragTiltAngle + extraTilt)

        stageView.tiltDegrees = CGFloat(tilt)
        stageView.squashX = CGFloat(squashX)
        stageView.squashY = CGFloat(squashY)
        stageView.bobOffset = CGFloat(bob)
        stageView.eyeScaleY = CGFloat(eyeY)
        stageView.phase = phase
        stageView.agentState = agentState
        stageView.needsDisplay = true

        // Click-through hover unlock badge check (~10Hz)
        if !config.selectable {
            lockBadgeCheckAccum += dt
            if lockBadgeCheckAccum >= 0.1 {
                lockBadgeCheckAccum = 0
                updateLockBadgeVisibility(dt: 0.1)
            }
        }
    }

    private func updateLockBadgeVisibility(dt: Double) {
        let mouse = NSEvent.mouseLocation
        let stageRectInScreen = NSRect(
            x: petPanel.frame.origin.x + stageView.frame.origin.x,
            y: petPanel.frame.origin.y + stageView.frame.origin.y,
            width: stageView.frame.width,
            height: stageView.frame.height
        )
        let overPet = stageRectInScreen.insetBy(dx: -8, dy: -8).contains(mouse)
        let overBadge = lockPanel.isVisible && lockPanel.frame.insetBy(dx: -6, dy: -6).contains(mouse)

        if overPet || overBadge {
            lockBadgeGrace = 0.65
            let bx = stageRectInScreen.midX - lockPanel.frame.width / 2.0
            let by = stageRectInScreen.maxY + 4.0
            lockPanel.setFrameOrigin(NSPoint(x: bx, y: by))
            if !lockPanel.isVisible {
                lockPanel.orderFrontRegardless()
            }
        } else if lockPanel.isVisible {
            lockBadgeGrace -= dt
            if lockBadgeGrace <= 0 {
                lockPanel.orderOut(nil)
            }
        }
    }

    private func onPollTick() {
        if disposed { return }

        if parentPid > 0 {
            if kill(parentPid, 0) != 0 && errno == ESRCH {
                shutdownGracefully()
                return
            }
        }

        let prevState = lastAgentState
        let prevStep = telemetry.latestStepAtMs
        let prevTpl = config.bubbleTemplate

        reloadThemePalette()
        reloadTelemetry()
        reloadPetConfig()

        if !config.enabled || config.displayMode == "panel" {
            shutdownGracefully()
            return
        }

        applyConfigAndPosition(forcePosition: false)

        let curState = resolveAgentState()
        lastAgentState = curState

        if config.showSpeechBubble {
            if telemetry.latestStepAtMs != prevStep && telemetry.latestStepAtMs > 0 {
                showBubble(renderBubbleTemplate(config.bubbleTemplate), duration: 4.8)
            } else if curState != prevState {
                if curState == "running" {
                    showBubble(renderBubbleTemplate(config.bubbleTemplate), duration: 4.8)
                } else if curState == "unread" {
                    hopRemaining = 0.58
                    showBubble(renderBubbleTemplate(config.bubbleTemplate), duration: 5.5)
                }
            } else if config.bubbleTemplate != prevTpl {
                showBubble(renderBubbleTemplate(config.bubbleTemplate), duration: 4.2)
            }
        }

        if Date().timeIntervalSince(lastStatusWriteTime) >= 2.5 {
            writeStatusFile(running: true)
        }
    }

    // MARK: - Mouse Interactions & Context Menu

    private func handleDragStart(_ mouse: NSPoint) {
        isDragging = false
        wanderMoving = false
        lastInteractTime = ProcessInfo.processInfo.systemUptime
        dragStartMouse = mouse
        dragStartOrigin = currentStageTopLeft()
        lastDragMouseX = mouse.x
        dragVelocityX = 0
    }

    private func handleDragMove(_ mouse: NSPoint) {
        isDragging = true
        let dx = mouse.x - dragStartMouse.x
        let dy = mouse.y - dragStartMouse.y
        dragVelocityX = mouse.x - lastDragMouseX
        lastDragMouseX = mouse.x
        // Note: AppKit mouse Y increases upward, top-left Y increases downward
        let nextTopLeft = NSPoint(x: dragStartOrigin.x + dx, y: dragStartOrigin.y - dy)
        applyLayout(stageTopLeft: nextTopLeft)
    }

    private func handleDragEnd(moved: Bool) {
        isDragging = false
        lastInteractTime = ProcessInfo.processInfo.systemUptime
        if moved {
            landBounceRemaining = 0.42
            wanderCooldownSec = Double.random(in: 8.5...16.5)
            let tl = currentStageTopLeft()
            config.posX = Int(round(tl.x))
            config.posY = Int(round(tl.y))
            savePetConfigToDisk()
        }
    }

    private func handleSingleClick() {
        lastInteractTime = ProcessInfo.processInfo.systemUptime
        wanderMoving = false
        wanderCooldownSec = Double.random(in: 9.0...17.0)
        interactRemaining = 1.15
        hopRemaining = 0.58
        let sparkles = ["✨", "♥", "★"]
        sparkleTicks += 1
        sparkleLabel.stringValue = sparkles[sparkleTicks % sparkles.count]
        sparkleRemaining = 0.85
        showBubble(renderBubbleTemplate(config.bubbleTemplate), duration: 4.5)
    }

    private func handleDoubleClick() {
        lastInteractTime = ProcessInfo.processInfo.systemUptime
        wanderMoving = false
        wanderCooldownSec = Double.random(in: 9.0...17.0)
        interactRemaining = 1.15
        hopRemaining = 0.58
        let inTok = formatTokenCount(telemetry.latestInputTokens)
        let outTok = formatTokenCount(telemetry.latestOutputTokens)
        let model = telemetry.upstreamModelId.isEmpty ? "待机" : telemetry.upstreamModelId
        showBubble("\(model) · 上下文 \(telemetry.percent)%\n本次 入 \(inTok) · 出 \(outTok)", duration: 5.5)
    }

    private func showContextMenu(event: NSEvent) {
        wanderMoving = false
        isMenuOpen = true
        defer { isMenuOpen = false }
        let menu = NSMenu(title: "AGY 桌宠")

        // Switch pet submenu
        let switchItem = NSMenuItem(title: "🐾 切换桌宠", action: nil, keyEquivalent: "")
        let switchSub = NSMenu(title: "切换桌宠")
        let builtins: [(String, String)] = [("neko", "暗夜小黑猫"), ("ghost", "赛博小幽灵"), ("mecha", "机甲小助手")]
        for (id, label) in builtins {
            let item = NSMenuItem(title: label, action: #selector(menuSelectPet(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = id
            item.state = (config.activePetId == id) ? .on : .off
            switchSub.addItem(item)
        }
        if !config.customPets.isEmpty {
            switchSub.addItem(.separator())
            for cp in config.customPets {
                let item = NSMenuItem(title: cp.name, action: #selector(menuSelectPet(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = cp.id
                item.state = (config.activePetId == cp.id) ? .on : .off
                switchSub.addItem(item)
            }
        }
        switchItem.submenu = switchSub
        menu.addItem(switchItem)

        // Size submenu
        let sizeItem = NSMenuItem(title: "桌宠大小 (\(config.size)%)", action: nil, keyEquivalent: "")
        let sizeSub = NSMenu(title: "桌宠大小")
        for s in [60, 80, 100, 125, 150, 200, 300, 400, 500] {
            let item = NSMenuItem(title: "\(s)%", action: #selector(menuChangeSize(_:)), keyEquivalent: "")
            item.target = self
            item.tag = s
            item.state = (config.size == s) ? .on : .off
            sizeSub.addItem(item)
        }
        sizeItem.submenu = sizeSub
        menu.addItem(sizeItem)

        menu.addItem(.separator())

        let selItem = NSMenuItem(title: "允许被选中", action: #selector(menuToggleSelectable), keyEquivalent: "")
        selItem.target = self
        selItem.state = config.selectable ? .on : .off
        menu.addItem(selItem)

        let wanderItem = NSMenuItem(title: "自主桌面漫步", action: #selector(menuToggleWander), keyEquivalent: "")
        wanderItem.target = self
        wanderItem.state = config.autoWander ? .on : .off
        menu.addItem(wanderItem)

        let bubbleItem = NSMenuItem(title: "显示互动气泡", action: #selector(menuToggleBubble), keyEquivalent: "")
        bubbleItem.target = self
        bubbleItem.state = config.showSpeechBubble ? .on : .off
        menu.addItem(bubbleItem)

        let topItem = NSMenuItem(title: "桌面置顶悬浮", action: #selector(menuToggleTopmost), keyEquivalent: "")
        topItem.target = self
        topItem.state = config.alwaysOnTop ? .on : .off
        menu.addItem(topItem)

        menu.addItem(.separator())

        let resetItem = NSMenuItem(title: "召回默认位置", action: #selector(menuResetPos), keyEquivalent: "")
        resetItem.target = self
        menu.addItem(resetItem)

        let closeItem = NSMenuItem(title: "关闭桌宠", action: #selector(menuClosePet), keyEquivalent: "")
        closeItem.target = self
        menu.addItem(closeItem)

        NSMenu.popUpContextMenu(menu, with: event, for: stageView)
    }

    @objc private func menuSelectPet(_ sender: NSMenuItem) {
        guard let nextId = sender.representedObject as? String, !nextId.isEmpty else { return }
        config.activePetId = nextId
        config.customImagePath = ""
        config.activeCustomPet = config.customPets.first { $0.id == nextId }
        if let entry = config.activeCustomPet, !entry.filename.isEmpty {
            let cand = (config.petsDir as NSString).appendingPathComponent(entry.filename)
            if FileManager.default.fileExists(atPath: cand) {
                config.customImagePath = cand
            }
        }
        savePetConfigToDisk()
        applyConfigAndPosition(forcePosition: false)
        writeStatusFile(running: true)
    }

    @objc private func menuChangeSize(_ sender: NSMenuItem) {
        config.size = clampInt(sender.tag, 60, 500)
        savePetConfigToDisk()
        applyConfigAndPosition(forcePosition: false)
    }

    @objc private func menuToggleSelectable() {
        config.selectable.toggle()
        savePetConfigToDisk()
        applyConfigAndPosition(forcePosition: false)
    }

    @objc private func menuToggleWander() {
        config.autoWander.toggle()
        savePetConfigToDisk()
        applyConfigAndPosition(forcePosition: false)
    }

    @objc private func menuToggleBubble() {
        config.showSpeechBubble.toggle()
        savePetConfigToDisk()
        applyConfigAndPosition(forcePosition: false)
    }

    @objc private func menuToggleTopmost() {
        config.alwaysOnTop.toggle()
        savePetConfigToDisk()
        applyConfigAndPosition(forcePosition: false)
    }

    @objc private func menuResetPos() {
        config.posX = nil
        config.posY = nil
        savePetConfigToDisk()
        applyConfigAndPosition(forcePosition: true)
    }

    @objc private func menuClosePet() {
        config.enabled = false
        savePetConfigToDisk()
        shutdownGracefully()
    }

    // MARK: - Shutdown

    func shutdownGracefully() {
        if disposed { return }
        disposed = true
        animTimer?.invalidate(); animTimer = nil
        pollTimer?.invalidate(); pollTimer = nil
        bubbleHideTimer?.invalidate(); bubbleHideTimer = nil
        sigTermSource?.cancel(); sigTermSource = nil
        sigIntSource?.cancel(); sigIntSource = nil

        lockPanel?.orderOut(nil)
        petPanel?.orderOut(nil)
        writeStatusFile(running: false)
        try? FileManager.default.removeItem(atPath: pidFilePath)
        NSApplication.shared.terminate(nil)
    }
}

// MARK: - Entrypoint

func defaultDataDir() -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return (((home as NSString).appendingPathComponent(".gemini") as NSString).appendingPathComponent("antigravity") as NSString).appendingPathComponent("plugin_data/agy-monitor")
}

func readExistingPid(dataDir: String) -> pid_t? {
    let binDir = (dataDir as NSString).appendingPathComponent("bin")
    let pidFile = (binDir as NSString).appendingPathComponent("agy_desktop_pet_mac.pid")
    if let s = try? String(contentsOfFile: pidFile, encoding: .utf8),
       let p = Int32(s.trimmingCharacters(in: .whitespacesAndNewlines)), p > 0 {
        return p
    }
    let statusFile = (dataDir as NSString).appendingPathComponent("pet_status.json")
    if let data = try? Data(contentsOf: URL(fileURLWithPath: statusFile)),
       let doc = try? JSONSerialization.jsonObject(with: stripUtf8Bom(data)) as? [String: Any],
       let p = jsonInt(doc["pid"]), p > 0 {
        return Int32(p)
    }
    return nil
}

func stopCompanion(dataDir: String) {
    guard let pid = readExistingPid(dataDir: dataDir), pid > 0 else { return }
    if kill(pid, 0) != 0 && errno == ESRCH { return }
    _ = kill(pid, SIGTERM)
    let deadline = Date().addingTimeInterval(1.5)
    while Date() < deadline {
        if kill(pid, 0) != 0 && errno == ESRCH { break }
        Thread.sleep(forTimeInterval: 0.05)
    }
}

func probeDesktop() {
    if let dict = CGSessionCopyCurrentDictionary() as? [String: Any], !dict.isEmpty {
        print("default")
        return
    }
    _ = NSApplication.shared
    if !NSScreen.screens.isEmpty {
        print("default")
    } else {
        print("isolated")
    }
}

var cliDataDir = defaultDataDir()
var cliParentPid: Int32 = 0
var doStop = false
var doProbe = false

let args = CommandLine.arguments
var idx = 1
while idx < args.count {
    let a = args[idx]
    if a == "--probe-desktop" {
        doProbe = true
    } else if a == "--stop" {
        doStop = true
    } else if a == "--data-dir", idx + 1 < args.count {
        idx += 1
        cliDataDir = args[idx]
    } else if a == "--parent-pid", idx + 1 < args.count {
        idx += 1
        if let p = Int32(args[idx]), p > 0 { cliParentPid = p }
    }
    idx += 1
}

if doProbe {
    probeDesktop()
    exit(0)
}

if doStop {
    stopCompanion(dataDir: cliDataDir)
    exit(0)
}

let binDir = (cliDataDir as NSString).appendingPathComponent("bin")
try? FileManager.default.createDirectory(atPath: binDir, withIntermediateDirectories: true)
let lockPath = (binDir as NSString).appendingPathComponent("agy_desktop_pet_mac.lock")
let lockFd = open(lockPath, O_CREAT | O_RDWR, 0o644)
if lockFd >= 0 {
    if flock(lockFd, LOCK_EX | LOCK_NB) != 0 {
        close(lockFd)
        exit(0)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = PetHostController(dataDir: cliDataDir, parentPid: cliParentPid)
controller.start()
app.run()
