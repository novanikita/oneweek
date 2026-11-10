import XCTest
@testable import OneweekKit

/// In-memory server with a switch to act offline.
final class FakeBackend: Backend, @unchecked Sendable {
    var session: Session? = Session(accessToken: "a", refreshToken: "r", expiresAt: .distantFuture, userId: "u", email: "me@example.com")
    var workspaces = [Workspace(id: "w", name: "main", isDefault: true)]
    var rows: [TaskRow] = []
    var offline = false
    var fetchCount = 0
    /// Holds the next read until released, to land an answer mid-edit.
    var fetchGate: CheckedContinuation<Void, Never>?
    var gateNextFetch = false

    private func check() throws { if offline { throw BackendError.network } }

    func currentSession() async -> Session? { session }
    func signIn(email: String, password: String) async throws -> Session { session! }
    func signOut() async { session = nil }
    func fetchWorkspaces(userId: String) async throws -> [Workspace] { try check(); return workspaces }
    func createWorkspace(userId: String, name: String, position: Int, isDefault: Bool) async throws -> Workspace {
        try check()
        let w = Workspace(id: UUID().uuidString, name: name, position: position, isDefault: isDefault)
        workspaces.append(w)
        return w
    }
    func renameWorkspace(id: String, name: String, userId: String) async throws { try check() }
    func deleteWorkspace(id: String, userId: String) async throws { try check() }

    func fetchRows(userId: String, workspaceId: String, from: String, to: String, weekLists: [String]) async throws -> [TaskRow] {
        try check()
        fetchCount += 1
        let answer = rows
            .filter { ($0.type == "daily" && $0.date >= from && $0.date <= to) || ($0.type == "general" && weekLists.contains($0.date)) }
            .sorted { $0.position < $1.position }
        if gateNextFetch {
            gateNextFetch = false
            await withCheckedContinuation { fetchGate = $0 }
        }
        return answer
    }
    func releaseFetch() { fetchGate?.resume(); fetchGate = nil }

    func insertTask(_ row: TaskRow, userId: String, workspaceId: String) async throws -> String {
        try check()
        var saved = row
        saved.id = UUID().uuidString
        rows.append(saved)
        return saved.id!
    }
    func insertTasks(_ newRows: [TaskRow], userId: String, workspaceId: String) async throws -> [TaskRow] {
        try check()
        let saved = newRows.map { row -> TaskRow in var s = row; s.id = UUID().uuidString; return s }
        rows.append(contentsOf: saved)
        return saved
    }
    func updateTask(id: String, row: TaskRow, userId: String, relocateTo workspaceId: String?) async throws {
        try check()
        guard let index = rows.firstIndex(where: { $0.id == id }) else { return }
        rows[index].content = row.content
        rows[index].completed = row.completed
        rows[index].isSubtask = row.isSubtask
        rows[index].isMain = row.isMain
        rows[index].color = row.color
        rows[index].position = row.position
        if workspaceId != nil {
            rows[index].type = row.type
            rows[index].dayName = row.dayName
            rows[index].date = row.date
        }
    }
    func setCompleted(id: String, completed: Bool, userId: String) async throws {
        try check()
        if let index = rows.firstIndex(where: { $0.id == id }) { rows[index].completed = completed }
    }
    func deleteTask(id: String, userId: String) async throws { try check(); rows.removeAll { $0.id == id } }
    func setPositions(ids: [String], positions: [Int]) async throws {
        try check()
        for (id, position) in zip(ids, positions) {
            if let index = rows.firstIndex(where: { $0.id == id }) { rows[index].position = position }
        }
    }
    func fetchSettings(userId: String) async throws -> UserSettings? { try check(); return nil }
    func saveSettings(_ settings: UserSettings, userId: String) async throws { try check() }
}

@MainActor
final class BoardStoreTests: XCTestCase {
    private var backend: FakeBackend!
    private var store: BoardStore!
    private var dir: URL!
    private let now = Calendar(identifier: .gregorian).date(from: DateComponents(year: 2026, month: 11, day: 11, hour: 12))!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        backend = FakeBackend()
        let fixedNow = now
        store = BoardStore(
            backend: backend, local: LocalStore(root: dir), clock: { fixedNow },
            retryInterval: .milliseconds(30), saveDelay: .milliseconds(5)
        )
        await store.start()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func typeRow(in slot: Slot, _ text: String) -> UUID {
        store.beginNewTask(in: slot)
        let id = store.focusRequest!.rowId
        store.rowBeganEditing(id)
        store.updateText(id, text)
        return id
    }

    private func leave(_ id: UUID) async {
        store.rowEndedEditing(id)
        await store.flushNow()
    }

    private func settle() async {
        try? await Task.sleep(for: .milliseconds(60))
    }

    private func rowTexts(_ slot: Slot) -> [String] {
        (store.lists[slot] ?? []).map(\.text)
    }

