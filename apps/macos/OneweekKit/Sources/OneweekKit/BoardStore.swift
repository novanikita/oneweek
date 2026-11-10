import Foundation
import Observation

/// The board: what is on screen, every edit, and keeping both in step with the server.
///
/// Local state is the truth for the screen. Edits apply at once and are saved
/// in the background; offline they wait on disk. A list being edited is never
/// replaced from the server: its re-read waits until the user leaves the row.
/// A quiet hint (undo) or a notice, styled as on the web.
public enum ToastKind: Sendable {
    case hint, notice
}

@MainActor
@Observable
public final class BoardStore {
    public enum Phase: Equatable, Sendable { case loading, signedOut, ready }

    public struct FocusRequest: Equatable, Sendable {
        public var rowId: UUID
        public var token: Int
    }

    private struct Located {
        var slot: Slot
        var index: Int
    }

    private struct UndoEntry {
        var address: ListAddress
        var workspaceId: String?
        var position: Int
        var rows: [TaskItem]
    }

    public private(set) var phase: Phase = .loading
    public private(set) var email: String?
    public private(set) var workspaces: [Workspace] = []
    public private(set) var activeWorkspaceId: String?
    public private(set) var weekOffset = 0
    public private(set) var lists: [Slot: [TaskItem]] = [:]
    /// The row with the caret in it.
    public private(set) var activeRowId: UUID?
    public private(set) var draggingRowId: UUID?
    public private(set) var isOffline = false
    public private(set) var canMoveRemaining = false
    public private(set) var toast: String?
    public private(set) var toastKind = ToastKind.notice
    public private(set) var today: Date
    public private(set) var focusRequest: FocusRequest?
    public private(set) var themeSelected: String?
    public private(set) var customThemes: [CustomTheme] = []

    /// Set by the app to reload the widgets after a new snapshot lands.
    @ObservationIgnored public var onSnapshotWritten: (() -> Void)?

    @ObservationIgnored private let backend: Backend
    @ObservationIgnored private let local: LocalStore
    @ObservationIgnored private let clock: () -> Date
    @ObservationIgnored private let retryInterval: Duration
    @ObservationIgnored private let saveDelay: Duration

    @ObservationIgnored private var userId: String?
    @ObservationIgnored private var device: DeviceState
    @ObservationIgnored private var pendingDeletes: [String] = []
    @ObservationIgnored private var undoStack: [UndoEntry] = []
    @ObservationIgnored private var positionsDirty = Set<Slot>()

    @ObservationIgnored private var loadGeneration = 0
    @ObservationIgnored private var slotEdits: [Slot: Int] = [:]
    @ObservationIgnored private var reloadWhenIdle = false
    @ObservationIgnored private var lastRefresh = Date.distantPast
    @ObservationIgnored private var focusToken = 0

    @ObservationIgnored private var flushTask: Task<Void, Never>?
    @ObservationIgnored private var flushAgain = false
    @ObservationIgnored private var flushTimer: Task<Void, Never>?
    @ObservationIgnored private var cacheTimer: Task<Void, Never>?
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var toastTimer: Task<Void, Never>?
    @ObservationIgnored private var midnightTask: Task<Void, Never>?
    @ObservationIgnored private var widgetTimer: Task<Void, Never>?
    /// What each list file last held, so unchanged lists aren't written again.
    @ObservationIgnored private var lastWritten: [String: [TaskItem]] = [:]
    @ObservationIgnored private var lastSnapshot: WidgetSnapshot?

    public init(
        backend: Backend,
        local: LocalStore,
        clock: @escaping () -> Date = Date.init,
        retryInterval: Duration = .seconds(15),
        saveDelay: Duration = .milliseconds(1200)
    ) {
        self.backend = backend
        self.local = local
        self.clock = clock
        self.retryInterval = retryInterval
        self.saveDelay = saveDelay
        device = local.readDeviceState()
        today = clock()
        themeSelected = device.themeSelected
        customThemes = device.customThemes
    }

    // MARK: Reading

    public var hasUnsyncedEdits: Bool {
        !pendingDeletes.isEmpty || lists.values.contains { $0.contains(where: \.dirty) }
    }

    public var activeWorkspace: Workspace? {
        workspaces.first { $0.id == activeWorkspaceId }
    }

    public func date(of slot: Slot) -> Date? {
        WeekCalendar.date(of: slot, weekOffset: weekOffset, now: today)
    }

    public func isToday(_ slot: Slot) -> Bool {
        guard weekOffset == 0, let date = date(of: slot) else { return false }
        return WeekCalendar.isSameDay(date, today)
    }

    private func address(of slot: Slot) -> ListAddress {
        WeekCalendar.address(of: slot, weekOffset: weekOffset, now: today)
    }

    private func tasks(_ slot: Slot) -> [TaskItem] {
        lists[slot] ?? []
    }

    private func locate(_ id: UUID) -> Located? {
        for slot in Slot.allCases {
            if let index = tasks(slot).firstIndex(where: { $0.id == id }) {
                return Located(slot: slot, index: index)
            }
        }
        return nil
    }

    public func slot(of id: UUID) -> Slot? {
        locate(id)?.slot
    }

    /// Rows to show: a collapsed parent hides its subtasks.
    public func visibleRows(_ tasks: [TaskItem]) -> [TaskItem] {
        var parentCollapsed = false
        return tasks.filter { task in
            if !task.subtask {
                parentCollapsed = task.collapsed
                return true
            }
            return !parentCollapsed
        }
    }

