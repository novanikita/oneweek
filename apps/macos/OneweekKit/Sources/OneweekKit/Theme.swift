import AppKit
import SwiftUI

public struct ThemeColors: Hashable, Sendable {
    public var text: String
    public var background: String

    public init(text: String, background: String) {
        self.text = text
        self.background = background
    }

    public var textColor: Color { Color(hex: text) }
    public var backgroundColor: Color { Color(hex: background) }
    public var nsTextColor: NSColor { NSColor(hex: text) }

    /// Dark backgrounds get the muted night versions of the task highlights.
    public var usesDarkHighlights: Bool { Self.luminance(background) < 0.45 }

    /// The row color for a stored (always light) palette value.
    public func highlight(_ color: String?) -> Color? {
        highlightHex(color).map(Color.init(hex:))
    }

    public func highlightHex(_ color: String?) -> String? {
        guard let color = TaskColors.normalize(color) else { return nil }
        return usesDarkHighlights ? (Self.nightHighlights[color] ?? color) : color
    }

    /// Text on a colored row is fixed so it reads on every highlight.
    public func rowTextColor(highlighted: Bool) -> Color {
        Color(hex: rowTextHex(highlighted: highlighted))
    }

    public func nsRowTextColor(highlighted: Bool) -> NSColor {
        NSColor(hex: rowTextHex(highlighted: highlighted))
    }

    private func rowTextHex(highlighted: Bool) -> String {
        guard highlighted else { return text }
        return usesDarkHighlights ? "#f0f2f4" : "#1a1a1a"
    }

    /// Checkbox fill on a colored row.
    public var highlightedBoxFill: Color {
        usesDarkHighlights ? .black.opacity(0.28) : .white.opacity(0.55)
    }

    private static let nightHighlights = [
        "#ebebeb": "#3e3e3e", "#f0e2d3": "#4a4038", "#fbe6cd": "#4e4034",
        "#f8efbf": "#4a462e", "#e2ece0": "#38463e", "#dde8f1": "#364450",
        "#e7dfee": "#403a4c", "#f3d8e1": "#4c3a42", "#f8dada": "#4c3838",
    ]

    private static func luminance(_ hex: String) -> Double {
        let (r, g, b) = Color.rgb(hex: hex)
        func linear(_ c: Double) -> Double { c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
    }
}

/// A theme made on the web. Its font stays on the web: native uses the system font.
public struct CustomTheme: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var text: String
    public var bg: String
    public var fontId: String?

    public init(id: String, name: String, text: String, bg: String, fontId: String? = nil) {
        self.id = id
        self.name = name
        self.text = text
        self.bg = bg
        self.fontId = fontId
    }
}

public struct ThemeOption: Identifiable, Hashable, Sendable {
    public var id: String
    public var name: String
}

/// The same theme keys as the web, so a choice syncs through `user_settings`.
public enum Themes {
    public static let auto = "auto"
    static let customPrefix = "custom:"

    private static let presets: [(id: String, name: String, colors: ThemeColors)] = [
        ("native-light", "Native light", ThemeColors(text: "#3a3f48", background: "#eceef2")),
        ("native-dark", "Native dark", ThemeColors(text: "#e2e5ea", background: "#2b3038")),
        ("white", "White", ThemeColors(text: "#000000", background: "#ffffff")),
        ("black", "Black", ThemeColors(text: "#ffffff", background: "#000000")),
        ("pickmi", "Pickmi", ThemeColors(text: "#6b2438", background: "#f9e6ef")),
    ]

    public static func options(custom: [CustomTheme]) -> [ThemeOption] {
        [ThemeOption(id: auto, name: "Match device")]
            + presets.map { ThemeOption(id: $0.id, name: $0.name) }
            + custom.map { ThemeOption(id: customPrefix + $0.id, name: $0.name.isEmpty ? "Own theme" : $0.name) }
    }

    /// Colors for a theme key; "auto" and unknown keys follow the system appearance.
    public static func colors(for key: String?, custom: [CustomTheme], systemIsDark: Bool) -> ThemeColors {
        if let key, key.hasPrefix(customPrefix),
           let theme = custom.first(where: { customPrefix + $0.id == key }) {
            return ThemeColors(text: theme.text, background: theme.bg)
        }
        if let preset = presets.first(where: { $0.id == key }) { return preset.colors }
        return presets[systemIsDark ? 1 : 0].colors
    }
}

public extension Color {
    static func rgb(hex: String) -> (Double, Double, Double) {
        let digits = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let value = UInt32(digits, radix: 16) ?? 0
        return (Double((value >> 16) & 0xff) / 255, Double((value >> 8) & 0xff) / 255, Double(value & 0xff) / 255)
    }

    init(hex: String) {
        let (r, g, b) = Color.rgb(hex: hex)
        self.init(.sRGB, red: r, green: g, blue: b, opacity: 1)
    }
}

public extension NSColor {
    convenience init(hex: String) {
        let (r, g, b) = Color.rgb(hex: hex)
        self.init(srgbRed: r, green: g, blue: b, alpha: 1)
    }
}
