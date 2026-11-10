import AppKit
import OneweekKit
import SwiftUI

/// One of the site's icons (its own SVGs), painted in the current text color.
struct Glyph: View {
    let name: String
    var flipped = false

    var body: some View {
        Image(name)
            .resizable()
            .renderingMode(.template)
            .scaledToFit()
            .scaleEffect(x: flipped ? -1 : 1)
    }
}

/// Presses sink a little, as buttons on the site do.
struct PressStyle: ButtonStyle {
    var scale: CGFloat = 0.92

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct Hairline: View {
    @Environment(\.theme) private var theme
    let axis: Axis

    init(_ axis: Axis) {
        self.axis = axis
    }

    var body: some View {
        Rectangle()
            .fill(theme.hairline)
            .frame(width: axis == .vertical ? 1 : nil, height: axis == .horizontal ? 1 : nil)
    }
}

/// Header icon: sidebar, arrows, close.
struct IconButton: View {
    let glyph: String
    var size: CGFloat = 16
    var flipped = false
    let help: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Glyph(name: glyph, flipped: flipped)
                .frame(width: size, height: size)
                .opacity(hovering ? 1 : 0.8)
                .frame(width: 30, height: 30)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .help(help)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

/// The site's small uppercase labels: days, sections, tabs.
struct CapsLabel: View {
    let text: String
    var size: CGFloat = 10
    var opacity: Double = 0.35

    var body: some View {
        Text(text.uppercased())
            .font(Typeface.semibold(size))
            .tracking(size * 0.08)
            .opacity(opacity)
            .lineLimit(1)
    }
}

/// Bordered text button: "now", "log out", "move remaining tasks".
struct OutlineButton<Label: View>: View {
    @Environment(\.theme) private var theme
    var restingOpacity: Double = 1
    var horizontalPadding: CGFloat = 8
    var height: CGFloat = 26
    let action: () -> Void
    @ViewBuilder let label: () -> Label
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            label()
                .padding(.horizontal, horizontalPadding)
                .frame(height: height)
                .background(hovering ? theme.textColor.opacity(0.06) : .clear, in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(theme.hairline, lineWidth: 1))
                .opacity(hovering ? 1 : restingOpacity)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle(scale: 0.96))
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.15), value: hovering)
    }
}

/// Toasts at the bottom, styled like the site's: a dark notice pill and a light undo hint.
struct ToastPill: View {
    @Environment(\.theme) private var theme
    let text: String
    let kind: ToastKind

    var body: some View {
        switch kind {
        case .notice:
            Text(text)
                .font(Typeface.regular(13))
                .foregroundStyle(theme.backgroundColor)
                .padding(.horizontal, 15)
                .padding(.vertical, 8)
                .background(theme.textColor.opacity(0.88), in: Capsule())
                .shadow(color: .black.opacity(0.2), radius: 6, y: 4)
        case .hint:
            Text(text)
                .font(Typeface.regular(12.5))
                .padding(.horizontal, 13)
                .padding(.vertical, 7)
                .background(theme.backgroundColor, in: Capsule())
                .background(theme.textColor.opacity(0.08), in: Capsule())
                .overlay(Capsule().strokeBorder(theme.hairline, lineWidth: 1))
                .shadow(color: .black.opacity(0.12), radius: 5, y: 3)
        }
    }
}

/// Puts SwiftUI content into the window's title bar. An empty unified toolbar
/// makes the title bar 52 points tall with the window buttons centered in it,
/// as in Notes; the content lives inside the title bar, so it gets the clicks.
struct TitlebarContent<Content: View>: NSViewRepresentable {
    static var height: CGFloat { 52 }
    /// Where the content starts: clear of close / minimize / zoom.
    static var leadingInset: CGFloat { 82 }

    let content: Content

    final class Coordinator {
        let hosting = NSHostingView(rootView: AnyView(EmptyView()))
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> AnchorView {
        let anchor = AnchorView()
        anchor.hosting = context.coordinator.hosting
        return anchor
    }

    func updateNSView(_ anchor: AnchorView, context: Context) {
        context.coordinator.hosting.rootView = AnyView(content)
        anchor.install()
    }

    static func dismantleNSView(_ anchor: AnchorView, coordinator: Coordinator) {
        coordinator.hosting.removeFromSuperview()
    }

    final class AnchorView: NSView {
        var hosting: NSHostingView<AnyView>?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            install()
        }

        func install() {
            guard let window, let hosting, hosting.superview == nil else { return }
            if window.toolbar == nil {
                window.toolbar = NSToolbar(identifier: "oneweek.titlebar")
                window.toolbarStyle = .unified
                window.titleVisibility = .hidden
                window.titlebarAppearsTransparent = true
                window.titlebarSeparatorStyle = .none
            }
            guard let titlebar = window.standardWindowButton(.closeButton)?.superview else { return }
            hosting.sizingOptions = []
            hosting.translatesAutoresizingMaskIntoConstraints = false
            titlebar.addSubview(hosting)
            NSLayoutConstraint.activate([
                hosting.leadingAnchor.constraint(equalTo: titlebar.leadingAnchor, constant: TitlebarContent.leadingInset),
                hosting.trailingAnchor.constraint(equalTo: titlebar.trailingAnchor),
                // The band the window buttons are centered in, not the whole title bar view.
                hosting.topAnchor.constraint(equalTo: titlebar.topAnchor),
                hosting.heightAnchor.constraint(equalToConstant: TitlebarContent.height),
            ])
        }
    }
}

/// Drags the window and zooms it on a double-click, like a title bar.
struct WindowDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> DragView { DragView() }
    func updateNSView(_ view: DragView, context: Context) {}

    final class DragView: NSView {
        override func mouseDown(with event: NSEvent) {
            guard let window else { return }
            if event.clickCount == 2 {
                switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
                case "Minimize": window.miniaturize(nil)
                case "None": break
                default: window.zoom(nil)
                }
                return
            }
            window.performDrag(with: event)
        }
    }
}
