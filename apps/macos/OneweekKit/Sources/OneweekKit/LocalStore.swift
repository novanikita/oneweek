import Foundation

/// The App Group folder shared by the app and the widgets.
public enum SharedContainer {
    public static let appGroup = "YX7YC7XB8M.oneweek"

    public static var url: URL {
        let fm = FileManager.default
        let url = fm.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
            ?? fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("oneweek")
        try? fm.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}

/// Small state that outlives a launch; the widgets read it too.
public struct DeviceState: Codable, Hashable, Sendable {
    public var activeWorkspaceByUser: [String: String] = [:]
    public var themeSelected: String?
    public var customThemes: [CustomTheme] = []
    public var themeUpdatedAt: String?
    public var moveRemainingDone: Set<String> = []

    public init() {}
}

/// Offline copies of the lists: the screen is painted from here, then from the server.
public final class LocalStore: @unchecked Sendable {
    private let root: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(root: URL) {
        self.root = root
    }

    private func userDir(_ userId: String) -> URL {
        root.appendingPathComponent("cache").appendingPathComponent(userId)
    }

    private func read<T: Decodable>(_ type: T.Type, at url: URL) -> T? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? decoder.decode(type, from: data)
    }

    private func write<T: Encodable>(_ value: T, at url: URL) {
        guard let data = try? encoder.encode(value) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: [.atomic])
    }

    private func listURL(userId: String, workspaceId: String, address: ListAddress) -> URL {
        userDir(userId).appendingPathComponent(workspaceId).appendingPathComponent(address.cacheFileName)
    }

    public func readList(userId: String, workspaceId: String, address: ListAddress) -> [TaskItem]? {
        read([TaskItem].self, at: listURL(userId: userId, workspaceId: workspaceId, address: address))
    }

    public func writeList(_ tasks: [TaskItem], userId: String, workspaceId: String, address: ListAddress) {
        write(tasks, at: listURL(userId: userId, workspaceId: workspaceId, address: address))
    }

    public func readWorkspaces(userId: String) -> [Workspace]? {
        read([Workspace].self, at: userDir(userId).appendingPathComponent("workspaces.json"))
    }

    public func writeWorkspaces(_ workspaces: [Workspace], userId: String) {
        write(workspaces, at: userDir(userId).appendingPathComponent("workspaces.json"))
    }

    public func readPendingDeletes(userId: String) -> [String] {
        read([String].self, at: userDir(userId).appendingPathComponent("pending-deletes.json")) ?? []
    }

    public func writePendingDeletes(_ ids: [String], userId: String) {
        write(ids, at: userDir(userId).appendingPathComponent("pending-deletes.json"))
    }

    public func wipe(userId: String) {
        try? FileManager.default.removeItem(at: userDir(userId))
    }

    public func hasUnsyncedEdits(userId: String) -> Bool {
        if !readPendingDeletes(userId: userId).isEmpty { return true }
        return listFiles(userId: userId).contains { url in
            (read([TaskItem].self, at: url) ?? []).contains(where: \.dirty)
        }
    }

    private func listFiles(userId: String) -> [URL] {
        guard let walker = FileManager.default.enumerator(at: userDir(userId), includingPropertiesForKeys: nil) else { return [] }
        return walker.compactMap { $0 as? URL }.filter {
            $0.pathExtension == "json" && !["workspaces.json", "pending-deletes.json"].contains($0.lastPathComponent)
        }
    }

    /// Drop lists of weeks long past, never one with unsynced edits.
    public func prune(userId: String, olderThan cutoffIso: String) {
        for url in listFiles(userId: userId) {
            let name = url.deletingPathExtension().lastPathComponent
            guard name.count >= 10, String(name.suffix(10)) < cutoffIso else { continue }
            if (read([TaskItem].self, at: url) ?? []).contains(where: \.dirty) { continue }
            try? FileManager.default.removeItem(at: url)
        }
    }

    public func readDeviceState() -> DeviceState {
        read(DeviceState.self, at: root.appendingPathComponent("state.json")) ?? DeviceState()
    }

    public func writeDeviceState(_ state: DeviceState) {
        write(state, at: root.appendingPathComponent("state.json"))
    }

    public func readSnapshot() -> WidgetSnapshot? {
        read(WidgetSnapshot.self, at: root.appendingPathComponent("widget-snapshot.json"))
    }

    public func writeSnapshot(_ snapshot: WidgetSnapshot?) {
        let url = root.appendingPathComponent("widget-snapshot.json")
        if let snapshot { write(snapshot, at: url) } else { try? FileManager.default.removeItem(at: url) }
    }

    public func readPendingToggles() -> [String: Bool] {
        read([String: Bool].self, at: root.appendingPathComponent("widget-toggles.json")) ?? [:]
    }

    public func writePendingToggles(_ toggles: [String: Bool]) {
        write(toggles, at: root.appendingPathComponent("widget-toggles.json"))
    }
}
