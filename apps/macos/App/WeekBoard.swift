import OneweekKit
import SwiftUI

/// Two thirds for the days, the rest for the week's list. Computed in the layout
/// pass and on whole points, so nothing lags or shimmers while the window resizes.
private struct BoardSplit: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let left = (bounds.width * 2 / 3).rounded()
        subviews[0].place(at: bounds.origin, proposal: ProposedViewSize(width: left, height: bounds.height))
        subviews[1].place(
            at: CGPoint(x: bounds.minX + left, y: bounds.minY),
            proposal: ProposedViewSize(width: bounds.width - left, height: bounds.height)
        )
    }
}

/// Equal cells, four across and two down, on whole points.
private struct DayGrid: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        func edge(_ total: CGFloat, _ index: Int, of count: Int) -> CGFloat {
            (total * CGFloat(index) / CGFloat(count)).rounded()
        }
        for (index, subview) in subviews.enumerated() {
            let column = index % 4
            let row = index / 4
            let x = edge(bounds.width, column, of: 4)
            let y = edge(bounds.height, row, of: 2)
            subview.place(
                at: CGPoint(x: bounds.minX + x, y: bounds.minY + y),
                proposal: ProposedViewSize(
                    width: edge(bounds.width, column + 1, of: 4) - x,
                    height: edge(bounds.height, row + 1, of: 2) - y
                )
            )
        }
    }
}

/// The site's soft glow around the cell under the pointer: on at once, fading out.
private struct HoverGlow: ViewModifier {
    @Environment(\.theme) private var theme
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .background {
                Rectangle()
                    .fill(theme.backgroundColor)
                    .shadow(color: theme.textColor.opacity(hovering ? 0.22 : 0), radius: 3.5)
            }
            .zIndex(hovering ? 1 : 0)
            .onHover { hovering = $0 }
            .animation(hovering ? nil : .easeOut(duration: 0.5), value: hovering)
    }
}

/// A rounded shell with hairlines between the cells, as on the site.
struct WeekBoard: View {
    @Environment(\.theme) private var theme

    private let slots: [Slot] = [.monday, .tuesday, .wednesday, .thursday, .friday, .saturday, .sunday, .nextWeek]

    var body: some View {
        BoardSplit {
            DayGrid {
                ForEach(Array(slots.enumerated()), id: \.element) { index, slot in
                    DayColumn(slot: slot)
                        .overlay(alignment: .trailing) { Hairline(.vertical) }
                        .overlay(alignment: .top) { if index >= 4 { Hairline(.horizontal) } }
                        .modifier(HoverGlow())
                }
            }
            GeneralPanel()
                .modifier(HoverGlow())
        }
        .background(theme.backgroundColor)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(theme.hairline, lineWidth: 1))
    }
}

struct DayColumn: View {
    @Environment(BoardStore.self) private var store
    let slot: Slot

    private var title: String {
        guard let date = store.date(of: slot), let name = slot.dayName else { return "next week" }
        return "\(name), \(WeekCalendar.dayOfMonth(date))"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            CapsLabel(text: title, opacity: store.isToday(slot) ? 0.9 : 0.35)
                .padding(.horizontal, 10)
                .padding(.top, 11)
            TaskListView(slot: slot, rows: store.lists[slot] ?? [], region: .list)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

struct GeneralPanel: View {
    @Environment(BoardStore.self) private var store

    var body: some View {
        let split = store.splitGeneral()
        let editingMain = split.main.contains { $0.id == store.activeRowId }
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                CapsLabel(text: "this week’s main thing")
                Spacer()
                if store.canMoveRemaining {
                    OutlineButton(restingOpacity: 0.55, horizontalPadding: 9, height: 20, action: {
                        Task { await store.moveRemaining() }
                    }) {
                        CapsLabel(text: "move remaining tasks", opacity: 1)
                    }
                    .transition(.opacity)
                }
            }
            .frame(height: 20)
            .padding(.horizontal, 10)
            .padding(.top, 8)
            .animation(.easeOut(duration: 0.2), value: store.canMoveRemaining)

            TaskListView(slot: .general, rows: split.main, region: .mainThing)
                .zIndex(editingMain ? 1 : 0)

            CapsLabel(text: "tasks")
                .padding(.horizontal, 10)
                .padding(.top, 40)

            TaskListView(slot: .general, rows: split.rest, region: .list)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
