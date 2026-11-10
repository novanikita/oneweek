import XCTest
@testable import OneweekKit

private func t(_ text: String, sub: Bool = false, done: Bool = false, main: Bool = false, db: String? = nil, dirty: Bool = false) -> TaskItem {
    TaskItem(dbId: db, text: text, checked: done, subtask: sub, isMain: main, dirty: dirty)
}

private func texts(_ tasks: [TaskItem]) -> [String] {
    tasks.map { $0.subtask ? "  \($0.text)" : $0.text }
}

/// The same cases as `tests/task-model.test.js`, so web and native can't drift.
final class TaskListTests: XCTestCase {
    func testWeekHelpers() {
        var parts = DateComponents(year: 2026, month: 9, day: 27, hour: 15, minute: 30)
        let sunday = Calendar(identifier: .gregorian).date(from: parts)!
        XCTAssertEqual(WeekCalendar.iso(WeekCalendar.monday(of: sunday)), "2026-09-21")
        parts.day = 21
        XCTAssertEqual(WeekCalendar.iso(WeekCalendar.monday(of: Calendar(identifier: .gregorian).date(from: parts)!)), "2026-09-21")
        XCTAssertEqual(WeekCalendar.iso(WeekCalendar.monday(of: sunday, offset: 1)), "2026-09-28")
        XCTAssertEqual(WeekCalendar.iso(WeekCalendar.monday(of: sunday, offset: -1)), "2026-09-14")
    }

    func testNormalizeColor() {
        XCTAssertEqual(TaskColors.normalize("#EBEBEB"), "#ebebeb")
        XCTAssertNil(TaskColors.normalize("#123456"))
        XCTAssertNil(TaskColors.normalize(""))
    }

    func testPartition() {
        let list = [t("done main", done: true), t("x", sub: true), t("open"), t("s-done", sub: true, done: true), t("s-open", sub: true)]
        XCTAssertEqual(texts(TaskList.partitionUncheckedBeforeChecked(list)), ["open", "  s-open", "  s-done", "done main", "  x"])
    }

    func testNormalizeSubtaskFlags() {
        var list = [t("orphan", sub: true), t("a"), t("a1", sub: true)]
        XCTAssertEqual(TaskList.normalizeSubtaskFlags(&list).count, 1)
        XCTAssertEqual(texts(list), ["orphan", "a", "  a1"])
    }

    func testCanIndent() {
        var list = [t("a"), t("b"), t("b1", sub: true), t("c")]
        XCTAssertFalse(TaskList.canIndent(&list, at: 0))
        XCTAssertFalse(TaskList.canIndent(&list, at: 1))
        XCTAssertFalse(TaskList.canIndent(&list, at: 2))
        XCTAssertTrue(TaskList.canIndent(&list, at: 3))
        var withMain = [t("main thing", main: true), t("regular")]
        XCTAssertFalse(TaskList.canIndent(&withMain, at: 1))
    }

    func testIndentOutdent() {
        var list = [t("a"), t("a1", sub: true), t("b")]
        XCTAssertTrue(TaskList.applyIndent(&list, at: 2))
        XCTAssertEqual(texts(list), ["a", "  a1", "  b"])
        var list2 = [t("a"), t("a1", sub: true), t("a2", sub: true), t("c")]
        TaskList.applyIndent(&list2, at: 1, outdent: true)
        XCTAssertEqual(texts(list2), ["a", "  a2", "a1", "c"])
    }

    func testReorderSubtree() {
        var list = [t("a"), t("a1", sub: true), t("b"), t("c")]
        XCTAssertEqual(TaskList.reorderSubtree(&list, from: 0, to: 3, before: false), list.first(where: { $0.text == "a" })?.id)
        XCTAssertEqual(texts(list), ["b", "c", "a", "  a1"])
        var list2 = [t("a"), t("a1", sub: true), t("b")]
        XCTAssertNil(TaskList.reorderSubtree(&list2, from: 0, to: 1, before: true))
    }

    func testReorderToEnd() {
        var list = [t("a"), t("a1", sub: true), t("b")]
        TaskList.reorderSubtreeToEnd(&list, from: 0)
        XCTAssertEqual(texts(list), ["b", "a", "  a1"])
        XCTAssertNil(TaskList.reorderSubtreeToEnd(&list, from: 1))
    }

    func testEnterPositions() {
        let list = [t("a"), t("a1", sub: true), t("b"), t("done", done: true)]
        XCTAssertEqual(TaskList.insertIndexAfterEnter(list, at: 0), 2)
        XCTAssertEqual(TaskList.insertIndexAfterEnter(list, at: 1), 2)
        XCTAssertEqual(TaskList.insertIndexAfterEnter(list, at: 2), 3)
        XCTAssertEqual(TaskList.insertIndexAfterExitingSubtask(list, parent: list[0].id), 2)
        XCTAssertEqual(TaskList.insertIndexAfterExitingSubtask(list, parent: nil), 3)
    }

