import Foundation

/// Pure rules for a flat task array, in step with `js/task-model.js` on the web.
public enum TaskList {
    public struct Span: Equatable, Sendable {
        public var start: Int
        public var count: Int
        public var end: Int { start + count }
    }

    public struct Group {
        public var main: TaskItem
        public var subs: [TaskItem]
    }

    public static func isEmptyText(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: Subtasks

    /// A subtask with no main above it becomes a main. Returns the rows it changed.
    @discardableResult
    public static func normalizeSubtaskFlags(_ tasks: inout [TaskItem]) -> [UUID] {
        var changed: [UUID] = []
        for i in tasks.indices {
            guard tasks[i].subtask else { break }
            tasks[i].subtask = false
            changed.append(tasks[i].id)
        }
        return changed
    }

    public static func indexAfterSubtree(_ tasks: [TaskItem], of mainIndex: Int) -> Int {
        var position = mainIndex + 1
        while position < tasks.count, tasks[position].subtask { position += 1 }
        return position
    }

    /// A row plus its subtask run; just the row when it is a subtask.
    public static func subtreeSpan(_ tasks: [TaskItem], at index: Int) -> Span {
        guard tasks.indices.contains(index) else { return Span(start: index, count: 0) }
        if tasks[index].subtask { return Span(start: index, count: 1) }
        return Span(start: index, count: indexAfterSubtree(tasks, of: index) - index)
    }

    public static func hasSubtasks(_ tasks: [TaskItem], at mainIndex: Int) -> Bool {
        guard tasks.indices.contains(mainIndex), !tasks[mainIndex].subtask else { return false }
        return mainIndex + 1 < tasks.count && tasks[mainIndex + 1].subtask
    }

    public static func parentIndex(_ tasks: [TaskItem], ofSubtaskAt index: Int) -> Int? {
        var j = index - 1
        while j >= 0 {
            if !tasks[j].subtask { return j }
            j -= 1
        }
        return nil
    }

    public static func subtaskCount(_ tasks: [TaskItem], at mainIndex: Int) -> Int {
        hasSubtasks(tasks, at: mainIndex) ? indexAfterSubtree(tasks, of: mainIndex) - mainIndex - 1 : 0
    }

    public static func canIndent(_ tasks: inout [TaskItem], at index: Int) -> Bool {
        guard index > 0 else { return false }
        normalizeSubtaskFlags(&tasks)
        if tasks[index].subtask || hasSubtasks(tasks, at: index) { return false }
        // Don't pull a regular task into this week's main-thing block via indent.
        if isInMainThingSpan(tasks, index: index - 1), !isInMainThingSpan(tasks, index: index) { return false }
        return true
    }

    private static func insertIndexUnderRowAbove(_ tasks: [TaskItem], from index: Int) -> Int {
        guard index > 0 else { return index }
        let above = index - 1
        if !tasks[above].subtask { return indexAfterSubtree(tasks, of: above) }
        var k = above + 1
        while k < tasks.count, tasks[k].subtask { k += 1 }
        return k
    }

    private static func moveSubtaskUnderRowAbove(_ tasks: inout [TaskItem], from index: Int) {
        guard index > 0 else { return }
        let insertAt = insertIndexUnderRowAbove(tasks, from: index)
        guard insertAt != index else { return }
        let row = tasks.remove(at: index)
        tasks.insert(row, at: index < insertAt ? insertAt - 1 : insertAt)
    }

    /// Promote a subtask to a main placed after its parent's whole subtree.
    private static func outdent(_ tasks: inout [TaskItem], at index: Int) {
        guard index > 0, tasks[index].subtask else { return }
        guard let parent = parentIndex(tasks, ofSubtaskAt: index) else { return }
        var row = tasks.remove(at: index)
        row.subtask = false
        tasks.insert(row, at: indexAfterSubtree(tasks, of: parent))
    }

    @discardableResult
    public static func applyIndent(_ tasks: inout [TaskItem], at index: Int, outdent isOutdent: Bool = false) -> Bool {
        guard tasks.indices.contains(index) else { return false }
        if isOutdent {
            if tasks[index].subtask { outdent(&tasks, at: index) }
            return true
        }
        guard canIndent(&tasks, at: index) else { return false }
        tasks[index].subtask = true
        moveSubtaskUnderRowAbove(&tasks, from: index)
        return true
    }

    // MARK: Main thing

    public static func mainThingIndex(_ tasks: [TaskItem]) -> Int? {
        tasks.firstIndex { $0.isMain && !$0.subtask }
    }

    public static func mainThingSpan(_ tasks: [TaskItem]) -> Span? {
        mainThingIndex(tasks).map { subtreeSpan(tasks, at: $0) }
    }

    public static func isInMainThingSpan(_ tasks: [TaskItem], index: Int) -> Bool {
        guard let span = mainThingSpan(tasks), index >= 0 else { return false }
        return index >= span.start && index < span.end
    }

    public static func normalizeMainThingFlags(_ tasks: inout [TaskItem]) {
        var kept = false
        for i in tasks.indices {
            if tasks[i].subtask {
                tasks[i].isMain = false
            } else if tasks[i].isMain {
                if kept { tasks[i].isMain = false } else { kept = true }
            }
        }
    }

    // MARK: Ordering

    public static func splitIntoGroups(_ tasks: [TaskItem]) -> [Group] {
        var groups: [Group] = []
        for task in tasks {
            if task.subtask, let last = groups.last, !last.main.subtask {
                groups[groups.count - 1].subs.append(task)
            } else {
                groups.append(Group(main: task, subs: []))
            }
        }
        return groups
    }

    /// Open groups above done ones; inside a group, open subtasks above done ones.
    public static func partitionUncheckedBeforeChecked(_ tasks: [TaskItem]) -> [TaskItem] {
        let groups = splitIntoGroups(tasks).map { group in
            Group(main: group.main, subs: group.subs.filter { !$0.checked } + group.subs.filter(\.checked))
        }
        return (groups.filter { !$0.main.checked } + groups.filter(\.main.checked)).flatMap { [$0.main] + $0.subs }
    }

    public static func partitionKeepingMainThing(_ tasks: [TaskItem]) -> [TaskItem] {
        guard let span = mainThingSpan(tasks) else { return partitionUncheckedBeforeChecked(tasks) }
        var head = Array(tasks[span.start..<span.end])
        let rest = Array(tasks[..<span.start] + tasks[span.end...])
        head[0].isMain = true
        for i in head.indices.dropFirst() { head[i].isMain = false }
        let ordered = splitIntoGroups(head).flatMap { group in
            [group.main] + group.subs.filter { !$0.checked } + group.subs.filter(\.checked)
        }
        return ordered + partitionUncheckedBeforeChecked(rest)
    }

    // MARK: Inserting

    public static func firstCheckedIndex(_ tasks: [TaskItem]) -> Int? {
        tasks.firstIndex { $0.checked && !$0.subtask }
    }

    /// New main from a click on empty space: after open groups, before the done pile.
    public static func insertIndexForNewMain(_ tasks: [TaskItem]) -> Int {
        let from = mainThingSpan(tasks)?.end ?? 0
        return tasks[from...].firstIndex { $0.checked && !$0.subtask } ?? tasks.count
    }

    private static func insertIndexBelowRow(_ tasks: [TaskItem], below index: Int) -> Int {
        let firstChecked = firstCheckedIndex(tasks)
        var insertAt = index + 1
        if tasks[index].checked {
            insertAt = firstChecked ?? insertAt
        } else if let firstChecked, insertAt > firstChecked {
            insertAt = firstChecked
        }
        return insertAt
    }

    /// Next sibling after Enter on a filled row.
    public static func insertIndexAfterEnter(_ tasks: [TaskItem], at index: Int) -> Int {
        guard tasks.indices.contains(index) else { return tasks.count }
        if tasks[index].subtask { return insertIndexBelowRow(tasks, below: index) }
        var insertAt = indexAfterSubtree(tasks, of: index)
        if !tasks[index].checked, let firstChecked = firstCheckedIndex(tasks), insertAt > firstChecked {
            insertAt = firstChecked
        }
        return insertAt
    }

    /// New main after leaving an empty subtask (the empty row is already removed).
    public static func insertIndexAfterExitingSubtask(_ tasks: [TaskItem], parent: UUID?) -> Int {
        let firstChecked = firstCheckedIndex(tasks)
        if let parent, let parentIndex = tasks.firstIndex(where: { $0.id == parent }) {
            var insertAt = indexAfterSubtree(tasks, of: parentIndex)
            if let firstChecked, insertAt > firstChecked { insertAt = firstChecked }
            return insertAt
        }
        return firstChecked ?? tasks.count
    }

    // MARK: Moving

    /// Move a row with its subtasks before or after another row. Returns the moved row's id.
    @discardableResult
    public static func reorderSubtree(_ tasks: inout [TaskItem], from: Int, to target: Int, before: Bool) -> UUID? {
        guard from >= 0, target >= 0 else { return nil }
        let span = subtreeSpan(tasks, at: from)
        guard span.count > 0, !(target >= span.start && target < span.end) else { return nil }
        var insertAt = before ? target : target + 1
        if span.start < insertAt { insertAt -= span.count }
        if insertAt == span.start { return tasks[span.start].id }
        let block = Array(tasks[span.start..<span.end])
        tasks.removeSubrange(span.start..<span.end)
        tasks.insert(contentsOf: block, at: insertAt)
        return block[0].id
    }

    @discardableResult
    public static func reorderSubtreeToEnd(_ tasks: inout [TaskItem], from: Int) -> UUID? {
        let span = subtreeSpan(tasks, at: from)
        guard span.count > 0, span.end < tasks.count else { return nil }
        let block = Array(tasks[span.start..<span.end])
        tasks.removeSubrange(span.start..<span.end)
        tasks.append(contentsOf: block)
        return block[0].id
    }

    // MARK: Time

    // JS `\b` is ASCII-only, so a Cyrillic letter next to the time still counts as a boundary.
    private static let timePattern = try! NSRegularExpression(
        pattern: "(?<![0-9A-Za-z_])([0-9]{1,2}):([0-9]{2})(?![0-9A-Za-z_])"
    )

    private static func firstTime(in text: String) -> (hours: Int, minutes: Int, range: NSRange)? {
        let ns = text as NSString
        guard let match = timePattern.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)),
              let hours = Int(ns.substring(with: match.range(at: 1))),
              let minutes = Int(ns.substring(with: match.range(at: 2))),
              (0...23).contains(hours), (0...59).contains(minutes)
        else { return nil }
        return (hours, minutes, match.range)
    }

    public static func parseTimeMinutes(_ text: String) -> Int? {
        firstTime(in: text).map { $0.hours * 60 + $0.minutes }
    }

    /// The first valid hh:mm moves to the front, normalized to HH:mm.
    public static func moveTimeToStart(_ text: String) -> String {
        guard let time = firstTime(in: text) else { return text }
        let label = String(format: "%02d:%02d", time.hours, time.minutes)
        let rest = (text as NSString).replacingCharacters(in: time.range, with: "")
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        return rest.isEmpty ? label : "\(label) \(rest)"
    }

    private static func byTime(_ a: TaskItem, _ b: TaskItem) -> Bool {
        switch (parseTimeMinutes(a.text), parseTimeMinutes(b.text)) {
        case let (x?, y?): return x < y
        case (_?, nil): return true
        default: return false
        }
    }

    /// Stable sort: Swift's `sorted` makes no stability promise, order ties by original index.
    private static func stableSorted<T>(_ items: [T], by less: (T, T) -> Bool) -> [T] {
        items.enumerated().sorted { a, b in
            if less(a.element, b.element) { return true }
            if less(b.element, a.element) { return false }
            return a.offset < b.offset
        }.map(\.element)
    }

    /// Day columns: timed groups sort among the slots timed groups already hold; untimed rows stay put.
    public static func sortTimedTasks(_ tasks: [TaskItem]) -> [TaskItem] {
        let groups = splitIntoGroups(tasks).map { Group(main: $0.main, subs: stableSorted($0.subs, by: byTime)) }
        let isTimed: (Group) -> Bool = { parseTimeMinutes($0.main.text) != nil }
        func slotSort(_ list: [Group]) -> [Group] {
            var timed = stableSorted(list.filter(isTimed)) { byTime($0.main, $1.main) }[...]
            return list.map { isTimed($0) ? timed.removeFirst() : $0 }
        }
        let open = slotSort(groups.filter { !$0.main.checked })
        let done = slotSort(groups.filter(\.main.checked))
        return partitionUncheckedBeforeChecked((open + done).flatMap { [$0.main] + $0.subs })
    }

    // MARK: Per-list rules

    public static func normalizeText(_ text: String, in slot: Slot) -> String {
        slot.isDay ? moveTimeToStart(text) : text
    }

    /// Order after edits and loads.
    public static func settle(_ tasks: [TaskItem], in slot: Slot) -> [TaskItem] {
        if slot.isDay { return sortTimedTasks(tasks) }
        var copy = tasks
        normalizeMainThingFlags(&copy)
        return partitionKeepingMainThing(copy)
    }

    /// Order after drags and indents: keeps manual places, only re-applies open above done.
    public static func partition(_ tasks: [TaskItem], in slot: Slot) -> [TaskItem] {
        if slot.isDay { return partitionUncheckedBeforeChecked(tasks) }
        var copy = tasks
        normalizeMainThingFlags(&copy)
        return partitionKeepingMainThing(copy)
    }

    public static func togglePartition(_ tasks: [TaskItem], in slot: Slot) -> [TaskItem] {
        slot.isDay ? partitionUncheckedBeforeChecked(tasks) : partitionKeepingMainThing(tasks)
    }

    // MARK: Merge

    private static func contentKey(_ task: TaskItem, normalizeText: (String) -> String) -> String {
        let text = normalizeText(task.text).trimmingCharacters(in: .whitespacesAndNewlines)
        return "\(text)|\(task.checked ? 1 : 0)|\(task.subtask ? 1 : 0)|\(TaskColors.normalize(task.color) ?? "")"
    }

    /// Combine a server snapshot with unsynced local edits. With nothing unsynced the server order wins.
    public static func merge(
        server: [TaskItem], local: [TaskItem], normalizeText: (String) -> String = { $0 }
    ) -> [TaskItem] {
        let keepLocalOrder = local.contains { $0.dirty || ($0.dbId == nil && !isEmptyText($0.text)) }
        if !keepLocalOrder {
            // Same rows keep their local identity and collapse state.
            let localByDbId = Dictionary(local.compactMap { t in t.dbId.map { ($0, t) } }, uniquingKeysWith: { a, _ in a })
            return server.map { srv in
                var row = srv
                if let dbId = srv.dbId, let known = localByDbId[dbId] {
                    row.id = known.id
                    row.collapsed = known.collapsed
                }
                return row
            }
        }

        func key(_ task: TaskItem) -> String { contentKey(task, normalizeText: normalizeText) }
        let serverByDbId = Dictionary(server.compactMap { t in t.dbId.map { ($0, t) } }, uniquingKeysWith: { a, _ in a })
        var unusedByContent: [String: [TaskItem]] = [:]
        for row in server where row.dbId != nil { unusedByContent[key(row), default: []].append(row) }

        var usedDbIds = Set<String>()
        var result: [TaskItem] = []

        for row in local {
            if let dbId = row.dbId {
                guard let srv = serverByDbId[dbId] else {
                    // Deleted elsewhere: only unsynced edits come back, as a new row.
                    if row.dirty, !isEmptyText(row.text) {
                        var revived = row
                        revived.dbId = nil
                        result.append(revived)
                        if unusedByContent[key(row)]?.count == 1 { unusedByContent[key(row)]?.removeFirst() }
                    }
                    continue
                }
                usedDbIds.insert(dbId)
                unusedByContent[key(srv)]?.removeAll { $0.dbId == dbId }
                if row.dirty {
                    result.append(row)
                } else {
                    var merged = srv
                    merged.id = row.id
                    merged.collapsed = row.collapsed
                    result.append(merged)
                }
            } else if !isEmptyText(row.text) {
                let bucket = unusedByContent[key(row)] ?? []
                // Unique content matches only; identical twins pair up FIFO for offline retries.
                if bucket.count == 1 || (bucket.count > 1 && row.dirty) {
                    var merged = bucket[0]
                    unusedByContent[key(row)]?.removeFirst()
                    usedDbIds.insert(merged.dbId!)
                    merged.id = row.id
                    merged.collapsed = row.collapsed
                    result.append(merged)
                } else if row.dirty {
                    result.append(row)
                }
            }
        }

        for row in server {
            guard let dbId = row.dbId, !usedDbIds.contains(dbId) else { continue }
            result.append(row)
        }
        return result
    }

    // MARK: Carry forward

    public struct CarryRow: Hashable, Sendable {
        public var content: String
        public var isSubtask: Bool
        public var color: String?
        public var completed: Bool

        public init(content: String, isSubtask: Bool, color: String?, completed: Bool = false) {
            self.content = content
            self.isSubtask = isSubtask
            self.color = color
            self.completed = completed
        }
    }

    private static func fingerprint(_ row: CarryRow) -> String {
        let text = row.content.trimmingCharacters(in: .whitespacesAndNewlines)
        return "\(text)|\(row.isSubtask ? 1 : 0)|\(TaskColors.normalize(row.color) ?? "")"
    }

    /// Unfinished groups of last week's lists not yet on this week's list. A group travels whole.
    public static func carryForward(lists: [[CarryRow]], current: [CarryRow]) -> [CarryRow] {
        var seen = Set(current.map(fingerprint))
        var out: [CarryRow] = []
        for rows in lists {
            var tasks = rows.map { TaskItem(text: $0.content, checked: $0.completed, subtask: $0.isSubtask, color: $0.color) }
            normalizeSubtaskFlags(&tasks)
            for group in splitIntoGroups(tasks) where !group.main.checked {
                let main = CarryRow(content: group.main.text, isSubtask: false, color: group.main.color)
                let subs = group.subs
                    .filter { !$0.checked && !isEmptyText($0.text) }
                    .map { CarryRow(content: $0.text, isSubtask: true, color: $0.color) }
                if isEmptyText(main.content), subs.isEmpty { continue }
                guard seen.insert(fingerprint(main)).inserted else { continue }
                out.append(main)
                out.append(contentsOf: subs)
            }
        }
        return out
    }
}