    /// The main-thing block of the week list, and everything else.
    public func splitGeneral() -> (main: [TaskItem], rest: [TaskItem]) {
        let all = tasks(.general)
        guard let span = TaskList.mainThingSpan(all) else { return ([], all) }
        return (Array(all[span.start..<span.end]), Array(all[..<span.start] + all[span.end...]))
    }

    public func row(_ id: UUID) -> TaskItem? {
        locate(id).map { tasks($0.slot)[$0.index] }
    }

    public func text(of id: UUID) -> String? {
        locate(id).map { tasks($0.slot)[$0.index].text }
    }

    public func subtaskCount(of id: UUID) -> Int {
        guard let at = locate(id) else { return 0 }
        return TaskList.subtaskCount(tasks(at.slot), at: at.index)
    }

    // MARK: Start, sign in, sign out

    public func start() async {
        scheduleMidnight()
        guard let session = await backend.currentSession() else {
            phase = .signedOut
            return
        }
        await adopt(session)
    }

    private func adopt(_ session: Session) async {
        userId = session.userId
        email = session.email
        pendingDeletes = local.readPendingDeletes(userId: session.userId)
        local.prune(userId: session.userId, olderThan: WeekCalendar.iso(WeekCalendar.monday(of: today, offset: -8)))
        if let cached = local.readWorkspaces(userId: session.userId), !cached.isEmpty {
            workspaces = cached
            activeWorkspaceId = pickActiveWorkspace()
        }
        phase = .ready
        if activeWorkspaceId != nil { await reloadWeek() }
        await refreshWorkspaces()
        await refreshSettings()
        await refreshMoveRemaining()
    }

    /// Returns an error to show, or nil on success.
    public func signIn(email: String, password: String) async -> String? {
        do {
            await adopt(try await backend.signIn(email: email, password: password))
            return nil
        } catch BackendError.invalidCredentials(let message) {
            return message
        } catch {
            return "No connection. Try again in a moment."
        }
    }

    public func signOut() async {
        await flushNow()
        if let userId { local.wipe(userId: userId) }
        await backend.signOut()
        clearSignedInState()
    }

    private func clearSignedInState() {
        flushTimer?.cancel()
        cacheTimer?.cancel()
        pollTask?.cancel()
        pollTask = nil
        userId = nil
        email = nil
        workspaces = []
        activeWorkspaceId = nil
        lists = [:]
        activeRowId = nil
        pendingDeletes = []
        undoStack = []
        positionsDirty = []
        isOffline = false
        canMoveRemaining = false
        weekOffset = 0
        phase = .signedOut
        lastWritten = [:]
        lastSnapshot = nil
        local.writeSnapshot(nil)
        onSnapshotWritten?()
    }

    // MARK: Workspaces

    private func pickActiveWorkspace() -> String? {
        if let userId, let stored = device.activeWorkspaceByUser[userId], workspaces.contains(where: { $0.id == stored }) {
            return stored
        }
        return workspaces.first(where: \.isDefault)?.id ?? workspaces.first?.id
    }

    private func rememberActiveWorkspace() {
        guard let userId else { return }
        device.activeWorkspaceByUser[userId] = activeWorkspaceId
        local.writeDeviceState(device)
    }

    private func refreshWorkspaces() async {
        guard let userId else { return }
        do {
            var fetched = try await backend.fetchWorkspaces(userId: userId)
            if fetched.isEmpty {
                // Two devices may race on the first sign-in: a unique index rejects the second.
                _ = try? await backend.createWorkspace(userId: userId, name: "main", position: 0, isDefault: true)
                fetched = try await backend.fetchWorkspaces(userId: userId)
            }
            markSuccess()
            let previous = activeWorkspaceId
            workspaces = fetched
            local.writeWorkspaces(fetched, userId: userId)
            activeWorkspaceId = pickActiveWorkspace()
            rememberActiveWorkspace()
            if activeWorkspaceId != previous { await reloadWeek() }
        } catch {
            handle(error)
        }
    }

    public func selectWorkspace(_ id: String) async {
        guard id != activeWorkspaceId, workspaces.contains(where: { $0.id == id }) else { return }
        await flushNow()
        activeWorkspaceId = id
        rememberActiveWorkspace()
        await reloadWeek()
        await refreshMoveRemaining()
    }

    public func createWorkspace(named name: String) async {
        guard let userId else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let used = Set(workspaces.map { $0.name.lowercased() })
        let fallback = (1...).lazy.map { "workspace \($0)" }.first { !used.contains($0) }!
        let position = (workspaces.map(\.position).max() ?? -1) + 1
        do {
            let created = try await backend.createWorkspace(
                userId: userId, name: trimmed.isEmpty ? fallback : trimmed, position: position, isDefault: false
            )
            workspaces.append(created)
            local.writeWorkspaces(workspaces, userId: userId)
            await selectWorkspace(created.id)
        } catch {
            handle(error)
        }
    }

    public func renameWorkspace(_ id: String, to name: String) async {
        guard let userId, let index = workspaces.firstIndex(where: { $0.id == id }) else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != workspaces[index].name else { return }
        let previous = workspaces[index].name
        workspaces[index].name = trimmed
        do {
            try await backend.renameWorkspace(id: id, name: trimmed, userId: userId)
            local.writeWorkspaces(workspaces, userId: userId)
        } catch {
            if let again = workspaces.firstIndex(where: { $0.id == id }) { workspaces[again].name = previous }
            handle(error)
        }
    }