    func testNewMainSkipsMainThing() {
        XCTAssertEqual(TaskList.insertIndexForNewMain([t("mt", main: true), t("mt1", sub: true), t("a"), t("d", done: true)]), 3)
        XCTAssertEqual(TaskList.insertIndexForNewMain([]), 0)
    }

    func testMainThing() {
        var list = [t("a", main: true), t("b", main: true), t("s", sub: true, main: true)]
        TaskList.normalizeMainThingFlags(&list)
        XCTAssertEqual(list.map(\.isMain), [true, false, false])

        let list2 = [t("x"), t("mt", done: true, main: true), t("mt1", sub: true)]
        XCTAssertEqual(texts(TaskList.partitionKeepingMainThing(list2)), ["mt", "  mt1", "x"])
        XCTAssertEqual(TaskList.mainThingSpan(list2), TaskList.Span(start: 1, count: 2))
        XCTAssertTrue(TaskList.isInMainThingSpan(list2, index: 2))
        XCTAssertFalse(TaskList.isInMainThingSpan(list2, index: 0))
    }

    func testToggleLandsOnTopOfDonePile() {
        var list = [t("a"), t("b"), t("old done", done: true)]
        list[0].checked.toggle()
        let reordered = TaskList.togglePartition(list, in: .monday)
        XCTAssertEqual(texts(reordered), ["b", "a", "old done"])
    }

    func testMergeCleanTakesServerOrder() {
        let merged = TaskList.merge(server: [t("s2", db: "2"), t("s1", db: "1")], local: [t("s1", db: "1"), t("s2", db: "2")])
        XCTAssertEqual(texts(merged), ["s2", "s1"])
    }

    func testMergeKeepsDirtyAndDrafts() {
        let server = [t("server a", db: "a"), t("new elsewhere", db: "n")]
        let local = [t("edited a", db: "a", dirty: true), t("offline draft", dirty: true)]
        let merged = TaskList.merge(server: server, local: local)
        XCTAssertEqual(texts(merged), ["edited a", "offline draft", "new elsewhere"])
        XCTAssertEqual(merged[0].dbId, "a")
        XCTAssertNil(merged[1].dbId)
    }

    func testMergeDraftAdoptsUniqueTwin() {
        let merged = TaskList.merge(server: [t("same", db: "x")], local: [t("same", dirty: true)])
        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged[0].dbId, "x")
    }

    func testTime() {
        XCTAssertEqual(TaskList.parseTimeMinutes("call at 9:05"), 545)
        XCTAssertNil(TaskList.parseTimeMinutes("25:00 nope"))
        XCTAssertEqual(TaskList.moveTimeToStart("call mom 9:05 please"), "09:05 call mom please")
        XCTAssertEqual(TaskList.moveTimeToStart("no time"), "no time")
        XCTAssertEqual(TaskList.moveTimeToStart("7:30"), "07:30")
        XCTAssertEqual(TaskList.moveTimeToStart("позвонить в 9:05"), "09:05 позвонить в")
    }

    func testSortTimed() {
        XCTAssertEqual(
            texts(TaskList.sortTimedTasks([t("14:00 late"), t("untimed"), t("09:00 early"), t("done", done: true)])),
            ["09:00 early", "untimed", "14:00 late", "done"]
        )
        XCTAssertEqual(
            texts(TaskList.sortTimedTasks([t("14:00 late"), t("untimed"), t("09:00 early"), t("done 08:00", done: true)])),
            ["09:00 early", "untimed", "14:00 late", "done 08:00"]
        )
        XCTAssertEqual(
            texts(TaskList.sortTimedTasks([t("a"), t("15:00 s", sub: true), t("08:00 d", sub: true, done: true), t("09:00 s", sub: true)])),
            ["a", "  09:00 s", "  15:00 s", "  08:00 d"]
        )
    }

    func testCarryForward() {
        func row(_ content: String, sub: Bool = false, done: Bool = false) -> TaskList.CarryRow {
            TaskList.CarryRow(content: content, isSubtask: sub, color: nil, completed: done)
        }
        let weekList = [row("Project"), row("step 1", sub: true), row("Other"), row("o1", sub: true), row("", sub: true)]
        let monday = [row("call bob"), row("done", done: true), row("Other")]
        let tuesday = [row("orphan", sub: true), row("")]
        let out = TaskList.carryForward(lists: [weekList, monday, tuesday], current: [row("Project")])
        XCTAssertEqual(out.map { "\($0.isSubtask ? "  " : "")\($0.content)" }, ["Other", "  o1", "call bob", "orphan"])
    }
}
