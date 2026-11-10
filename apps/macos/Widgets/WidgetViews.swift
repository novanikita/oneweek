import AppIntents
import OneweekKit
import SwiftUI
import WidgetKit

struct WeekEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot
}

struct WeekProvider: TimelineProvider {
    func placeholder(in context: Context) -> WeekEntry {
        WeekEntry(date: Date(), snapshot: .sample(now: Date()))
    }

    func getSnapshot(in context: Context, completion: @escaping (WeekEntry) -> Void) {
        guard !context.isPreview else {
            completion(placeholder(in: context))
            return
        }
        Task {
            completion(WeekEntry(date: Date(), snapshot: await WidgetDataSource.live().load()))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<WeekEntry>) -> Void) {
        Task {
            let now = Date()
            let snapshot = await WidgetDataSource.live().load(now: now)
            // Re-read every half hour, and at midnight for the new day.
            let next = min(now.addingTimeInterval(30 * 60), WeekCalendar.startOfNextDay(after: now))
            completion(Timeline(entries: [WeekEntry(date: now, snapshot: snapshot)], policy: .after(next)))
        }
    }
}

extension WidgetSnapshot {
    /// What the widget gallery shows before the widget is added.
    static func sample(now: Date) -> WidgetSnapshot {
        var snapshot = WidgetSnapshot.empty(now: now)
        let rows = [
            WidgetTask(id: "1", text: "09:30 call the dentist", checked: false, subtask: false, color: "#dde8f1"),
            WidgetTask(id: "2", text: "finish the draft", checked: false, subtask: false, color: nil),
            WidgetTask(id: "3", text: "read it once more", checked: false, subtask: true, color: nil),
            WidgetTask(id: "4", text: "groceries", checked: true, subtask: false, color: nil),
        ]
        for index in snapshot.days.indices where index % 2 == 0 || snapshot.days[index].date == WeekCalendar.iso(now) {
            snapshot.days[index].tasks = rows
        }
        return snapshot
    }

    func theme(systemIsDark: Bool) -> ThemeColors {
        Themes.colors(for: themeSelected, custom: customThemes, systemIsDark: systemIsDark)
    }
}

/// A checkbox tap in a widget.
struct ToggleTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Check off a task"
    static let isDiscoverable = false

    @Parameter(title: "Task") var taskId: String
    @Parameter(title: "Checked") var checked: Bool

    init() {}

    init(taskId: String, checked: Bool) {
        self.taskId = taskId
        self.checked = checked
    }

    func perform() async throws -> some IntentResult {
        await WidgetDataSource.live().setChecked(checked, taskId: taskId)
        return .result()
    }
}

// MARK: Shared pieces

private enum WidgetType {
    static func regular(_ size: CGFloat) -> Font { .system(size: size) }
    static func semibold(_ size: CGFloat) -> Font { .system(size: size, weight: .semibold) }
}

private struct WidgetBackground: View {
    let theme: ThemeColors

    var body: some View {
        if theme.followsSystem {
            Rectangle().fill(.background)
        } else {
            theme.backgroundColor
        }
    }
}

private struct WidgetLabel: View {
    let text: String
    let emphasized: Bool

    var body: some View {
        Text(text.uppercased())
            .font(WidgetType.semibold(9.5))
            .tracking(0.7)
            .opacity(emphasized ? 0.9 : 0.4)
            .lineLimit(1)
    }
}

private struct WidgetTaskRow: View {
    let task: WidgetTask
    let theme: ThemeColors
    let fontSize: CGFloat
    let boxSize: CGFloat