    public func deleteWorkspace(_ id: String) async {
        guard let userId, workspaces.count > 1,
              let workspace = workspaces.first(where: { $0.id == id }), !workspace.isDefault else { return }
        do {
            try await backend.deleteWorkspace(id: id, userId: userId)
        } catch {
            handle(error)
            return
        }
        workspaces.removeAll { $0.id == id }
        local.writeWorkspaces(workspaces, userId: userId)
        if activeWorkspaceId == id {
            activeWorkspaceId = pickActiveWorkspace()
            rememberActiveWorkspace()
            await reloadWeek()
        }
    }

    // MARK: Loading

    public func setWeekOffset(_ offset: Int) async {
        guard offset != weekOffset else { return }
        await flushNow()
        weekOffset = offset
        await reloadWeek()
        await refreshMoveRemaining()
    }

    /// Mid-action in this list: replacing it now would pull the row away.
    private func isBusy(_ slot: Slot) -> Bool {
        if draggingRowId != nil { return true }
        guard let activeRowId else { return false }
        return tasks(slot).contains { $0.id == activeRowId }
    }

    private func bumpEdits(_ slot: Slot) {
        slotEdits[slot, default: 0] += 1
    }

    /// A week or workspace switch: paint the cache, then read the server.
    public func reloadWeek() async {
        guard let userId, let workspaceId = activeWorkspaceId else {
            lists = [:]
            return
        }
        var painted = Set<Slot>()
        for slot in Slot.allCases {
            if var cached = local.readList(userId: userId, workspaceId: workspaceId, address: address(of: slot)) {
                TaskList.normalizeSubtaskFlags(&cached)
                lists[slot] = TaskList.settle(cached, in: slot)
                painted.insert(slot)
            } else {
                lists[slot] = []
            }
        }
        publishSnapshot()
        await readServer(userId: userId, workspaceId: workspaceId, painted: painted)
    }

    /// Refresh what is already on screen (network retry, coming back to the app).
    public func refresh() async {
        guard let userId, let workspaceId = activeWorkspaceId else { return }
        await readServer(userId: userId, workspaceId: workspaceId, painted: Set(Slot.allCases))
    }

    private func readServer(userId: String, workspaceId: String, painted: Set<Slot>) async {
        reloadWhenIdle = false
        loadGeneration += 1
        let generation = loadGeneration
        let editsAtRequest = slotEdits
        let week = weekOffset
        let addresses = Dictionary(uniqueKeysWithValues: Slot.allCases.map { ($0, address(of: $0)) })

        let rows: [TaskRow]
        do {
            let days = Slot.days.compactMap { addresses[$0]?.date }
            rows = try await backend.fetchRows(
                userId: userId, workspaceId: workspaceId, from: days.first!, to: days.last!,
                weekLists: [addresses[.general]!.date, addresses[.nextWeek]!.date]
            )
        } catch {
            handle(error)
            return
        }
        markSuccess()
        // The user may have switched week or workspace while this was in flight.
        guard generation == loadGeneration, week == weekOffset, workspaceId == activeWorkspaceId else { return }

        for slot in Slot.allCases {
            // Typing started meanwhile, or the answer predates a local change:
            // read this list again once the user is done. A list with nothing
            // on screen yet is worth merging around the active row.
            let editedMeanwhile = slotEdits[slot, default: 0] != editsAtRequest[slot, default: 0]
            if painted.contains(slot), isBusy(slot) || editedMeanwhile {
                reloadWhenIdle = true
                continue
            }
            let server = rows.filter { $0.address == addresses[slot] }.map { row in
                row.item { TaskList.normalizeText($0, in: slot) }
            }
            let current = tasks(slot)
            var merged = TaskList.merge(server: server, local: current) { TaskList.normalizeText($0, in: slot) }
            // The merge skips blank drafts; keep the one the user is sitting in.
            if let active = current.first(where: { $0.id == activeRowId }), !merged.contains(where: { $0.id == active.id }) {
                merged.append(active)
            }
            let fixed = TaskList.normalizeSubtaskFlags(&merged)
            for index in merged.indices where fixed.contains(merged[index].id) { merged[index].dirty = true }
            lists[slot] = TaskList.settle(merged, in: slot)
        }
        lastRefresh = clock()
        writeCacheNow()
        if hasDirtyRows { startFlush() }
        runDeferredReload()
    }

    private func runDeferredReload() {
        guard reloadWhenIdle, !Slot.allCases.contains(where: isBusy) else { return }
        reloadWhenIdle = false
        Task {
            // Saves first, so the re-read can't bring back the text just replaced.
            await flushNow()
            await refresh()
        }
    }

    public func appBecameActive() async {
        today = clock()
        guard phase == .ready, clock().timeIntervalSince(lastRefresh) >= 15 else { return }
        lastRefresh = clock()
        await refresh()
        await refreshSettings()
        await refreshMoveRemaining()
    }

    public func appWillResignActive() async {
        writeCacheNow()
        await flushNow()
        local.finishWrites()
    }

