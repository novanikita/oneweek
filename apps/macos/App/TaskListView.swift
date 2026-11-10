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
    /// Room under the last row for its edit toolbar.
    let bottomInset: CGFloat

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

/// What a move animates on: order, done state, nesting. Typing never animates.
private struct RowsShape: Equatable {
    let rows: [String]

    init(_ tasks: [TaskItem]) {
        rows = tasks.map { "\($0.id)\($0.checked ? 1 : 0)\($0.subtask ? 1 : 0)" }
    }
}

struct TaskListView: View {
    @Environment(BoardStore.self) private var store
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let slot: Slot
    let rows: [TaskItem]
    let region: ListRegion

    @State private var rowFrames: [UUID: CGRect] = [:]
    @State private var dropLineY: CGFloat?
    @State private var dropBefore: UUID?
    /// Week and workspace seen last: switching them swaps lists without animating rows.
    @State private var shownContext = ""

    private var space: String { "\(slot.rawValue)-\(region.rawValue)" }

    var body: some View {
        let visible = store.visibleRows(rows)
        let context = "\(store.weekOffset)|\(store.activeWorkspaceId ?? "")"
        let animates = !reduceMotion && context == shownContext
        Group {
            if region == .mainThing {
                rowStack(visible)
                    .padding(.horizontal, 6)
                    .frame(maxWidth: .infinity, minHeight: 34, alignment: .topLeading)
            } else {
                scrollingList(visible)
            }
        }
        .animation(animates ? .snappy(duration: 0.26) : nil, value: RowsShape(visible))
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
        .onChange(of: context, initial: true) { _, new in shownContext = new }
    }

    private func scrollingList(_ visible: [TaskItem]) -> some View {
        let firstDone = visible.firstIndex { $0.checked && !$0.subtask }
        let open = firstDone.map { Array(visible[..<$0]) } ?? visible
        let done = firstDone.map { Array(visible[$0...]) } ?? []
        let active = store.activeRowId
        return ScrollView(.vertical) {
            PinnedColumn(gap: done.isEmpty ? 0 : 12, bottomInset: done.isEmpty ? 44 : 8) {
                Color.clear.frame(width: 0).containerRelativeFrame(.vertical)
                rowStack(open).zIndex(open.contains { $0.id == active } ? 1 : 0)
                rowStack(done).zIndex(done.contains { $0.id == active } ? 1 : 0)
            }
            .padding(.horizontal, 6)
            .background {
                Color.clear.contentShape(Rectangle()).onTapGesture(perform: tappedEmptySpace)
            }
        }
        .scrollIndicators(.never)
    }

    private func rowStack(_ rows: [TaskItem]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(rows) { task in
                TaskRowView(task: task)
                    .zIndex(task.id == store.activeRowId ? 1 : 0)
                    .transition(.opacity)
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
                .fill(theme.textColor.opacity(0.7))
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
