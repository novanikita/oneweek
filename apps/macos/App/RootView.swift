import AppKit
import OneweekKit
import SwiftUI

struct RootView: View {
    @Environment(BoardStore.self) private var store
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let theme = store.colors(systemIsDark: colorScheme == .dark)
        Group {
            switch store.phase {
            case .loading: Color.clear
            case .signedOut: SignInView()
            case .ready: BoardScreen()
            }
        }
        .environment(\.theme, theme)
        .font(Typeface.regular(Typeface.bodySize))
        .preferredColorScheme(themeOverride(theme))
        .task { await store.start() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await store.appBecameActive() }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.willResignActiveNotification)) { _ in
            Task { await store.appWillResignActive() }
        }
    }

    /// "Match device" must keep following the system; a fixed theme sets the controls to match.
    private func themeOverride(_ theme: ThemeColors) -> ColorScheme? {
        guard let key = store.themeSelected, key != Themes.auto else { return nil }
        return theme.usesDarkHighlights ? .dark : .light
    }
}

struct SignInView: View {
    @Environment(BoardStore.self) private var store
    @State private var email = ""
    @State private var password = ""
    @State private var message: String?
    @State private var busy = false

    private var canSubmit: Bool { !busy && !email.isEmpty && !password.isEmpty }

    var body: some View {
        VStack(spacing: 14) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 72, height: 72)
            Text("oneweek").font(.title.weight(.semibold))
            Text("One week on a screen — everything important in view.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            VStack(spacing: 8) {
                TextField("email", text: $email).textContentType(.username)
                SecureField("password", text: $password).textContentType(.password)
            }
            .textFieldStyle(.roundedBorder)
            .onSubmit(submit)
            Button(action: submit) {
                Text(busy ? "signing in…" : "sign in").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .keyboardShortcut(.defaultAction)
            .disabled(!canSubmit)
            if let message {
                Text(message).font(.callout).foregroundStyle(.secondary)
            }
            Text("Use the account from the website. New accounts are created there.")
                .font(.footnote)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
        }
        .frame(width: 300)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func submit() {
        guard canSubmit else { return }
        busy = true
        message = nil
        Task {
            message = await store.signIn(email: email.trimmingCharacters(in: .whitespaces), password: password)
            busy = false
        }
    }
}

struct BoardScreen: View {
    @Environment(BoardStore.self) private var store
    @Environment(\.theme) private var theme
    @State private var columns = NavigationSplitViewVisibility.detailOnly
    @State private var naming: WorkspaceNaming?
    @State private var nameDraft = ""
    @State private var deleting: Workspace?

    private struct WorkspaceNaming: Identifiable {
        var id: String { workspace?.id ?? "new" }
        var workspace: Workspace?
    }

