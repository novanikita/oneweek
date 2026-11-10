import Foundation

public enum BackendError: Error, Equatable {
    case network
    case sessionExpired
    case invalidCredentials(String)
    case server(status: Int, message: String)
}

public struct UserSettings: Codable, Hashable, Sendable {
    public var themeSelected: String?
    public var customThemes: [CustomTheme]
    public var themeUpdatedAt: String?

    public init(themeSelected: String?, customThemes: [CustomTheme], themeUpdatedAt: String?) {
        self.themeSelected = themeSelected
        self.customThemes = customThemes
        self.themeUpdatedAt = themeUpdatedAt
    }

    enum CodingKeys: String, CodingKey {
        case themeSelected = "theme_selected"
        case customThemes = "custom_themes"
        case themeUpdatedAt = "theme_updated_at"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        themeSelected = try c.decodeIfPresent(String.self, forKey: .themeSelected)
        customThemes = (try? c.decodeIfPresent([CustomTheme].self, forKey: .customThemes)) ?? []
        themeUpdatedAt = try c.decodeIfPresent(String.self, forKey: .themeUpdatedAt)
    }
}

/// Everything the app and the widgets need from the server.
public protocol Backend: Sendable {
    func currentSession() async -> Session?
    func signIn(email: String, password: String) async throws -> Session
    func signOut() async

    func fetchWorkspaces(userId: String) async throws -> [Workspace]
    func createWorkspace(userId: String, name: String, position: Int, isDefault: Bool) async throws -> Workspace
    func renameWorkspace(id: String, name: String, userId: String) async throws
    func deleteWorkspace(id: String, userId: String) async throws

    /// Day rows dated `from...to` plus the week lists dated `weekLists`.
    func fetchRows(userId: String, workspaceId: String, from: String, to: String, weekLists: [String]) async throws -> [TaskRow]
    func insertTask(_ row: TaskRow, userId: String, workspaceId: String) async throws -> String
    func insertTasks(_ rows: [TaskRow], userId: String, workspaceId: String) async throws -> [TaskRow]
    /// Content fields only, unless `relocateTo` asks to rewrite the row's list too.
    func updateTask(id: String, row: TaskRow, userId: String, relocateTo workspaceId: String?) async throws
    func setCompleted(id: String, completed: Bool, userId: String) async throws
    func deleteTask(id: String, userId: String) async throws
    func setPositions(ids: [String], positions: [Int]) async throws

    func fetchSettings(userId: String) async throws -> UserSettings?
    func saveSettings(_ settings: UserSettings, userId: String) async throws
}

public struct SupabaseConfig: Sendable {
    public var url: URL
    public var anonKey: String

    public init(url: URL, anonKey: String) {
        self.url = url
        self.anonKey = anonKey
    }

    /// The anon key is public by design; row-level security protects the data.
    public static let production = SupabaseConfig(
        url: URL(string: "https://ywofdvbtcbvkkjxcazlu.supabase.co")!,
        anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3b2ZkdmJ0Y2J2a2tqeGNhemx1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4NjQwMjgsImV4cCI6MjA5MDQ0MDAyOH0.n5eglSosCp6M3mH8i559VczJxVFy73t4U6npUPIVxoY"
    )
}

/// Talks to Supabase Auth and PostgREST over plain HTTP.
public final class SupabaseBackend: Backend, @unchecked Sendable {
    private let config: SupabaseConfig
    private let vault: SessionVault
    private let http: URLSession

    public init(config: SupabaseConfig = .production, vault: SessionVault, http: URLSession? = nil) {
        self.config = config
        self.vault = vault
        self.http = http ?? Self.makeSession()
    }

