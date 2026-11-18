import AppKit
import OneweekKit
import SwiftUI

struct TaskRowView: View {
    @Environment(BoardStore.self) private var store
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let task: TaskItem

    @State private var colorsOpen = false

    private var isActive: Bool { store.activeRowId == task.id }
    /// Done rows sit at the bottom: their toolbar opens upward, as on the site.
    private var opensUpward: Bool { task.checked && !task.subtask }

    var body: some View {
        let highlighted = theme.highlight(task.color) != nil
        HStack(alignment: .top, spacing: 7) {
            TaskCheckbox(checked: task.checked, highlighted: highlighted) { store.toggleChecked(task.id) }
                .padding(.top, max(0, (Typeface.lineHeight - TaskCheckbox.side) / 2))

            TaskTextView(
                rowId: task.id,
                text: task.text,
                textColor: theme.nsRowTextColor(highlighted: highlighted),
                completed: task.checked,
                focusRequest: store.focusRequest?.rowId == task.id ? store.focusRequest?.token : nil,
                theme: theme,
                store: store
            )

            let subtasks = store.subtaskCount(of: task.id)
            if subtasks > 0 {
                Button {
                    store.toggleCollapsed(task.id)
                } label: {
                    HStack(spacing: 3) {
                        // How many subtasks are folded away, as on the site.
                        if task.collapsed {
                            Text("\(subtasks)")
                                .font(.system(size: Typeface.bodySize * 0.65, weight: .semibold).monospacedDigit())
                                .opacity(0.45)
                                .transition(.opacity)
                        }
                        Image(systemName: "chevron.down")
                            .font(.system(size: 10, weight: .semibold))
                            .rotationEffect(.degrees(task.collapsed ? -90 : 0))
                            .opacity(0.5)
                            .frame(width: 16)
                    }
                    .frame(height: Typeface.lineHeight)
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressStyle())
                .help(task.collapsed ? "Show \(subtasks) subtask\(subtasks == 1 ? "" : "s")" : "Hide subtasks")
                .animation(.calm(.easeOut(duration: 0.18), reduceMotion: reduceMotion), value: task.collapsed)
            }
        }
        .padding(.vertical, 4.5)
        .padding(.leading, task.subtask ? 32 : 7)
        .padding(.trailing, 6)
        .background(theme.highlight(task.color) ?? .clear, in: RoundedRectangle(cornerRadius: 6))
        .overlay {
            RoundedRectangle(cornerRadius: 6).strokeBorder(isActive ? theme.hairline : .clear, lineWidth: 1)
        }
        .overlay(alignment: opensUpward ? .topLeading : .bottomLeading) { toolbar }
        .animation(.calm(.easeOut(duration: 0.15), reduceMotion: reduceMotion), value: isActive)
        .animation(.easeOut(duration: 0.15), value: task.color)
        .onChange(of: isActive) { _, active in
            if !active { colorsOpen = false }
        }
    }

    /// Hangs off the row's edge: a zero-height anchor the toolbar is attached to.
    @ViewBuilder
    private var toolbar: some View {
        if isActive {
            Color.clear.frame(height: 0).overlay(alignment: opensUpward ? .bottomLeading : .topLeading) {
                RowToolbar(task: task, colorsOpen: $colorsOpen, opensUpward: opensUpward)
                    .padding(opensUpward ? .bottom : .top, 5)
            }
            .transition(.opacity.combined(with: .offset(y: opensUpward ? 3 : -3)))
        }
    }
}

/// The site's square checkbox: an outline, filled with a check when done.
struct TaskCheckbox: View {
    static let side: CGFloat = 17

    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let checked: Bool
    let highlighted: Bool
    let action: () -> Void

    var body: some View {
        let ink = theme.rowTextColor(highlighted: highlighted)
        let paper: Color = highlighted ? theme.highlightedBoxFill : theme.backgroundColor
        let mark: Color = highlighted
            ? (theme.usesDarkHighlights ? Color(hex: "#1a1a1a") : .white.opacity(0.95))
            : theme.backgroundColor
        Button(action: action) {
            RoundedRectangle(cornerRadius: 2.5)
                .fill(checked ? ink : paper)
                .overlay(RoundedRectangle(cornerRadius: 2.5).strokeBorder(ink, lineWidth: 1.2))
                .overlay {
                    if checked {
                        CheckMark()
                            .stroke(mark, style: StrokeStyle(lineWidth: 1.45, lineCap: .round, lineJoin: .round))
                            .padding(Self.side * 0.18)
                            .transition(.scale(scale: 0.5).combined(with: .opacity))
                    }
                }
                .frame(width: Self.side, height: Self.side)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle(scale: 0.86))
        .animation(.calm(.spring(duration: 0.22, bounce: 0.3), reduceMotion: reduceMotion), value: checked)
        .accessibilityLabel(checked ? "Mark task incomplete" : "Mark task complete")
    }
}

/// The site's check-mark.svg path, in a 32-point box.
struct CheckMark: Shape {
    func path(in rect: CGRect) -> Path {
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + rect.width * x / 32, y: rect.minY + rect.height * y / 32)
        }
        var path = Path()
        path.move(to: point(2, 16.33))
        path.addLine(to: point(11.33, 25.67))
        path.addLine(to: point(30, 7))
        return path
    }
}

/// Lays out square buttons that shrink together to fit the row, as on the site.
/// Subviews marked `FixedWidth` (the separator) keep their own width.
private struct SquareRow: Layout {
    var maxSide: CGFloat = 28
    var minSide: CGFloat = 19