    var body: some View {
        NavigationSplitView(columnVisibility: $columns) {
            WeeksSidebar()
                .navigationSplitViewColumnWidth(min: 230, ideal: 260, max: 320)
        } detail: {
            WeekBoard()
                .background(theme.backgroundColor)
                .foregroundStyle(theme.textColor)
                .overlay(alignment: .bottom) { status }
                .navigationTitle(WeekCalendar.label(weekOffset: store.weekOffset, now: store.today))
                .navigationSubtitle(WeekCalendar.rangeLabel(weekOffset: store.weekOffset, now: store.today))
                .toolbar { toolbar }
        }
        .alert(naming?.workspace == nil ? "New workspace" : "Rename workspace", isPresented: namingShown) {
            TextField("name", text: $nameDraft)
            Button("Save", action: saveName)
            Button("Cancel", role: .cancel) {}
        }
        .alert("Delete workspace \"\(deleting?.name ?? "")\"?", isPresented: deletingShown) {
            Button("Delete", role: .destructive) {
                if let id = deleting?.id { Task { await store.deleteWorkspace(id) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("All tasks in this workspace will be permanently deleted.")
        }
    }

    private var status: some View {
        VStack(spacing: 6) {
            if let toast = store.toast { StatusPill(text: toast) }
            if store.isOffline { StatusPill(text: "No connection right now, but your tasks are still saved locally.") }
        }
        .padding(.bottom, 14)
        .allowsHitTesting(false)
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .navigation) {
            Button { Task { await store.setWeekOffset(store.weekOffset - 1) } } label: {
                Label("Previous Week", systemImage: "chevron.left")
            }
            Button { Task { await store.setWeekOffset(store.weekOffset + 1) } } label: {
                Label("Next Week", systemImage: "chevron.right")
            }
        }
        ToolbarItemGroup(placement: .primaryAction) {
            if store.weekOffset != 0 {
                Button("now") { Task { await store.setWeekOffset(0) } }
            }
            workspaceMenu
        }
    }

    private var workspaceMenu: some View {
        Menu {
            Picker("Workspace", selection: workspaceBinding) {
                ForEach(store.workspaces) { Text($0.name).tag(Optional($0.id)) }
            }
            .pickerStyle(.inline)
            .labelsHidden()
            Divider()
            Button("New Workspace…") {
                nameDraft = ""
                naming = WorkspaceNaming(workspace: nil)
            }
            Button("Rename…") {
                nameDraft = store.activeWorkspace?.name ?? ""
                naming = WorkspaceNaming(workspace: store.activeWorkspace)
            }
            Button("Delete…") { deleting = store.activeWorkspace }
                .disabled(store.activeWorkspace?.isDefault != false)
        } label: {
            Label(store.activeWorkspace?.name ?? "workspace", systemImage: "square.stack")
                .labelStyle(.titleAndIcon)
        }
    }

    private var workspaceBinding: Binding<String?> {
        Binding(
            get: { store.activeWorkspaceId },
            set: { id in if let id { Task { await store.selectWorkspace(id) } } }
        )
    }

    private var namingShown: Binding<Bool> {
        Binding(get: { naming != nil }, set: { if !$0 { naming = nil } })
    }

    private var deletingShown: Binding<Bool> {
        Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
    }

    private func saveName() {
        let target = naming
        naming = nil
        Task {
            if let workspace = target?.workspace {
                await store.renameWorkspace(workspace.id, to: nameDraft)
            } else {
                await store.createWorkspace(named: nameDraft)
            }
        }
    }
}

struct StatusPill: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.regularMaterial, in: Capsule())
    }
}

struct Hairline: View {
    @Environment(\.theme) private var theme
    let axis: Axis

    init(_ axis: Axis) {
        self.axis = axis
    }

    var body: some View {
        Rectangle()
            .fill(theme.hairline)
            .frame(width: axis == .vertical ? 1 : nil, height: axis == .horizontal ? 1 : nil)
    }
}

struct WeeksSidebar: View {
    @Environment(BoardStore.self) private var store

    private static let pastWeeks = 12

    var body: some View {
        List(selection: selection) {
            Section("weeks") {
                ForEach(Array(stride(from: 1, through: -Self.pastWeeks, by: -1)), id: \.self) { offset in
                    HStack {
                        Text(WeekCalendar.rangeLabel(weekOffset: offset, now: store.today)).lineLimit(1)
                        Spacer(minLength: 6)
                        if let tag = tag(offset) {
                            Text(tag).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .tag(offset)
                }
            }
        }
        .listStyle(.sidebar)
    }

    private var selection: Binding<Int?> {
        Binding(
            get: { store.weekOffset },
            set: { offset in if let offset { Task { await store.setWeekOffset(offset) } } }
        )
    }

    private func tag(_ offset: Int) -> String? {
        switch offset {
        case 0: "now"
        case 1: "next week"
        case -1: "last week"
        default: nil
        }
    }
}

struct SettingsView: View {
    @Environment(BoardStore.self) private var store

    var body: some View {
        Form {
            Picker("Theme", selection: themeBinding) {
                ForEach(Themes.options(custom: store.customThemes)) { Text($0.name).tag($0.id) }
            }
            if store.phase == .ready {
                LabeledContent("Account", value: store.email ?? "")
                Button("Log Out…", action: logOut)
            }
        }
        .formStyle(.grouped)
        .frame(width: 420)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var themeBinding: Binding<String> {
        Binding(
            get: { store.themeSelected ?? Themes.auto },
            set: { key in Task { await store.selectTheme(key) } }
        )
    }

    private func logOut() {
        let alert = NSAlert()
        if store.hasUnsyncedEdits {
            alert.messageText = "Log out with unsaved edits?"
            alert.informativeText = "Some edits haven't reached the server yet. Logging out now loses them."
        } else {
            alert.messageText = "Log out of oneweek?"
        }
        alert.addButton(withTitle: "Log Out")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        Task { await store.signOut() }
    }
}

struct SectionLabel: View {
    let text: String

    var body: some View {
        Text(text)
            .font(Typeface.semibold(12))
            .foregroundStyle(.secondary)
            .lineLimit(1)
    }
}
