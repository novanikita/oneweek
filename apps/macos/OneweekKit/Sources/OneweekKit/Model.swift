import Foundation

/// Pastel row highlights. The stored value is always the light hex.
public enum TaskColors {
    public static let palette = [
        "#ebebeb", "#f0e2d3", "#fbe6cd", "#f8efbf", "#e2ece0",
        "#dde8f1", "#e7dfee", "#f3d8e1", "#f8dada",
    ]

    public static func normalize(_ color: String?) -> String? {
        guard let color, !color.isEmpty else { return nil }
        let lower = color.lowercased()
        return palette.contains(lower) ? lower : nil
    }
}

/// One row of a list. A main task owns the uninterrupted run of `subtask` rows after it.
public struct TaskItem: Identifiable, Codable, Hashable, Sendable {
    /// Local row identity: stays the same before and after the row is saved.
    public var id: UUID
    public var dbId: String?
    public var text: String
    public var checked: Bool
    public var subtask: Bool
    public var color: String?
    public var isMain: Bool
    /// Has changes the server doesn't.
    public var dirty: Bool
    /// Moved here from another list: the next save must also rewrite its address.
    public var needsRelocate: Bool
    public var collapsed: Bool

    public init(
        id: UUID = UUID(), dbId: String? = nil, text: String = "", checked: Bool = false,
        subtask: Bool = false, color: String? = nil, isMain: Bool = false, dirty: Bool = false,
        needsRelocate: Bool = false, collapsed: Bool = false
    ) {
        self.id = id
        self.dbId = dbId
        self.text = text
        self.checked = checked
        self.subtask = subtask
        self.color = TaskColors.normalize(color)
        self.isMain = isMain
        self.dirty = dirty
        self.needsRelocate = needsRelocate
        self.collapsed = collapsed
    }
}

/// Where a list lives in the database.
public struct ListAddress: Hashable, Codable, Sendable {
    public enum Kind: String, Codable, Sendable { case general, daily }

    public var kind: Kind
    public var dayName: String?
    public var date: String

    public init(kind: Kind, dayName: String? = nil, date: String) {
        self.kind = kind
        self.dayName = dayName
        self.date = date
    }

    var cacheFileName: String { "\(kind.rawValue)-\(dayName ?? "week")-\(date).json" }
}

/// A list on the board. `nextWeek` is the following week's task list itself.
public enum Slot: String, Hashable, CaseIterable, Codable, Sendable {
    case monday, tuesday, wednesday, thursday, friday, saturday, sunday, nextWeek, general

    public static let days: [Slot] = [.monday, .tuesday, .wednesday, .thursday, .friday, .saturday, .sunday]

    public var dayIndex: Int? { Slot.days.firstIndex(of: self) }

    /// `tasks.day_name`.
    public var dayName: String? {
        guard let index = dayIndex else { return nil }
        return WeekCalendar.dayNames[index]
    }

    /// Hour marks and the time sort apply to day columns only.
    public var isDay: Bool { dayIndex != nil }
    public var hasMainThing: Bool { self == .general }
}

public struct Workspace: Identifiable, Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var position: Int
    public var isDefault: Bool
    public var createdAt: String?

    public init(id: String, name: String, position: Int = 0, isDefault: Bool = false, createdAt: String? = nil) {
        self.id = id
        self.name = name
        self.position = position
        self.isDefault = isDefault
        self.createdAt = createdAt
    }

    enum CodingKeys: String, CodingKey {
        case id, name, position
        case isDefault = "is_default"
        case createdAt = "created_at"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        position = try c.decodeIfPresent(Int.self, forKey: .position) ?? 0
        isDefault = try c.decodeIfPresent(Bool.self, forKey: .isDefault) ?? false
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

/// A row of `public.tasks`.
public struct TaskRow: Codable, Hashable, Sendable {
    public var id: String?
    public var content: String
    public var completed: Bool
    public var isSubtask: Bool
    public var isMain: Bool
    public var color: String?
    public var position: Int
    public var type: String
    public var dayName: String?
    public var date: String
    public var createdAt: String?

    public init(
        id: String? = nil, content: String, completed: Bool = false, isSubtask: Bool = false,
        isMain: Bool = false, color: String? = nil, position: Int = 0, type: String,
        dayName: String? = nil, date: String, createdAt: String? = nil
    ) {
        self.id = id
        self.content = content
        self.completed = completed
        self.isSubtask = isSubtask
        self.isMain = isMain
        self.color = color
        self.position = position
        self.type = type
        self.dayName = dayName
        self.date = date
        self.createdAt = createdAt
    }

    enum CodingKeys: String, CodingKey {
        case id, content, completed, color, position, type, date
        case isSubtask = "is_subtask"
        case isMain = "is_main"
        case dayName = "day_name"
        case createdAt = "created_at"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id)
        content = try c.decodeIfPresent(String.self, forKey: .content) ?? ""
        completed = try c.decodeIfPresent(Bool.self, forKey: .completed) ?? false
        isSubtask = try c.decodeIfPresent(Bool.self, forKey: .isSubtask) ?? false
        isMain = try c.decodeIfPresent(Bool.self, forKey: .isMain) ?? false
        color = try c.decodeIfPresent(String.self, forKey: .color)
        position = try c.decodeIfPresent(Int.self, forKey: .position) ?? 0
        type = try c.decodeIfPresent(String.self, forKey: .type) ?? "general"
        dayName = try c.decodeIfPresent(String.self, forKey: .dayName)
        date = try c.decodeIfPresent(String.self, forKey: .date) ?? ""
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
    }

    public var address: ListAddress {
        ListAddress(kind: type == "daily" ? .daily : .general, dayName: dayName, date: date)
    }

    /// Server rows use their database id as the row identity, so a row keeps it across launches.
    public func item(normalizeText: (String) -> String = { $0 }) -> TaskItem {
        TaskItem(
            id: id.flatMap(UUID.init(uuidString:)) ?? UUID(),
            dbId: id,
            text: normalizeText(content),
            checked: completed,
            subtask: isSubtask,
            color: color,
            isMain: isMain
        )
    }
}

public struct Session: Codable, Hashable, Sendable {
    public var accessToken: String
    public var refreshToken: String
    public var expiresAt: Date
    public var userId: String
    public var email: String?

    public init(accessToken: String, refreshToken: String, expiresAt: Date, userId: String, email: String?) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
        self.userId = userId
        self.email = email
    }
}