    private func side(_ width: CGFloat?, _ subviews: Subviews) -> CGFloat {
        let fixed = subviews.filter { $0[FixedWidth.self] }.reduce(0) { $0 + $1.sizeThatFits(.unspecified).width }
        let squares = CGFloat(subviews.filter { !$0[FixedWidth.self] }.count)
        guard let width, squares > 0 else { return maxSide }
        return min(maxSide, max(minSide, ((width - fixed) / squares).rounded(.down)))
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let s = side(proposal.width, subviews)
        let width = subviews.reduce(0) { $0 + ($1[FixedWidth.self] ? $1.sizeThatFits(.unspecified).width : s) }
        return CGSize(width: width, height: s)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let s = side(bounds.width, subviews)
        var x = bounds.minX
        for subview in subviews {
            let width = subview[FixedWidth.self] ? subview.sizeThatFits(.unspecified).width : s
            subview.place(at: CGPoint(x: x, y: bounds.minY), proposal: ProposedViewSize(width: width, height: s))
            x += width
        }
    }
}

private struct FixedWidth: LayoutValueKey {
    static let defaultValue = false
}

/// Done, color, subtask, main thing, drag and (set apart) delete.
struct RowToolbar: View {
    @Environment(BoardStore.self) private var store
    @Environment(\.theme) private var theme
    let task: TaskItem
    @Binding var colorsOpen: Bool
    let opensUpward: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            if colorsOpen, opensUpward { swatches }
            SquareRow {
                ToolbarButton(help: "Done") { NSApp.keyWindow?.makeFirstResponder(nil) } icon: {
                    Glyph(name: "done")
                }
                ToolbarButton(help: "Color", lit: colorsOpen) { colorsOpen.toggle() } icon: {
                    ColorDot(color: theme.highlight(task.color))
                }
                ToolbarButton(help: task.subtask ? "Make a task" : "Make a subtask") { store.indent(task.id) } icon: {
                    Glyph(name: "subtask")
                }
                ToolbarButton(help: "This week's main thing", lit: task.isMain) { store.toggleMainThing(task.id) } icon: {
                    Glyph(name: "main-thing")
                }
                DragHandle(rowId: task.id, store: store, tint: theme.nsTextColor)
                    .help("Drag to move")
                Rectangle()
                    .fill(theme.hairline)
                    .frame(width: 1)
                    .padding(.vertical, 6)
                    .padding(.horizontal, 3)
                    .layoutValue(key: FixedWidth.self, value: true)
                ToolbarButton(help: "Delete (⌘Z to undo)", danger: true) { store.delete(task.id) } icon: {
                    Glyph(name: "delete")
                }
            }
            .padding(3)
            .background(theme.backgroundColor, in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(theme.hairline, lineWidth: 1))
            if colorsOpen, !opensUpward { swatches }
        }
        .fixedSize(horizontal: false, vertical: true)
        .animation(.easeOut(duration: 0.15), value: colorsOpen)
    }

    private var swatches: some View {
        ColorSwatches(selected: task.color) { color in
            store.setColor(task.id, color)
            colorsOpen = false
        }
        .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: opensUpward ? .bottomLeading : .topLeading)))
    }
}

struct ToolbarButton<Icon: View>: View {
    @Environment(\.theme) private var theme
    let help: String
    var lit = false
    var danger = false
    let action: () -> Void
    @ViewBuilder let icon: () -> Icon
    @State private var hovering = false

    var body: some View {
        let red = Color(hex: "#c62828")
        Button(action: action) {
            GeometryReader { proxy in
                icon()
                    .frame(width: proxy.size.width * 0.8, height: proxy.size.height * 0.8)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .foregroundStyle(danger && hovering ? red : theme.textColor)
            .opacity(hovering || lit ? 1 : 0.65)
            .background(
                hovering ? (danger ? red.opacity(0.1) : theme.textColor.opacity(0.08)) : .clear,
                in: RoundedRectangle(cornerRadius: 6)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle(scale: 0.9))
        .help(help)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

/// The color button's ring (color.svg), filled with the row's color once set.
struct ColorDot: View {
    @Environment(\.theme) private var theme
    let color: Color?

    var body: some View {
        GeometryReader { proxy in
            let side = min(proxy.size.width, proxy.size.height)
            ZStack {
                Circle()
                    .fill(color ?? .clear)
                    .frame(width: side * 0.64, height: side * 0.64)
                Glyph(name: "color")
                    .foregroundStyle(color == nil ? theme.textColor : theme.textColor.opacity(0.3))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

struct ColorSwatches: View {
    @Environment(\.theme) private var theme
    let selected: String?
    let pick: (String?) -> Void

    var body: some View {
        let colors: [String?] = [nil] + TaskColors.palette.map(Optional.some)
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(minimum: 16, maximum: 26), spacing: 6), count: 5), spacing: 6) {
            ForEach(colors, id: \.self) { color in
                Button {
                    pick(color)
                } label: {
                    RoundedRectangle(cornerRadius: 5)
                        .fill(theme.highlight(color) ?? .clear)
                        .overlay {
                            if color == nil {
                                Capsule().frame(height: 1.4).padding(.horizontal, 4).rotationEffect(.degrees(-45)).opacity(0.7)
                            }
                        }
                        .overlay(
                            RoundedRectangle(cornerRadius: 5).strokeBorder(
                                color == selected ? theme.textColor : theme.hairline,
                                lineWidth: color == selected ? 1.5 : 1
                            )
                        )
                        .aspectRatio(1, contentMode: .fit)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressStyle(scale: 0.88))
            }
        }
        .frame(maxWidth: 5 * 26 + 4 * 6)
        .padding(9)
        .background(theme.backgroundColor, in: RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(theme.hairline, lineWidth: 1))
        .shadow(color: .black.opacity(0.18), radius: 12, y: 9)
    }
}