    func testRowIsSavedWithItsListAddress() async {
        let id = typeRow(in: .wednesday, "call bob 14:30")
        await leave(id)
        XCTAssertEqual(rowTexts(.wednesday), ["14:30 call bob"])
        XCTAssertEqual(backend.rows.first?.dayName, "Wednesday")
        XCTAssertEqual(backend.rows.first?.date, "2026-11-11")
        XCTAssertEqual(backend.rows.first?.content, "14:30 call bob")
    }

    func testEnterMakesNextRowAndBlankDraftIsDropped() async {
        let a = typeRow(in: .general, "A")
        XCTAssertTrue(store.enter(a, text: "A"))
        let b = store.focusRequest!.rowId
        store.rowEndedEditing(a)
        store.rowBeganEditing(b)
        XCTAssertEqual(rowTexts(.general), ["A", ""])
        await leave(b)
        XCTAssertEqual(rowTexts(.general), ["A"])
        XCTAssertEqual(backend.rows.map(\.content), ["A"])
    }

    func testTabIndentsAndOutdents() async {
        let a = typeRow(in: .general, "A")
        _ = store.enter(a, text: "A")
        let b = store.focusRequest!.rowId
        store.updateText(b, "B")
        store.indent(b, outdent: false)
        XCTAssertEqual(store.lists[.general]?.map(\.subtask), [false, true])
        store.indent(b, outdent: true)
        XCTAssertEqual(store.lists[.general]?.map(\.subtask), [false, false])
    }

    func testRefreshWaitsWhileTypingThenApplies() async {
        let a = typeRow(in: .general, "A")
        await store.flushNow()
        backend.rows.append(TaskRow(id: UUID().uuidString, content: "from phone", position: 9, type: "general", date: "2026-11-09"))

        await store.refresh()
        XCTAssertEqual(rowTexts(.general), ["A"], "a list being typed in is left alone")

        await leave(a)
        await settle()
        XCTAssertEqual(Set(rowTexts(.general)), ["A", "from phone"], "the re-read runs after leaving the row")
    }

    func testOtherListsRefreshWhileTyping() async {
        _ = typeRow(in: .general, "A")
        backend.rows.append(TaskRow(id: UUID().uuidString, content: "phone day", position: 0, type: "daily", dayName: "Monday", date: "2026-11-09"))
        await store.refresh()
        XCTAssertEqual(rowTexts(.monday), ["phone day"])
    }

    func testAnswerLandingMidEditDoesNotOverwrite() async {
        let a = typeRow(in: .general, "A")
        await leave(a)
        backend.gateNextFetch = true
        async let refreshing: Void = store.refresh()
        await settle()

        store.rowBeganEditing(a)
        store.updateText(a, "A edited")
        backend.releaseFetch()
        await refreshing
        XCTAssertEqual(rowTexts(.general), ["A edited"])
        XCTAssertEqual(store.activeRowId, a)
    }

    func testOfflineEditsStayAndSendWhenBack() async {
        let a = typeRow(in: .general, "A")
        await leave(a)
        backend.offline = true
        store.rowBeganEditing(a)
        store.updateText(a, "A offline")
        await store.flushNow()
        XCTAssertTrue(store.isOffline)
        await settle()
        XCTAssertEqual(rowTexts(.general), ["A offline"], "retries never touch the row")
        XCTAssertEqual(store.activeRowId, a)

        backend.offline = false
        await leave(a)
        await settle()
        XCTAssertFalse(store.isOffline)
        XCTAssertEqual(backend.rows.first?.content, "A offline")
        XCTAssertEqual(store.lists[.general]?.first?.dirty, false)
    }

    func testDeleteAndUndoBeforeItReachesServer() async {
        let a = typeRow(in: .general, "A")
        await leave(a)
        backend.offline = true
        store.delete(a)
        XCTAssertEqual(rowTexts(.general), [])
        store.undoDelete()
        XCTAssertEqual(rowTexts(.general), ["A"])
        backend.offline = false
        await store.flushNow()
        XCTAssertEqual(backend.rows.map(\.content), ["A"], "the queued delete was cancelled")
    }

    func testDeleteAndUndoAfterItReachedServer() async {
        let a = typeRow(in: .general, "A")
        await leave(a)
        store.delete(a)
        await store.flushNow()
        XCTAssertTrue(backend.rows.isEmpty)
        store.undoDelete()
        await store.flushNow()
        XCTAssertEqual(backend.rows.map(\.content), ["A"])
    }

    func testClearedRowIsDeletedOnLeaving() async {
        let a = typeRow(in: .general, "A")
        await leave(a)
        store.rowBeganEditing(a)
        store.updateText(a, "")
        await leave(a)
        XCTAssertEqual(rowTexts(.general), [])
        XCTAssertTrue(backend.rows.isEmpty)
    }

    func testClearedParentStaysForItsSubtasks() async {
        let a = typeRow(in: .general, "A")
        _ = store.enter(a, text: "A")
        let b = store.focusRequest!.rowId
        store.updateText(b, "B")
        store.indent(b, outdent: false)
        await leave(b)
        store.rowEndedEditing(a)
        await store.flushNow()
        store.rowBeganEditing(a)
        store.updateText(a, "")
        await leave(a)
        XCTAssertEqual(rowTexts(.general), ["", "B"])
    }