    private func scheduleMidnight() {
        midnightTask?.cancel()
        let delay = WeekCalendar.startOfNextDay(after: clock()).timeIntervalSince(clock()) + 1
        midnightTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            let weekChanged = WeekCalendar.monday(of: self.today) != WeekCalendar.monday(of: self.clock())
            self.today = self.clock()
            if weekChanged, self.phase == .ready {
                await self.flushNow()
                await self.reloadWeek()
                await self.refreshMoveRemaining()
            }
            self.scheduleMidnight()
        }
    }

    // MARK: Editing a row

    public func rowBeganEditing(_ id: UUID) {
        activeRowId = id
    }

    /// The caret left the row (not the app switching away: the row keeps it then).
    public func rowEndedEditing(_ id: UUID) {
        if activeRowId == id { activeRowId = nil }
        commit(id)
        runDeferredReload()
    }

    public func focusHandled(_ token: Int) {
        if focusRequest?.token == token { focusRequest = nil }
    }

    private func requestFocus(_ id: UUID) {
        focusToken += 1
        focusRequest = FocusRequest(rowId: id, token: focusToken)
    }

    public func updateText(_ id: UUID, _ text: String) {
        guard let at = locate(id), tasks(at.slot)[at.index].text != text else { return }
        lists[at.slot]![at.index].text = text
        lists[at.slot]![at.index].dirty = true
        bumpEdits(at.slot)
        scheduleFlush()
        scheduleCacheWrite()
    }

    /// Leaving a row: tidy its text, drop it if blank, re-sort the list.
    private func commit(_ id: UUID) {
        guard let at = locate(id) else { return }
        var list = tasks(at.slot)
        let normalized = TaskList.normalizeText(list[at.index].text, in: at.slot)
        if normalized != list[at.index].text {
            list[at.index].text = normalized
            list[at.index].dirty = true
        }
        if TaskList.isEmptyText(normalized) {
            if list[at.index].dbId == nil {
                list.remove(at: at.index)
                TaskList.normalizeSubtaskFlags(&list)
                lists[at.slot] = list
                bumpEdits(at.slot)
                scheduleCacheWrite()
                return
            }
            if !TaskList.hasSubtasks(list, at: at.index) {
                lists[at.slot] = list
                delete(id)
                return
            }
        }
        lists[at.slot] = TaskList.settle(list, in: at.slot)
        didChange(at.slot, flushSoon: true)
    }

    /// After a structural change: reorder on the server, cache, and save.
    private func didChange(_ slot: Slot, flushSoon: Bool = false) {
        bumpEdits(slot)
        positionsDirty.insert(slot)
        scheduleCacheWrite()
        if flushSoon { startFlush() } else { scheduleFlush() }
    }

    /// Enter continues at the same level; on a blank subtask it exits to a new
    /// main; on a blank main it leaves the field (returns false).
    public func enter(_ id: UUID, text rawText: String) -> Bool {
        guard let at = locate(id) else { return false }
        var list = tasks(at.slot)
        let text = TaskList.normalizeText(rawText, in: at.slot)
        if list[at.index].text != text {
            list[at.index].text = text
            list[at.index].dirty = true
        }
        let wasSubtask = list[at.index].subtask

        if TaskList.isEmptyText(text) {
            guard wasSubtask else {
                lists[at.slot] = list
                return false
            }
            let parent = TaskList.parentIndex(list, ofSubtaskAt: at.index).map { list[$0].id }
            lists[at.slot] = list
            discard(list[at.index], in: at.slot, position: at.index)
            list.remove(at: at.index)
            let fresh = TaskItem()
            list.insert(fresh, at: TaskList.insertIndexAfterExitingSubtask(list, parent: parent))
            TaskList.normalizeSubtaskFlags(&list)
            lists[at.slot] = TaskList.settle(list, in: at.slot)
            didChange(at.slot)
            requestFocus(fresh.id)
            return true
        }

        if wasSubtask, let parent = TaskList.parentIndex(list, ofSubtaskAt: at.index) {
            list[parent].collapsed = false
        }
        let fresh = TaskItem(subtask: wasSubtask)
        list.insert(fresh, at: TaskList.insertIndexAfterEnter(list, at: at.index))
        TaskList.normalizeSubtaskFlags(&list)
        lists[at.slot] = TaskList.settle(list, in: at.slot)
        didChange(at.slot, flushSoon: true)
        requestFocus(fresh.id)
        return true
    }

    /// Empty-area click: reuse an unsaved blank draft or add one, then focus it.
    public func beginNewTask(in slot: Slot) {
        var list = tasks(slot)
        let insertAt = TaskList.insertIndexForNewMain(list)
        if let draft = list[..<insertAt].last(where: { !$0.checked && !$0.subtask && $0.dbId == nil && TaskList.isEmptyText($0.text) }) {
            requestFocus(draft.id)
            return
        }
        let fresh = TaskItem()
        list.insert(fresh, at: insertAt)
        lists[slot] = list
        bumpEdits(slot)
        requestFocus(fresh.id)
    }

    public func indent(_ id: UUID, outdent: Bool? = nil) {
        guard let at = locate(id) else { return }
        var list = tasks(at.slot)
        let willOutdent = outdent ?? list[at.index].subtask
        if willOutdent, !list[at.index].subtask { return }
        guard TaskList.applyIndent(&list, at: at.index, outdent: willOutdent) else { return }
        TaskList.normalizeSubtaskFlags(&list)
        if let index = list.firstIndex(where: { $0.id == id }), !TaskList.isEmptyText(list[index].text) {
            list[index].dirty = true
        }
        lists[at.slot] = TaskList.partition(list, in: at.slot)
        didChange(at.slot)
    }

    public func toggleChecked(_ id: UUID) {
        guard let at = locate(id) else { return }
        var list = tasks(at.slot)
        list[at.index].checked.toggle()
        if !TaskList.isEmptyText(list[at.index].text) { list[at.index].dirty = true }
        lists[at.slot] = TaskList.togglePartition(list, in: at.slot)
        didChange(at.slot, flushSoon: true)
    }

    public func setColor(_ id: UUID, _ color: String?) {
        guard let at = locate(id) else { return }
        let normalized = TaskColors.normalize(color)
        guard tasks(at.slot)[at.index].color != normalized else { return }
        lists[at.slot]![at.index].color = normalized
        if !TaskList.isEmptyText(tasks(at.slot)[at.index].text) { lists[at.slot]![at.index].dirty = true }
        bumpEdits(at.slot)
        scheduleCacheWrite()
        startFlush()
    }

    public func toggleCollapsed(_ id: UUID) {
        guard let at = locate(id) else { return }
        lists[at.slot]![at.index].collapsed.toggle()
        scheduleCacheWrite()
    }

    /// Multi-line paste: first line here, the rest become siblings.
    public func paste(_ id: UUID, lines: [String]) {
        guard let at = locate(id), let first = lines.first else { return }
        var list = tasks(at.slot)
        list[at.index].text = TaskList.normalizeText(first, in: at.slot)
        list[at.index].dirty = !TaskList.isEmptyText(list[at.index].text)
        let subtask = list[at.index].subtask
        let extra = lines.dropFirst().filter { !TaskList.isEmptyText($0) }.map {
            TaskItem(text: TaskList.normalizeText($0, in: at.slot), subtask: subtask, dirty: true)
        }
        list.insert(contentsOf: extra, at: TaskList.insertIndexAfterEnter(list, at: at.index))
        TaskList.normalizeSubtaskFlags(&list)
        lists[at.slot] = TaskList.settle(list, in: at.slot)
        didChange(at.slot, flushSoon: true)
        requestFocus(extra.last?.id ?? id)
    }

    // MARK: Deleting

    private func discard(_ row: TaskItem, in slot: Slot, position: Int) {
        guard row.dbId != nil else { return }
        pushUndo(rows: [row], slot: slot, position: position)
        queueDeletes([row])
        showToast("Deleted. Press ⌘Z to undo.", kind: .hint)
    }

    private func pushUndo(rows: [TaskItem], slot: Slot, position: Int) {
        undoStack.append(UndoEntry(address: address(of: slot), workspaceId: activeWorkspaceId, position: position, rows: rows))
        if undoStack.count > 50 { undoStack.removeFirst() }
    }

    private func queueDeletes(_ rows: [TaskItem]) {
        guard let userId else { return }
        pendingDeletes.append(contentsOf: rows.compactMap(\.dbId))
        local.writePendingDeletes(pendingDeletes, userId: userId)
        startFlush()
    }

    public func delete(_ id: UUID) {
        guard let at = locate(id) else { return }
        var list = tasks(at.slot)
        let span = TaskList.subtreeSpan(list, at: at.index)
        let removed = Array(list[span.start..<span.end])
        if removed.contains(where: { $0.dbId != nil || !TaskList.isEmptyText($0.text) }) {
            pushUndo(rows: removed, slot: at.slot, position: span.start)
            showToast("Deleted. Press ⌘Z to undo.", kind: .hint)
        }
        list.removeSubrange(span.start..<span.end)
        lists[at.slot] = TaskList.settle(list, in: at.slot)
        if removed.contains(where: { $0.id == activeRowId }) { activeRowId = nil }
        queueDeletes(removed)
        didChange(at.slot)
    }

    /// Restore the last delete that still belongs to the visible week and workspace.
    public func undoDelete() {
        guard let userId else { return }
        while let entry = undoStack.popLast() {
            guard entry.workspaceId == activeWorkspaceId,
                  let slot = Slot.allCases.first(where: { address(of: $0) == entry.address }) else { continue }
            var list = tasks(slot)
            var insertAt = min(max(entry.position, 0), list.count)
            var first: UUID?
            for var row in entry.rows {
                if let dbId = row.dbId, let index = pendingDeletes.firstIndex(of: dbId) {
                    // The delete hasn't reached the server: cancel it.
                    pendingDeletes.remove(at: index)
                } else {
                    row.dbId = nil
                    row.dirty = !TaskList.isEmptyText(row.text)
                }
                list.insert(row, at: insertAt)
                insertAt += 1
                first = first ?? row.id
            }
            TaskList.normalizeSubtaskFlags(&list)
            lists[slot] = TaskList.settle(list, in: slot)
            local.writePendingDeletes(pendingDeletes, userId: userId)
            didChange(slot, flushSoon: true)
            if let first { requestFocus(first) }
            return
        }
    }

    // MARK: Main thing

    public func toggleMainThing(_ id: UUID) {
        guard let at = locate(id) else { return }
        guard at.slot == .general else {
            moveRow(id, to: .general, before: nil, intoMain: true)
            return
        }
        var list = tasks(.general)
        let index = list[at.index].subtask ? (TaskList.parentIndex(list, ofSubtaskAt: at.index) ?? at.index) : at.index
        let current = TaskList.mainThingIndex(list)
        if current == index {
            list[index].isMain = false
            list[index].dirty = true
        } else {
            promote(&list, index: index)
        }
        lists[.general] = TaskList.settle(list, in: .general)
        didChange(.general, flushSoon: true)
        keepCaret(on: list[index].id)
    }

    /// A row that changes list or region gets a new field: the caret follows it.
    private func keepCaret(on id: UUID) {
        if activeRowId == id { requestFocus(id) }
    }

    private func promote(_ list: inout [TaskItem], index: Int) {
        if let current = TaskList.mainThingIndex(list) {
            list[current].isMain = false
            list[current].dirty = true
            showToast("There can only be one main thing :)")
        }
        list[index].isMain = true
        list[index].subtask = false
        list[index].dirty = true
    }

    // MARK: Moving

    public func beginDragging(_ id: UUID) {
        draggingRowId = id
    }

    public func endDragging() {
        draggingRowId = nil
        runDeferredReload()
    }

    /// Finish a drag: within a list, across lists, into or out of the main thing.
    /// `before` nil means the end of the list.
    public func moveRow(_ id: UUID, to target: Slot, before: UUID?, intoMain: Bool) {
        guard let from = locate(id) else { return }
        if from.slot == target {
            moveWithinList(id, slot: target, before: before, intoMain: intoMain)
        } else {
            moveAcrossLists(id, from: from, to: target, before: before, intoMain: intoMain)
        }
    }

    private func moveWithinList(_ id: UUID, slot: Slot, before: UUID?, intoMain: Bool) {
        var list = tasks(slot)
        guard let index = list.firstIndex(where: { $0.id == id }) else { return }

        if slot.hasMainThing {
            let wasInMain = TaskList.isInMainThingSpan(list, index: index)
            if intoMain, !wasInMain {
                promote(&list, index: index)
                lists[slot] = TaskList.settle(list, in: slot)
                didChange(slot, flushSoon: true)
                keepCaret(on: id)
                return
            }
            if !intoMain, wasInMain {
                if list[index].subtask {
                    list[index].subtask = false
                } else {
                    list[index].isMain = false
                }
                list[index].dirty = true
            }
        }

        if let before, let target = list.firstIndex(where: { $0.id == before }) {
            if list[target].subtask, !list[index].subtask, let parent = TaskList.parentIndex(list, ofSubtaskAt: target) {
                // A main can't land inside another group: place it after that group.
                let last = TaskList.indexAfterSubtree(list, of: parent) - 1
                TaskList.reorderSubtree(&list, from: index, to: last, before: false)
            } else {
                TaskList.reorderSubtree(&list, from: index, to: target, before: true)
            }
        } else {
            TaskList.reorderSubtreeToEnd(&list, from: index)
        }
        TaskList.normalizeSubtaskFlags(&list)
        lists[slot] = TaskList.partition(list, in: slot)
        didChange(slot, flushSoon: true)
        keepCaret(on: id)
    }

    private func moveAcrossLists(_ id: UUID, from: Located, to target: Slot, before: UUID?, intoMain: Bool) {
        var source = tasks(from.slot)
        let span = TaskList.subtreeSpan(source, at: from.index)
        var block = Array(source[span.start..<span.end])
        source.removeSubrange(span.start..<span.end)
        TaskList.normalizeSubtaskFlags(&source)
        lists[from.slot] = TaskList.settle(source, in: from.slot)
        didChange(from.slot)

        for index in block.indices {
            block[index].text = TaskList.normalizeText(block[index].text, in: target)
            block[index].isMain = false
            block[index].dirty = true
            block[index].needsRelocate = true
        }

        var list = tasks(target)
        var insertAt = TaskList.insertIndexForNewMain(list)
        if let before, let index = list.firstIndex(where: { $0.id == before }) {
            insertAt = index
            if list[index].subtask, !block[0].subtask, let parent = TaskList.parentIndex(list, ofSubtaskAt: index) {
                insertAt = TaskList.indexAfterSubtree(list, of: parent)
            }
        }
        if intoMain, target.hasMainThing {
            if let current = TaskList.mainThingIndex(list) {
                list[current].isMain = false
                list[current].dirty = true
                showToast("There can only be one main thing :)")
            }
            block[0].isMain = true
            block[0].subtask = false
            insertAt = 0
        }
        list.insert(contentsOf: block, at: insertAt)
        TaskList.normalizeSubtaskFlags(&list)
        lists[target] = TaskList.settle(list, in: target)
        didChange(target, flushSoon: true)
        keepCaret(on: id)
    }

    // MARK: Move remaining tasks

    private func moveRemainingKey(workspaceId: String) -> String {
        "\(userId ?? "")-\(address(of: .general).date)-\(workspaceId)"
    }

    /// Last week's unfinished rows not yet on this week's list; nil on error.
    private func rowsToCopy(workspaceId: String) async -> [TaskList.CarryRow]? {
        guard let userId else { return nil }
        let monday = WeekCalendar.monday(of: today, offset: -1)
        let mondayIso = WeekCalendar.iso(monday)
        let rows: [TaskRow]
        do {
            rows = try await backend.fetchRows(
                userId: userId, workspaceId: workspaceId, from: mondayIso,
                to: WeekCalendar.iso(WeekCalendar.addingDays(6, to: monday)), weekLists: [mondayIso]
            )
        } catch {
            handle(error)
            return nil
        }
        markSuccess()
        func carry(_ row: TaskRow) -> TaskList.CarryRow {
            TaskList.CarryRow(content: row.content, isSubtask: row.isSubtask, color: row.color, completed: row.completed)
        }
        let weekList = rows.filter { $0.type == "general" }.map(carry)
        let dates = Array(Set(rows.filter { $0.type == "daily" }.map(\.date))).sorted()
        let days = dates.map { date in rows.filter { $0.type == "daily" && $0.date == date }.map(carry) }
        let current = tasks(.general).map { TaskList.CarryRow(content: $0.text, isSubtask: $0.subtask, color: $0.color) }
        return TaskList.carryForward(lists: [weekList] + days, current: current)
    }

    public func refreshMoveRemaining() async {
        guard weekOffset == 0, let workspaceId = activeWorkspaceId,
              !device.moveRemainingDone.contains(moveRemainingKey(workspaceId: workspaceId)) else {
            canMoveRemaining = false
            return
        }
        canMoveRemaining = !((await rowsToCopy(workspaceId: workspaceId)) ?? []).isEmpty
    }

    /// A copy, not a move: last week stays as it was.
    public func moveRemaining() async {
        guard weekOffset == 0, let userId, let workspaceId = activeWorkspaceId else { return }
        await flushNow()
        guard let toCopy = await rowsToCopy(workspaceId: workspaceId), !toCopy.isEmpty else { return }
        let address = address(of: .general)
        let base = tasks(.general).count
        let rows = toCopy.enumerated().map { offset, row in
            TaskRow(
                content: row.content, isSubtask: row.isSubtask, color: row.color,
                position: base + offset, type: "general", date: address.date
            )
        }
        do {
            let created = try await backend.insertTasks(rows, userId: userId, workspaceId: workspaceId)
            markSuccess()
            device.moveRemainingDone.insert(moveRemainingKey(workspaceId: workspaceId))
            local.writeDeviceState(device)
            canMoveRemaining = false
            var list = tasks(.general)
            list.append(contentsOf: created.map { $0.item() })
            TaskList.normalizeSubtaskFlags(&list)
            lists[.general] = TaskList.settle(list, in: .general)
            didChange(.general, flushSoon: true)
        } catch {
            handle(error)
        }
    }

    // MARK: Theme

    public func colors(systemIsDark: Bool) -> ThemeColors {
        Themes.colors(for: themeSelected, custom: customThemes, systemIsDark: systemIsDark)
    }

    public func selectTheme(_ key: String) async {
        themeSelected = key
        device.themeSelected = key
        let updatedAt = ISO8601DateFormatter().string(from: clock())
        device.themeUpdatedAt = updatedAt
        local.writeDeviceState(device)
        publishSnapshot()
        guard let userId else { return }
        let settings = UserSettings(themeSelected: key, customThemes: customThemes, themeUpdatedAt: updatedAt)
        do {
            try await backend.saveSettings(settings, userId: userId)
            markSuccess()
        } catch {
            handle(error)
        }
    }

    /// The newer side wins, as on the web.
    private func refreshSettings() async {
        guard let userId else { return }
        do {
            let remote = try await backend.fetchSettings(userId: userId)
            markSuccess()
            guard let remote, parseDate(remote.themeUpdatedAt) > parseDate(device.themeUpdatedAt) else { return }
            themeSelected = remote.themeSelected
            customThemes = remote.customThemes
            device.themeSelected = remote.themeSelected
            device.customThemes = remote.customThemes
            device.themeUpdatedAt = remote.themeUpdatedAt
            local.writeDeviceState(device)
            publishSnapshot()
        } catch {
            handle(error)
        }
    }

    private func parseDate(_ iso: String?) -> Date {
        guard let iso else { return .distantPast }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) ?? .distantPast
    }

    // MARK: Saving

    private var hasDirtyRows: Bool {
        lists.values.contains { $0.contains(where: \.dirty) }
    }

    private func scheduleFlush() {
        flushTimer?.cancel()
        let delay = saveDelay
        flushTimer = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            self?.startFlush()
        }
    }

    @discardableResult
    private func startFlush() -> Task<Void, Never> {
        flushTimer?.cancel()
        if let flushTask {
            flushAgain = true
            return flushTask
        }
        let task = Task { [weak self] in
            guard let self else { return }
            repeat {
                self.flushAgain = false
                await self.flushOnce()
            } while self.flushAgain
            self.flushTask = nil
        }
        flushTask = task
        return task
    }

    /// Everything local has reached the server, or the attempt failed.
    public func flushNow() async {
        // A flush already running may have passed the rows just changed.
        if let running = flushTask {
            await running.value
        }
        await startFlush().value
    }

    /// Stops on a network failure: the retry loop picks everything up.
    private func flushOnce() async {
        guard let userId else { return }

        while let dbId = pendingDeletes.first {
            do {
                try await backend.deleteTask(id: dbId, userId: userId)
                markSuccess()
            } catch {
                if isNetworkOrAuth(error) { return handle(error) }
                // Already gone or rejected: retrying won't help.
            }
            pendingDeletes.removeAll { $0 == dbId }
            local.writePendingDeletes(pendingDeletes, userId: userId)
        }

        guard let workspaceId = activeWorkspaceId else { return }

        // Demotes first: the database allows one main thing per week.
        let dirtyIds = Slot.allCases
            .flatMap { tasks($0).filter(\.dirty) }
            .sorted { !$0.isMain && $1.isMain }
            .map(\.id)
        for id in dirtyIds {
            guard let at = locate(id) else { continue }
            let list = tasks(at.slot)
            let snapshot = list[at.index]
            guard snapshot.dirty else { continue }
            if TaskList.isEmptyText(snapshot.text), snapshot.dbId == nil || !TaskList.hasSubtasks(list, at: at.index) {
                // Never written blank: a draft isn't saved, a cleared row is deleted on commit.
                lists[at.slot]![at.index].dirty = false
                continue
            }
            let target = address(of: at.slot)
            let row = TaskRow(
                content: snapshot.text, completed: snapshot.checked, isSubtask: snapshot.subtask,
                isMain: snapshot.isMain, color: snapshot.color, position: at.index,
                type: target.kind.rawValue, dayName: target.dayName, date: target.date
            )
            do {
                if let dbId = snapshot.dbId {
                    try await backend.updateTask(
                        id: dbId, row: row, userId: userId,
                        relocateTo: snapshot.needsRelocate ? workspaceId : nil
                    )
                } else {
                    let newId = try await backend.insertTask(row, userId: userId, workspaceId: workspaceId)
                    if let now = locate(id) { lists[now.slot]![now.index].dbId = newId }
                }
                markSuccess()
            } catch {
                if isNetworkOrAuth(error) { return handle(error) }
                print("oneweek: save failed:", error)
                continue
            }
            guard let now = locate(id) else { continue }
            var current = tasks(now.slot)[now.index]
            let unchanged = current.text == snapshot.text && current.checked == snapshot.checked
                && current.subtask == snapshot.subtask && current.color == snapshot.color
                && current.isMain == snapshot.isMain && now.slot == at.slot
                && current.needsRelocate == snapshot.needsRelocate
            if unchanged {
                current.dirty = false
                current.needsRelocate = false
            } else {
                flushAgain = true
            }
            lists[now.slot]![now.index] = current
        }

        for slot in positionsDirty {
            let list = tasks(slot)
            let saved = list.enumerated().filter { $0.element.dbId != nil }
            do {
                try await backend.setPositions(ids: saved.map { $0.element.dbId! }, positions: saved.map(\.offset))
                markSuccess()
                positionsDirty.remove(slot)
            } catch {
                if isNetworkOrAuth(error) { return handle(error) }
                print("oneweek: order save failed:", error)
                positionsDirty.remove(slot)
            }
        }
        scheduleCacheWrite()
    }

    // MARK: Network status

    private func isNetworkOrAuth(_ error: Error) -> Bool {
        error as? BackendError == .network || error as? BackendError == .sessionExpired
    }

    private func handle(_ error: Error) {
        switch error as? BackendError {
        case .network:
            isOffline = true
            startPolling()
        case .sessionExpired:
            writeCacheNow()
            clearSignedInState()
        default:
            print("oneweek: request failed:", error)
        }
    }

    private func markSuccess() {
        isOffline = false
    }

    /// While the server is unreachable, keep trying: unsent edits, then a re-read.
    private func startPolling() {
        guard pollTask == nil else { return }
        let interval = retryInterval
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: interval)
                guard !Task.isCancelled, let self, self.isOffline else { break }
                await self.flushNow()
                if self.workspaces.isEmpty { await self.refreshWorkspaces() }
                await self.refresh()
            }
            self?.pollTask = nil
        }
    }

    // MARK: Local copies

    private func scheduleCacheWrite() {
        cacheTimer?.cancel()
        cacheTimer = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            self?.writeCacheNow()
        }
    }

    private func writeCacheNow() {
        cacheTimer?.cancel()
        guard let userId, let workspaceId = activeWorkspaceId else { return }
        for slot in Slot.allCases {
            guard let list = lists[slot] else { continue }
            let address = address(of: slot)
            let key = "\(userId)/\(workspaceId)/\(address.cacheFileName)"
            guard lastWritten[key] != list else { continue }
            lastWritten[key] = list
            local.writeList(list, userId: userId, workspaceId: workspaceId, address: address)
        }
        publishSnapshot()
    }

    /// Widgets show this week: other weeks on screen don't touch their copy.
    private func publishSnapshot() {
        guard weekOffset == 0, activeWorkspaceId != nil else { return }
        let snapshot = WidgetSnapshot.build(lists: lists, now: today, themeSelected: themeSelected, customThemes: customThemes)
        guard snapshot != (lastSnapshot ?? local.readSnapshot()) else { return }
        lastSnapshot = snapshot
        local.writeSnapshot(snapshot)
        scheduleWidgetReload()
    }

    /// Widgets re-read the server when reloaded: give the save time to land, and don't reload per keystroke.
    private func scheduleWidgetReload() {
        widgetTimer?.cancel()
        widgetTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            self?.onSnapshotWritten?()
        }
    }

    // MARK: Toast

    private func showToast(_ message: String, kind: ToastKind = .notice) {
        toast = message
        toastKind = kind
        toastTimer?.cancel()
        toastTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3.2))
            guard !Task.isCancelled else { return }
            self?.toast = nil
        }
    }
}
