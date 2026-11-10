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

struct WeekBoard: View {
    private let slots: [Slot] = [.monday, .tuesday, .wednesday, .thursday, .friday, .saturday, .sunday, .nextWeek]

    var body: some View {
        BoardSplit {
            DayGrid {
                ForEach(Array(slots.enumerated()), id: \.element) { index, slot in
                    DayColumn(slot: slot)
                        .overlay(alignment: .trailing) { Hairline(.vertical) }
                        .overlay(alignment: .top) { if index >= 4 { Hairline(.horizontal) } }
                }
            }
            GeneralPanel()
        }
    }
}

struct DayColumn: View {
    @Environment(BoardStore.self) private var store
    let slot: Slot

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            header
                .frame(height: 22)
                .padding(.horizontal, 10)
                .padding(.top, 8)
            TaskListView(slot: slot, rows: store.lists[slot] ?? [], region: .list)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder
    private var header: some View {
        if let date = store.date(of: slot), let name = slot.dayName {
            let today = store.isToday(slot)
            HStack(spacing: 5) {
                Text(name.lowercased())
                    .font(Typeface.semibold(13))
                    .foregroundStyle(today ? .primary : .secondary)
                Text("\(WeekCalendar.dayOfMonth(date))")
                    .font(Typeface.semibold(12))
                    .monospacedDigit()
                    .foregroundStyle(today ? AnyShapeStyle(.white) : AnyShapeStyle(.secondary))
                    .frame(minWidth: 20, minHeight: 20)
                    .background(today ? Color.accentColor : .clear, in: Circle())
            }
        } else {
            Text("next week").font(Typeface.semibold(13)).foregroundStyle(.secondary)
        }
    }
}

struct GeneralPanel: View {
    @Environment(BoardStore.self) private var store

    var body: some View {
        let split = store.splitGeneral()
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                SectionLabel(text: "this week’s main thing")
                Spacer()
                if store.canMoveRemaining {
                    Button("move remaining tasks") { Task { await store.moveRemaining() } }
                        .buttonStyle(.link)
                        .font(.callout)
                }
            }
            .frame(height: 22)
            .padding(.horizontal, 10)
            .padding(.top, 8)

            TaskListView(slot: .general, rows: split.main, region: .mainThing)

            SectionLabel(text: "tasks")
                .frame(height: 22)
                .padding(.horizontal, 10)
                .padding(.top, 14)

            TaskListView(slot: .general, rows: split.rest, region: .list)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
