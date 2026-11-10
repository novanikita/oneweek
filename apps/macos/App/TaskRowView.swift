import OneweekKit
import SwiftUI

struct TaskRowView: View {
    @Environment(BoardStore.self) private var store
    @Environment(\.theme) private var theme
    let task: TaskItem

    private var isActive: Bool { store.activeRowId == task.id }

    var body: some View {
        let highlight = theme.highlight(task.color)
        HStack(alignment: .top, spacing: 6) {
            Toggle("", isOn: Binding(get: { task.checked }, set: { _ in store.toggleChecked(task.id) }))
                .toggleStyle(.checkbox)
                .labelsHidden()
                .accessibilityLabel(task.checked ? "Mark task incomplete" : "Mark task complete")

            TaskTextView(
                rowId: task.id,
                text: task.text,
                textColor: theme.nsRowText(highlighted: highlight != nil),
                completed: task.checked,
                focusRequest: store.focusRequest?.rowId == task.id ? store.focusRequest?.token : nil,
                theme: theme,
                store: store
            )

            if store.subtaskCount(of: task.id) > 0 {
                Button {
                    store.toggleCollapsed(task.id)
                } label: {
                    Image(systemName: task.collapsed ? "chevron.right" : "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 16, height: 16)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(task.collapsed ? "Show subtasks" : "Hide subtasks")
            }
        }
        .padding(.vertical, 4)
        .padding(.leading, task.subtask ? 28 : 6)
        .padding(.trailing, 5)
        .background(rowFill(highlight), in: RoundedRectangle(cornerRadius: 5))
    }

    private func rowFill(_ highlight: Color?) -> Color {
        highlight ?? (isActive ? theme.textColor.opacity(0.06) : .clear)
    }
}
