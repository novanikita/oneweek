import Foundation

public struct WidgetTask: Codable, Hashable, Identifiable, Sendable {
    /// `tasks.id`: only saved rows reach a widget.
    public var id: String
    public var text: String
    public var checked: Bool
    public var subtask: Bool
    public var color: String?

    public init(id: String, text: String, checked: Bool, subtask: Bool, color: String?) {
        self.id = id
        self.text = text
        self.checked = checked
        self.subtask = subtask
        self.color = color
    }
}

public struct WidgetDay: Codable, Hashable, Identifiable, Sendable {
    public var name: String
    public var date: String
    public var dayOfMonth: Int
    public var tasks: [WidgetTask]
    public var id: String { date }

    public init(name: String, date: String, dayOfMonth: Int, tasks: [WidgetTask]) {
        self.name = name
        self.date = date
        self.dayOfMonth = dayOfMonth
        self.tasks = tasks
    }
}

/// What the widgets draw: this week in one workspace.
public struct WidgetSnapshot: Codable, Hashable, Sendable {
    public var weekMonday: String
    public var days: [WidgetDay]
    public var nextWeek: [WidgetTask]
    public var general: [WidgetTask]
    public var themeSelected: String?
    public var customThemes: [CustomTheme]

    public init(
        weekMonday: String, days: [WidgetDay], nextWeek: [WidgetTask], general: [WidgetTask],
        themeSelected: String?, customThemes: [CustomTheme]
    ) {
        self.weekMonday = weekMonday
        self.days = days
        self.nextWeek = nextWeek
        self.general = general
        self.themeSelected = themeSelected
        self.customThemes = customThemes
    }

    public func day(containing date: Date) -> WidgetDay? {
        let iso = WeekCalendar.iso(date)
        return days.first { $0.date == iso }
    }

    /// An empty week, for the gallery and for a signed-out widget.
    public static func empty(now: Date, themeSelected: String? = nil, customThemes: [CustomTheme] = []) -> WidgetSnapshot {
        build(lists: [:], now: now, themeSelected: themeSelected, customThemes: customThemes)
    }

    /// Lists are keyed by slot; hidden rows and unsaved or blank rows stay out.
    public static func build(
        lists: [Slot: [TaskItem]], now: Date, themeSelected: String?, customThemes: [CustomTheme]
    ) -> WidgetSnapshot {
        let monday = WeekCalendar.monday(of: now)
        func rows(_ slot: Slot) -> [WidgetTask] {
            (lists[slot] ?? []).compactMap { task in
                guard let dbId = task.dbId, !TaskList.isEmptyText(task.text) else { return nil }
                return WidgetTask(id: dbId, text: task.text, checked: task.checked, subtask: task.subtask, color: task.color)
            }
        }
        let days = Slot.days.enumerated().map { index, slot in
            let date = WeekCalendar.addingDays(index, to: monday)
            return WidgetDay(
                name: WeekCalendar.dayNames[index].lowercased(), date: WeekCalendar.iso(date),
                dayOfMonth: WeekCalendar.dayOfMonth(date), tasks: rows(slot)
            )
        }
        return WidgetSnapshot(
            weekMonday: WeekCalendar.iso(monday), days: days, nextWeek: rows(.nextWeek), general: rows(.general),
            themeSelected: themeSelected, customThemes: customThemes
        )
    }

    /// Group server rows of this week into ordered lists.
    public static func lists(from rows: [TaskRow], now: Date) -> [Slot: [TaskItem]] {
        var lists: [Slot: [TaskItem]] = [:]
        for slot in Slot.allCases {
            let address = WeekCalendar.address(of: slot, weekOffset: 0, now: now)
            var items = rows.filter { $0.address == address }.map { row in
                row.item { TaskList.normalizeText($0, in: slot) }
            }
            TaskList.normalizeSubtaskFlags(&items)
            lists[slot] = TaskList.settle(items, in: slot)
        }
        return lists
    }

    /// Same row order after a checkbox in a widget.
    public mutating func setChecked(_ checked: Bool, taskId: String) {
        for index in days.indices { days[index].tasks = Self.toggled(days[index].tasks, taskId, checked) }
        nextWeek = Self.toggled(nextWeek, taskId, checked)
        general = Self.toggled(general, taskId, checked)
    }

