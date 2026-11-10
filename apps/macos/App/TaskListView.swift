import AppKit
import OneweekKit
import SwiftUI

enum ListRegion: String {
    case list, mainThing
}

private struct RowFramesKey: PreferenceKey {
    static let defaultValue: [UUID: CGRect] = [:]
    static func reduce(value: inout [UUID: CGRect], nextValue: () -> [UUID: CGRect]) {
        value.merge(nextValue()) { $1 }
    }
}

/// Open rows from the top, done rows pinned to the bottom of the viewport.
/// Subviews: a strut as tall as the viewport, the open rows, the done rows.
/// One layout pass on whole points: the pile can't trail the window while resizing.
private struct PinnedColumn: Layout {
    let gap: CGFloat
    private let bottomInset: CGFloat = 8

    private func heights(_ subviews: Subviews, width: CGFloat?) -> (strut: CGFloat, open: CGFloat, done: CGFloat) {
        let proposal = ProposedViewSize(width: width, height: nil)
        return (
            subviews[0].sizeThatFits(.unspecified).height,
            subviews[1].sizeThatFits(proposal).height,
            subviews[2].sizeThatFits(proposal).height
        )
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let h = heights(subviews, width: proposal.width)
        return CGSize(width: proposal.width ?? 240, height: max(h.strut, h.open + gap + h.done + bottomInset).rounded(.up))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let h = heights(subviews, width: bounds.width)
        let width = ProposedViewSize(width: bounds.width, height: nil)
        subviews[0].place(at: bounds.origin, proposal: .unspecified)
        subviews[1].place(at: bounds.origin, proposal: width)
        subviews[2].place(at: CGPoint(x: bounds.minX, y: (bounds.maxY - h.done - bottomInset).rounded()), proposal: width)
    }
}

struct TaskListView: View {
    @Environment(BoardStore.self) private var store
    let slot: Slot
    let rows: [TaskItem]
    let region: ListRegion

    @State private var rowFrames: [UUID: CGRect] = [:]
    @State private var dropLineY: CGFloat?
    @State private var dropBefore: UUID?

    private var space: String { "\(slot.rawValue)-\(region.rawValue)" }

    var body: some View {
        let visible = store.visibleRows(rows)
        Group {
            if region == .mainThing {
                rowStack(visible)
                    .padding(.horizontal, 6)
                    .frame(maxWidth: .infinity, minHeight: 34, alignment: .topLeading)
            } else {
                scrollingList(visible)
            }
        }
        .coordinateSpace(.named(space))
        .overlay(alignment: .topLeading) { dropLine }
        .onPreferenceChange(RowFramesKey.self) { rowFrames = $0 }
        .onDrop(
            of: [.oneweekRow],
            delegate: RowDropDelegate(
                store: store, slot: slot, region: region, frames: rowFrames, visible: visible,
                lineY: $dropLineY, before: $dropBefore
            )
        )
        .onChange(of: store.draggingRowId) { _, dragging in
            if dragging == nil {
                dropLineY = nil
                dropBefore = nil
            }
        }
    }

    private func scrollingList(_ visible: [TaskItem]) -> some View {
        let firstDone = visible.firstIndex { $0.checked && !$0.subtask }
        return ScrollView(.vertical) {
            PinnedColumn(gap: firstDone == nil ? 0 : 12) {
                Color.clear.frame(width: 0).containerRelativeFrame(.vertical)
                rowStack(firstDone.map { Array(visible[..<$0]) } ?? visible)
                rowStack(firstDone.map { Array(visible[$0...]) } ?? [])
            }
            .padding(.horizontal, 6)
            .background {
                Color.clear.contentShape(Rectangle()).onTapGesture(perform: tappedEmptySpace)
            }
        }
    }

    private func rowStack(_ rows: [TaskItem]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(rows) { task in
                TaskRowView(task: task)
                    .background(GeometryReader { proxy in
                        Color.clear.preference(key: RowFramesKey.self, value: [task.id: proxy.frame(in: .named(space))])
                    })
            }
        }
    }

    @ViewBuilder
    private var dropLine: some View {
        if let dropLineY, store.draggingRowId != nil {
            RoundedRectangle(cornerRadius: 1)
                .fill(Color.accentColor)
                .frame(height: 2)
                .padding(.horizontal, 8)
                .offset(y: dropLineY - 1)
                .allowsHitTesting(false)
        }
    }

    /// First click leaves the row being edited; the next one starts a new task.
    private func tappedEmptySpace() {
        guard region == .list else { return }
        if let active = store.activeRowId, store.slot(of: active) == slot {
            NSApp.keyWindow?.makeFirstResponder(nil)
        } else {
            store.beginNewTask(in: slot)
        }
    }
}

private struct RowDropDelegate: DropDelegate {
    let store: BoardStore
    let slot: Slot
    let region: ListRegion
    let frames: [UUID: CGRect]
    let visible: [TaskItem]
    @Binding var lineY: CGFloat?
    @Binding var before: UUID?

    func validateDrop(info: DropInfo) -> Bool {
        store.draggingRowId != nil
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        let ordered = visible.compactMap { row in frames[row.id].map { (row, $0) } }
        if let hit = ordered.first(where: { info.location.y < $0.1.midY }) {
            before = hit.0.id
            lineY = hit.1.minY
        } else {
            before = nil
            lineY = ordered.last?.1.maxY ?? 4
        }
        if region == .mainThing { lineY = nil }
        return DropProposal(operation: .move)
    }

    func dropExited(info: DropInfo) {
        lineY = nil
        before = nil
    }

    func performDrop(info: DropInfo) -> Bool {
        defer {
            lineY = nil
            before = nil
        }
        guard let id = store.draggingRowId else { return false }
        store.moveRow(id, to: slot, before: before, intoMain: region == .mainThing)
        return true
    }
}
