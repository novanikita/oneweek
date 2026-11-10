import Foundation

/// Supabase Auth over HTTP: password sign-in, token refresh, sign-out.
public struct AuthClient: Sendable {
    let config: SupabaseConfig
    let http: URLSession

    public init(config: SupabaseConfig = .production, http: URLSession? = nil) {
        self.config = config
        self.http = http ?? SupabaseBackend.makeSession()
    }

    private struct TokenResponse: Decodable {
        struct User: Decodable {
            let id: String
            let email: String?
        }
        let access_token: String
        let refresh_token: String
        let expires_in: Double
        let user: User

        var session: Session {
            Session(
                accessToken: access_token, refreshToken: refresh_token,
                expiresAt: Date().addingTimeInterval(expires_in), userId: user.id, email: user.email
            )
        }
    }

    private func tokenRequest(grant: String, body: [String: String]) async throws -> (Data, Int) {
        var components = URLComponents(url: config.url.appendingPathComponent("auth/v1/token"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "grant_type", value: grant)]
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.setValue(config.anonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        do {
            let (data, response) = try await http.data(for: request)
            return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
        } catch {
            throw BackendError.network
        }
    }

    public func signIn(email: String, password: String) async throws -> Session {
        let (data, status) = try await tokenRequest(grant: "password", body: ["email": email, "password": password])
        guard (200..<300).contains(status) else {
            let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let message = ["error_description", "msg", "message"].lazy.compactMap { body?[$0] as? String }.first
            throw BackendError.invalidCredentials(message ?? "Couldn't sign in.")
        }
        return try JSONDecoder().decode(TokenResponse.self, from: data).session
    }

    public func refresh(refreshToken: String) async throws -> Session {
        let (data, status) = try await tokenRequest(grant: "refresh_token", body: ["refresh_token": refreshToken])
        if (200..<300).contains(status) {
            return try JSONDecoder().decode(TokenResponse.self, from: data).session
        }
        // Auth rejected the token for good; anything else may pass.
        if (400..<500).contains(status) { throw BackendError.sessionExpired }
        throw BackendError.server(status: status, message: String(decoding: data, as: UTF8.self))
    }

    public func signOut(accessToken: String) async {
        var request = URLRequest(url: config.url.appendingPathComponent("auth/v1/logout"))
        request.httpMethod = "POST"
        request.setValue(config.anonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        _ = try? await http.data(for: request)
    }
}

/// The signed-in session, in a file shared by the app and the widgets.
///
/// Refresh tokens rotate, so two processes refreshing at once would log each
/// other out: a refresh holds a file lock and re-reads the file first.
public actor SessionVault {
    public nonisolated let auth: AuthClient
    private let fileURL: URL
    private let lockURL: URL
    private var refreshing: Task<Session, Error>?

    public init(directory: URL, auth: AuthClient = AuthClient()) {
        self.auth = auth
        fileURL = directory.appendingPathComponent("session.json")
        lockURL = directory.appendingPathComponent("session.lock")
    }

    public func current() -> Session? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        return try? JSONDecoder().decode(Session.self, from: data)
    }

    public func store(_ session: Session?) {
        guard let session, let data = try? JSONEncoder().encode(session) else {
            try? FileManager.default.removeItem(at: fileURL)
            return
        }
        try? data.write(to: fileURL, options: [.atomic])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
    }

    /// A session good for at least another minute, refreshing it if needed.
    public func validSession(forceRefresh: Bool = false) async throws -> Session {
        guard let session = current() else { throw BackendError.sessionExpired }
        if !forceRefresh, session.expiresAt > Date().addingTimeInterval(60) { return session }
        if let refreshing { return try await refreshing.value }
        let task = Task { try await self.refreshLocked(staleToken: session.accessToken) }
        refreshing = task
        defer { refreshing = nil }
        return try await task.value
    }

    private func refreshLocked(staleToken: String) async throws -> Session {
        let lock = open(lockURL.path, O_CREAT | O_RDWR, 0o600)
        defer { if lock >= 0 { close(lock) } }
        if lock >= 0 {
            var waited = 0
            while flock(lock, LOCK_EX | LOCK_NB) != 0, waited < 150 {
                try await Task.sleep(for: .milliseconds(100))
                waited += 1
            }
        }
        defer { if lock >= 0 { flock(lock, LOCK_UN) } }

        // Another process may have refreshed while this one waited.
        guard let latest = current() else { throw BackendError.sessionExpired }
        if latest.accessToken != staleToken, latest.expiresAt > Date().addingTimeInterval(60) { return latest }
        do {
            let fresh = try await auth.refresh(refreshToken: latest.refreshToken)
            store(fresh)
            return fresh
        } catch BackendError.sessionExpired {
            store(nil)
            throw BackendError.sessionExpired
        }
    }
}