    private static func toggled(_ tasks: [WidgetTask], _ id: String, _ checked: Bool) -> [WidgetTask] {
        guard tasks.contains(where: { $0.id == id }) else { return tasks }
        var items = tasks.map {
            TaskItem(dbId: $0.id, text: $0.text, checked: $0.id == id ? checked : $0.checked, subtask: $0.subtask, color: $0.color)
        }
        items = TaskList.partitionUncheckedBeforeChecked(items)
        return items.map { WidgetTask(id: $0.dbId!, text: $0.text, checked: $0.checked, subtask: $0.subtask, color: $0.color) }
    }
}

/// The widgets' side of the data: their own server reads, and checkbox taps.
public struct WidgetDataSource: Sendable {
    private let backend: Backend
    private let local: LocalStore

    public init(backend: Backend, local: LocalStore) {
        self.backend = backend
        self.local = local
    }

    public static func live() -> WidgetDataSource {
        let root = SharedContainer.url
        return WidgetDataSource(backend: SupabaseBackend(vault: SessionVault(directory: root)), local: LocalStore(root: root))
    }

    /// Fresh from the server when possible, else the last copy; never another week's.
    public func load(now: Date = Date()) async -> WidgetSnapshot {
        let state = local.readDeviceState()
        let currentMonday = WeekCalendar.iso(WeekCalendar.monday(of: now))
        guard await backend.currentSession() != nil else {
            return .empty(now: now, themeSelected: state.themeSelected, customThemes: state.customThemes)
        }
        await sendPendingToggles()
        if let fresh = try? await fetch(now: now, state: state) {
            local.writeSnapshot(fresh)
            return fresh
        }
        if let cached = local.readSnapshot(), cached.weekMonday == currentMonday { return cached }
        return .empty(now: now, themeSelected: state.themeSelected, customThemes: state.customThemes)
    }

    private func fetch(now: Date, state: DeviceState) async throws -> WidgetSnapshot {
        guard let session = await backend.currentSession() else { throw BackendError.sessionExpired }
        let workspaces = try await backend.fetchWorkspaces(userId: session.userId)
        let active = state.activeWorkspaceByUser[session.userId]
        guard let workspace = workspaces.first(where: { $0.id == active })
            ?? workspaces.first(where: \.isDefault) ?? workspaces.first
        else { throw BackendError.sessionExpired }

        let monday = WeekCalendar.monday(of: now)
        let rows = try await backend.fetchRows(
            userId: session.userId, workspaceId: workspace.id,
            from: WeekCalendar.iso(monday),
            to: WeekCalendar.iso(WeekCalendar.addingDays(6, to: monday)),
            weekLists: [WeekCalendar.iso(monday), WeekCalendar.iso(WeekCalendar.monday(of: now, offset: 1))]
        )
        return .build(
            lists: WidgetSnapshot.lists(from: rows, now: now), now: now,
            themeSelected: state.themeSelected, customThemes: state.customThemes
        )
    }

    /// The tap shows at once; offline it is queued and sent with the next refresh.
    public func setChecked(_ checked: Bool, taskId: String) async {
        if var snapshot = local.readSnapshot() {
            snapshot.setChecked(checked, taskId: taskId)
            local.writeSnapshot(snapshot)
        }
        guard let session = await backend.currentSession() else { return }
        do {
            try await backend.setCompleted(id: taskId, completed: checked, userId: session.userId)
        } catch {
            var pending = local.readPendingToggles()
            pending[taskId] = checked
            local.writePendingToggles(pending)
        }
    }

    public func sendPendingToggles() async {
        guard let session = await backend.currentSession() else { return }
        var pending = local.readPendingToggles()
        guard !pending.isEmpty else { return }
        for (id, checked) in pending {
            do {
                try await backend.setCompleted(id: id, completed: checked, userId: session.userId)
                pending[id] = nil
            } catch BackendError.network {
                break
            } catch {
                // The row is gone or rejected: retrying won't help.
                pending[id] = nil
            }
        }
        local.writePendingToggles(pending)
    }
}