    static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }

    // MARK: Auth

    public func currentSession() async -> Session? {
        await vault.current()
    }

    public func signIn(email: String, password: String) async throws -> Session {
        let session = try await vault.auth.signIn(email: email, password: password)
        await vault.store(session)
        return session
    }

    public func signOut() async {
        if let session = await vault.current() {
            await vault.auth.signOut(accessToken: session.accessToken)
        }
        await vault.store(nil)
    }

    // MARK: Requests

    private func send(
        _ method: String,
        _ path: String,
        query: [URLQueryItem] = [],
        body: Any? = nil,
        prefer: String? = nil
    ) async throws -> Data {
        var session = try await vault.validSession()
        for attempt in 0..<2 {
            var components = URLComponents(url: config.url.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
            if !query.isEmpty { components.queryItems = query }
            var request = URLRequest(url: components.url!)
            request.httpMethod = method
            request.setValue(config.anonKey, forHTTPHeaderField: "apikey")
            request.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")
            if let prefer { request.setValue(prefer, forHTTPHeaderField: "Prefer") }
            if let body {
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
            }

            let data: Data
            let response: URLResponse
            do {
                (data, response) = try await http.data(for: request)
            } catch {
                throw BackendError.network
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if status == 401, attempt == 0 {
                session = try await vault.validSession(forceRefresh: true)
                continue
            }
            guard (200..<300).contains(status) else {
                throw BackendError.server(status: status, message: String(decoding: data, as: UTF8.self))
            }
            return data
        }
        throw BackendError.sessionExpired
    }

    private func eq(_ column: String, _ value: String) -> URLQueryItem {
        URLQueryItem(name: column, value: "eq.\(value)")
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        try JSONDecoder().decode(type, from: data)
    }

    private func nullable(_ value: String?) -> Any { value ?? NSNull() }

    private func contentFields(_ row: TaskRow) -> [String: Any] {
        [
            "content": row.content,
            "completed": row.completed,
            "is_subtask": row.isSubtask,
            "is_main": row.isMain && !row.isSubtask,
            "color": nullable(TaskColors.normalize(row.color)),
            "position": row.position,
        ]
    }

    private func addressFields(_ row: TaskRow) -> [String: Any] {
        ["type": row.type, "day_name": nullable(row.dayName), "date": row.date]
    }

    private func insertBody(_ row: TaskRow, userId: String, workspaceId: String) -> [String: Any] {
        contentFields(row)
            .merging(addressFields(row)) { a, _ in a }
            .merging(["user_id": userId, "workspace_id": workspaceId]) { a, _ in a }
    }

    private static let taskColumns = "id,content,completed,created_at,is_subtask,color,position,is_main,type,day_name,date"
    private static let workspaceColumns = "id,name,position,created_at,is_default"

    // MARK: Workspaces

    public func fetchWorkspaces(userId: String) async throws -> [Workspace] {
        let data = try await send("GET", "rest/v1/workspaces", query: [
            URLQueryItem(name: "select", value: Self.workspaceColumns),
            eq("user_id", userId),
            URLQueryItem(name: "order", value: "position.asc,created_at.asc"),
        ])
        return try decode([Workspace].self, data)
    }

    public func createWorkspace(userId: String, name: String, position: Int, isDefault: Bool) async throws -> Workspace {
        let data = try await send(
            "POST", "rest/v1/workspaces",
            query: [URLQueryItem(name: "select", value: Self.workspaceColumns)],
            body: ["user_id": userId, "name": name, "position": position, "is_default": isDefault],
            prefer: "return=representation"
        )
        guard let created = try decode([Workspace].self, data).first else {
            throw BackendError.server(status: 200, message: "workspace insert returned nothing")
        }
        return created
    }

    public func renameWorkspace(id: String, name: String, userId: String) async throws {
        _ = try await send("PATCH", "rest/v1/workspaces", query: [eq("id", id), eq("user_id", userId)], body: ["name": name])
    }

    public func deleteWorkspace(id: String, userId: String) async throws {
        _ = try await send("DELETE", "rest/v1/workspaces", query: [eq("id", id), eq("user_id", userId)])
    }

    // MARK: Tasks

    public func fetchRows(userId: String, workspaceId: String, from: String, to: String, weekLists: [String]) async throws -> [TaskRow] {
        let dates = weekLists.joined(separator: ",")
        let data = try await send("GET", "rest/v1/tasks", query: [
            URLQueryItem(name: "select", value: Self.taskColumns),
            eq("user_id", userId),
            eq("workspace_id", workspaceId),
            URLQueryItem(name: "or", value: "(and(type.eq.daily,date.gte.\(from),date.lte.\(to)),and(type.eq.general,date.in.(\(dates))))"),
            URLQueryItem(name: "order", value: "position.asc,created_at.asc"),
        ])
        return try decode([TaskRow].self, data)
    }

    public func insertTask(_ row: TaskRow, userId: String, workspaceId: String) async throws -> String {
        let data = try await send(
            "POST", "rest/v1/tasks",
            query: [URLQueryItem(name: "select", value: "id")],
            body: insertBody(row, userId: userId, workspaceId: workspaceId),
            prefer: "return=representation"
        )
        guard let id = try decode([TaskRow].self, data).first?.id else {
            throw BackendError.server(status: 200, message: "task insert returned no id")
        }
        return id
    }

    public func insertTasks(_ rows: [TaskRow], userId: String, workspaceId: String) async throws -> [TaskRow] {
        guard !rows.isEmpty else { return [] }
        let data = try await send(
            "POST", "rest/v1/tasks",
            query: [URLQueryItem(name: "select", value: Self.taskColumns)],
            body: rows.map { insertBody($0, userId: userId, workspaceId: workspaceId) },
            prefer: "return=representation"
        )
        return try decode([TaskRow].self, data)
    }

    public func updateTask(id: String, row: TaskRow, userId: String, relocateTo workspaceId: String?) async throws {
        var body = contentFields(row)
        if let workspaceId {
            body.merge(addressFields(row)) { a, _ in a }
            body["workspace_id"] = workspaceId
        }
        _ = try await send("PATCH", "rest/v1/tasks", query: [eq("id", id), eq("user_id", userId)], body: body)
    }

    public func setCompleted(id: String, completed: Bool, userId: String) async throws {
        _ = try await send("PATCH", "rest/v1/tasks", query: [eq("id", id), eq("user_id", userId)], body: ["completed": completed])
    }

    public func deleteTask(id: String, userId: String) async throws {
        _ = try await send("DELETE", "rest/v1/tasks", query: [eq("id", id), eq("user_id", userId)])
    }

    public func setPositions(ids: [String], positions: [Int]) async throws {
        guard !ids.isEmpty else { return }
        _ = try await send("POST", "rest/v1/rpc/set_task_positions", body: ["ids": ids, "positions": positions])
    }

    // MARK: Settings

    public func fetchSettings(userId: String) async throws -> UserSettings? {
        let data = try await send("GET", "rest/v1/user_settings", query: [
            URLQueryItem(name: "select", value: "theme_selected,custom_themes,theme_updated_at"),
            eq("user_id", userId),
        ])
        return try decode([UserSettings].self, data).first
    }

    public func saveSettings(_ settings: UserSettings, userId: String) async throws {
        let themes = try JSONSerialization.jsonObject(with: JSONEncoder().encode(settings.customThemes))
        _ = try await send(
            "POST", "rest/v1/user_settings",
            body: [
                "user_id": userId,
                "theme_selected": nullable(settings.themeSelected),
                "custom_themes": themes,
                "theme_updated_at": settings.themeUpdatedAt ?? ISO8601DateFormatter().string(from: Date()),
            ],
            prefer: "resolution=merge-duplicates"
        )
    }
}