    var body: some View {
        let highlight = theme.highlight(task.color)
        let ink = theme.rowTextColor(highlighted: highlight != nil)
        HStack(spacing: 5) {
            Button(intent: ToggleTaskIntent(taskId: task.id, checked: !task.checked)) {
                RoundedRectangle(cornerRadius: boxSize * 0.18)
                    .strokeBorder(ink, lineWidth: 0.9)
                    .overlay {
                        if task.checked {
                            Image(systemName: "checkmark")
                                .font(.system(size: boxSize * 0.6, weight: .semibold))
                                .foregroundStyle(ink)
                        }
                    }
                    .frame(width: boxSize, height: boxSize)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Text(task.text)
                .font(WidgetType.regular(fontSize))
                .foregroundStyle(ink.opacity(task.checked ? 0.45 : 1))
                .strikethrough(task.checked)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 2)
        .padding(.leading, (task.subtask ? boxSize + 3 : 0) + 4)
        .padding(.trailing, 4)
        .background(highlight ?? .clear, in: RoundedRectangle(cornerRadius: 4))
    }
}

// MARK: Day

struct DayWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "ru.nikitanova.oneweek.day", provider: WeekProvider()) { entry in
            DayWidgetView(entry: entry)
        }
        .configurationDisplayName("Day view")
        .description("Today's tasks. Check them off right here.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct DayWidgetView: View {
    let entry: WeekEntry
    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var colorScheme

    private var maxRows: Int {
        switch family {
        case .systemSmall: 5
        case .systemMedium: 5
        default: 14
        }
    }

    var body: some View {
        let theme = entry.snapshot.theme(systemIsDark: colorScheme == .dark)
        let day = entry.snapshot.day(containing: entry.date)
        let tasks = day?.tasks ?? []
        VStack(alignment: .leading, spacing: 5) {
            WidgetLabel(text: day.map { "\($0.name), \($0.dayOfMonth)" } ?? "today", emphasized: true)
            if tasks.isEmpty {
                Spacer(minLength: 0)
                Text("nothing planned")
                    .font(WidgetType.regular(13))
                    .opacity(0.45)
                Spacer(minLength: 0)
            } else {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(tasks.prefix(maxRows)) { task in
                        WidgetTaskRow(task: task, theme: theme, fontSize: 13, boxSize: 12)
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .foregroundStyle(theme.textColor)
        .containerBackground(for: .widget) { WidgetBackground(theme: theme) }
    }
}

// MARK: Week

struct WeekWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "ru.nikitanova.oneweek.week", provider: WeekProvider()) { entry in
            WeekWidgetView(entry: entry)
        }
        .configurationDisplayName("Week view")
        .description("The whole week at a glance.")
        .supportedFamilies([.systemLarge, .systemExtraLarge])
    }
}

struct WeekWidgetView: View {
    let entry: WeekEntry
    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var colorScheme

    private struct Cell: Identifiable {
        let id: String
        let title: String
        let isToday: Bool
        let tasks: [WidgetTask]
    }

    private var isWide: Bool { family == .systemExtraLarge }

    private var cells: [Cell] {
        let today = WeekCalendar.iso(entry.date)
        let days = entry.snapshot.days.map { day in
            Cell(id: day.date, title: "\(day.name.prefix(3)), \(day.dayOfMonth)", isToday: day.date == today, tasks: day.tasks)
        }
        return days + [Cell(id: "next", title: "next week", isToday: false, tasks: entry.snapshot.nextWeek)]
    }

    var body: some View {
        let theme = entry.snapshot.theme(systemIsDark: colorScheme == .dark)
        let perRow = isWide ? 4 : 2
        let rows = stride(from: 0, to: cells.count, by: perRow).map { Array(cells[$0..<min($0 + perRow, cells.count)]) }
        VStack(spacing: 0) {
            ForEach(rows.indices, id: \.self) { rowIndex in
                if rowIndex > 0 { theme.hairlineColor.frame(height: 0.5) }
                HStack(spacing: 0) {
                    ForEach(Array(rows[rowIndex].enumerated()), id: \.element.id) { index, cell in
                        if index > 0 { theme.hairlineColor.frame(width: 0.5) }
                        column(cell, theme: theme)
                    }
                }
                .frame(maxHeight: .infinity)
            }
        }
        .foregroundStyle(theme.textColor)
        .containerBackground(for: .widget) { WidgetBackground(theme: theme) }
    }

    private func column(_ cell: Cell, theme: ThemeColors) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            WidgetLabel(text: cell.title, emphasized: cell.isToday)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(cell.tasks.prefix(isWide ? 7 : 3)) { task in
                    WidgetTaskRow(task: task, theme: theme, fontSize: 11, boxSize: 10)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(5)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .clipped()
    }
}

private extension ThemeColors {
    var hairlineColor: Color { textColor.opacity(0.2) }
}