    func testMoveAcrossListsRewritesAddressAndKeepsSubtasks() async {
        let a = typeRow(in: .general, "A 9:30")
        _ = store.enter(a, text: "A 9:30")
        let b = store.focusRequest!.rowId
        store.updateText(b, "B")
        store.indent(b, outdent: false)
        await leave(b)
        store.rowEndedEditing(a)
        await store.flushNow()

        store.moveRow(a, to: .friday, before: nil, intoMain: false)
        await store.flushNow()
        XCTAssertEqual(rowTexts(.general), [])
        XCTAssertEqual(rowTexts(.friday), ["09:30 A", "B"])
        XCTAssertEqual(Set(backend.rows.map(\.dayName)), ["Friday"])
        XCTAssertEqual(backend.rows.first { $0.content == "09:30 A" }?.date, "2026-11-13")
    }

    func testOneMainThingDemotesFirst() async {
        let a = typeRow(in: .general, "A")
        await leave(a)
        let b = typeRow(in: .general, "B")
        await leave(b)
        store.toggleMainThing(a)
        await store.flushNow()
        store.toggleMainThing(b)
        await store.flushNow()
        XCTAssertEqual(backend.rows.filter(\.isMain).map(\.content), ["B"])
        XCTAssertEqual(store.splitGeneral().main.map(\.text), ["B"])
        XCTAssertEqual(store.toast, "There can only be one main thing :)")
    }

    func testStarOnDayRowPullsItIntoMainThing() async {
        let a = typeRow(in: .monday, "A")
        await leave(a)
        store.toggleMainThing(a)
        await store.flushNow()
        XCTAssertEqual(rowTexts(.monday), [])
        XCTAssertEqual(store.splitGeneral().main.map(\.text), ["A"])
        XCTAssertEqual(backend.rows.first?.type, "general")
        XCTAssertEqual(backend.rows.first?.isMain, true)
    }

    func testMoveRemainingCopiesAndLastWeekStays() async {
        backend.rows = [
            TaskRow(id: UUID().uuidString, content: "left over", position: 0, type: "general", date: "2026-11-02"),
            TaskRow(id: UUID().uuidString, content: "finished", completed: true, position: 1, type: "general", date: "2026-11-02"),
        ]
        await store.refreshMoveRemaining()
        XCTAssertTrue(store.canMoveRemaining)
        await store.moveRemaining()
        XCTAssertEqual(rowTexts(.general), ["left over"])
        XCTAssertEqual(backend.rows.filter { $0.date == "2026-11-02" }.count, 2)
        XCTAssertFalse(store.canMoveRemaining)
    }

    func testWeekSwitchFlushesAndShowsOtherWeek() async {
        let a = typeRow(in: .general, "A")
        store.rowEndedEditing(a)
        await store.setWeekOffset(1)
        XCTAssertEqual(backend.rows.first?.content, "A")
        XCTAssertEqual(rowTexts(.general), [])
        await store.setWeekOffset(0)
        XCTAssertEqual(rowTexts(.general), ["A"])
    }

    func testCacheSurvivesRelaunchOffline() async {
        let a = typeRow(in: .general, "A")
        await leave(a)
        backend.offline = true
        store.rowBeganEditing(a)
        store.updateText(a, "A offline")
        await store.appWillResignActive()

        let fixedNow = now
        let relaunched = BoardStore(
            backend: backend, local: LocalStore(root: dir), clock: { fixedNow },
            retryInterval: .milliseconds(30), saveDelay: .milliseconds(5)
        )
        await relaunched.start()
        XCTAssertEqual(relaunched.lists[.general]?.map(\.text), ["A offline"])

        backend.offline = false
        await settle()
        await relaunched.flushNow()
        XCTAssertEqual(backend.rows.first?.content, "A offline")
    }

    func testWidgetSnapshotShowsSavedRowsOfThisWeek() async {
        let a = typeRow(in: .wednesday, "A")
        await leave(a)
        _ = typeRow(in: .wednesday, "not saved yet")
        await store.appWillResignActive()
        let snapshot = LocalStore(root: dir).readSnapshot()
        XCTAssertEqual(snapshot?.weekMonday, "2026-11-09")
        XCTAssertEqual(snapshot?.day(containing: now)?.name, "wednesday")
        XCTAssertTrue(snapshot?.day(containing: now)?.tasks.map(\.text).contains("A") == true)
    }

    func testWidgetToggleQueuesOffline() async {
        let local = LocalStore(root: dir)
        let id = UUID().uuidString
        backend.rows = [TaskRow(id: id, content: "A", position: 0, type: "daily", dayName: "Wednesday", date: "2026-11-11")]
        let source = WidgetDataSource(backend: backend, local: local)
        _ = await source.load(now: now)

        backend.offline = true
        await source.setChecked(true, taskId: id)
        XCTAssertEqual(local.readSnapshot()?.day(containing: now)?.tasks.first?.checked, true)
        XCTAssertEqual(backend.rows.first?.completed, false)

        backend.offline = false
        _ = await source.load(now: now)
        XCTAssertEqual(backend.rows.first?.completed, true)
    }
}
