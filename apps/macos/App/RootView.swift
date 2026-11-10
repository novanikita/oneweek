import AppKit
import OneweekKit
import SwiftUI

struct RootView: View {
    @Environment(BoardStore.self) private var store
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let theme = store.colors(systemIsDark: colorScheme == .dark)
        ZStack {
            theme.backgroundColor.ignoresSafeArea()
            switch store.phase {
            case .loading: Color.clear
            case .signedOut: SignInView()
            case .ready: BoardScreen().ignoresSafeArea(.container, edges: .top)
            }
        }
        .environment(\.theme, theme)
        .foregroundStyle(theme.textColor)
        .tint(theme.textColor)
        .font(Typeface.regular(Typeface.bodySize))
        .preferredColorScheme(themeOverride(theme))
        .animation(.easeOut(duration: 0.25), value: theme)
        .task { await store.start() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await store.appBecameActive() }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.willResignActiveNotification)) { _ in
            Task { await store.appWillResignActive() }
        }
    }

    /// "Match device" keeps following the system; a fixed theme sets the controls to match.
    private func themeOverride(_ theme: ThemeColors) -> ColorScheme? {
        guard let key = store.themeSelected, key != Themes.auto else { return nil }
        return theme.usesDarkHighlights ? .dark : .light
    }
}

// MARK: Sign in

struct SignInView: View {
    @Environment(BoardStore.self) private var store
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var email = ""
    @State private var password = ""
    @State private var message: String?
    @State private var busy = false
    @State private var shown = false
    @FocusState private var focus: Field?

    private enum Field { case email, password }

    private var canSubmit: Bool { !busy && !email.isEmpty && !password.isEmpty }

    var body: some View {
        VStack(spacing: 13) {
            Text("Sign in")
                .font(Typeface.semibold(17))
            Text("Your tasks are stored securely and sync across your devices. Use the account from the website.")
                .font(Typeface.regular(14))
                .opacity(0.8)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            input(.email) { TextField("email", text: $email).textContentType(.username) }
            input(.password) { SecureField("password", text: $password).textContentType(.password) }
            Button(action: submit) {
                Text(busy ? "signing in…" : "sign in")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(theme.hairline, lineWidth: 1))
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressStyle(scale: 0.98))
            .disabled(!canSubmit)
            .opacity(canSubmit || busy ? 1 : 0.55)
            .padding(.top, 4)
            if let message {
                Text(message)
                    .font(Typeface.regular(13))
                    .opacity(0.8)
                    .transition(.opacity)
            }
        }
        .padding(EdgeInsets(top: 26, leading: 22, bottom: 22, trailing: 22))
        .frame(width: 340)
        .background(theme.backgroundColor, in: RoundedRectangle(cornerRadius: 13))
        .overlay(RoundedRectangle(cornerRadius: 13).strokeBorder(theme.hairline, lineWidth: 1))
        .shadow(color: .black.opacity(0.18), radius: 20, y: 16)
        .scaleEffect(shown ? 1 : 0.96)
        .opacity(shown ? 1 : 0)
        .animation(.calm(.timingCurve(0.22, 1, 0.36, 1, duration: 0.24), reduceMotion: reduceMotion), value: shown)
        .animation(.easeOut(duration: 0.2), value: message)
        .onSubmit(submit)
        .onAppear {
            shown = true
            focus = .email
        }
    }

    private func input<Content: View>(_ field: Field, @ViewBuilder _ content: () -> Content) -> some View {
        content()
            .textFieldStyle(.plain)
            .focused($focus, equals: field)
            .padding(.horizontal, 11)
            .padding(.vertical, 9)
            .overlay(
                RoundedRectangle(cornerRadius: 7)
                    .strokeBorder(focus == field ? theme.textColor : theme.hairline, lineWidth: 1)
            )
            .animation(.easeOut(duration: 0.12), value: focus)
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

// MARK: Board

struct BoardScreen: View {
    @Environment(BoardStore.self) private var store
    @Environment(UIState.self) private var ui
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The board fades in on a week switch, as on the site.
    @State private var boardOpacity = 1.0
    /// Full screen hides the title bar, so the header moves into the window.
    @State private var fullScreen = false

    var body: some View {
        ZStack(alignment: .topLeading) {
            VStack(spacing: 0) {
                if fullScreen {
                    header
                        .padding(.leading, 16)
                        .frame(height: TitlebarContent<AnyView>.height)
                } else {
                    // The header itself lives in the title bar, above everything here.
                    TitlebarContent(content: header)
                        .frame(height: TitlebarContent<AnyView>.height)
                }
                WeekBoard()
                    .opacity(boardOpacity)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
            }

            toasts
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                .allowsHitTesting(false)

            if ui.sidebarOpen {
                // A button, not a tap gesture: it closes the panel even on the click that activates the window.
                Button { ui.sidebarOpen = false } label: {
                    Color.black.opacity(0.25).ignoresSafeArea()
                }
                .buttonStyle(.plain)
                .ignoresSafeArea()
                .transition(.opacity)
                SidebarView()
                    .transition(.move(edge: .leading))
            }
        }
        .animation(.calm(.easeInOut(duration: 0.3), reduceMotion: reduceMotion), value: ui.sidebarOpen)
        .onAppear { fullScreen = NSApp.windows.contains { $0.styleMask.contains(.fullScreen) } }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didEnterFullScreenNotification)) { _ in fullScreen = true }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.willExitFullScreenNotification)) { _ in fullScreen = false }
        .onChange(of: store.weekOffset) {
            guard !reduceMotion else { return }
            boardOpacity = 0
            withAnimation(.easeOut(duration: 0.26)) { boardOpacity = 1 }
        }
    }

    /// The title bar is its own window layer: hand it what the header reads.
    private var header: some View {
        HeaderBar()
            .environment(store)
            .environment(ui)
            .environment(\.theme, theme)
            .foregroundStyle(theme.textColor)
            .tint(theme.textColor)
            .font(Typeface.regular(Typeface.bodySize))
    }

    private var toasts: some View {
        VStack(spacing: 10) {
            if let toast = store.toast {
                ToastPill(text: toast, kind: store.toastKind)
                    .transition(.opacity.combined(with: .offset(y: 8)))
            }
            if store.isOffline {
                ToastPill(text: "No connection right now, but your tasks are still saved locally.", kind: .notice)
                    .transition(.opacity.combined(with: .offset(y: 8)))
            }
        }
        .padding(.bottom, 20)
        .animation(.easeOut(duration: 0.2), value: store.toast)
        .animation(.easeOut(duration: 0.2), value: store.isOffline)
    }
}

struct HeaderBar: View {
    @Environment(BoardStore.self) private var store
    @Environment(UIState.self) private var ui

    var body: some View {
        ZStack {
            WindowDragArea()
            HStack {
                IconButton(glyph: "bar-icon", size: 17, help: "Settings and weeks") { ui.sidebarOpen.toggle() }
                Spacer()
                WorkspaceTabs().opacity(dimmed)
            }
            weekNav.opacity(dimmed)
        }
        .animation(.easeInOut(duration: 0.3), value: ui.sidebarOpen)
        .padding(.trailing, 16)
        .frame(maxHeight: .infinity)
    }

    /// The settings panel dims the board; the header sits above that layer.
    private var dimmed: Double { ui.sidebarOpen ? 0.45 : 1 }

    /// Fixed widths: the arrows never move under the pointer. "now" has its own
    /// slot on the right, balanced by an empty one on the left.
    private var weekNav: some View {
        HStack(spacing: 10) {
            Color.clear.frame(width: Self.nowSlot, height: 1)
            IconButton(glyph: "arrow", size: 15, help: "Previous week") {
                Task { await store.setWeekOffset(store.weekOffset - 1) }
            }
            Text(WeekCalendar.label(weekOffset: store.weekOffset, now: store.today))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(width: 200)
                .contentTransition(.opacity)
                .animation(.easeOut(duration: 0.2), value: store.weekOffset)
            IconButton(glyph: "arrow", size: 15, flipped: true, help: "Next week") {
                Task { await store.setWeekOffset(store.weekOffset + 1) }
            }
            ZStack(alignment: .leading) {
                if store.weekOffset != 0 {
                    OutlineButton(horizontalPadding: 6, action: { Task { await store.setWeekOffset(0) } }) {
                        Text("now")
                    }
                    .fixedSize()
                    .transition(.opacity)
                }
            }
            .frame(width: Self.nowSlot, alignment: .leading)
            .animation(.easeOut(duration: 0.15), value: store.weekOffset == 0)
        }
    }

    private static let nowSlot: CGFloat = 52
}

/// "+" and one bordered uppercase tab per workspace, as on the site.
struct WorkspaceTabs: View {
    @Environment(BoardStore.self) private var store
    @State private var naming: Naming?
    @State private var nameDraft = ""
    @State private var deleting: Workspace?

    private struct Naming: Identifiable {
        var id: String { workspace?.id ?? "new" }
        var workspace: Workspace?
    }

    var body: some View {
        HStack(spacing: 6) {
            WorkspaceTab(active: false, help: "New workspace", action: { startNaming(nil) }) {
                Glyph(name: "plus").frame(width: 10, height: 10)
            }
            ForEach(store.workspaces) { workspace in
                WorkspaceTab(active: workspace.id == store.activeWorkspaceId, help: nil) {
                    Task { await store.selectWorkspace(workspace.id) }
                } label: {
                    Text(workspace.name.uppercased())
                        .font(Typeface.semibold(11))
                        .tracking(0.9)
                        .lineLimit(1)
                }
                .contextMenu {
                    Button("Rename…") { startNaming(workspace) }
                    if !workspace.isDefault {
                        Button("Delete…", role: .destructive) { deleting = workspace }
                    }
                }
            }
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

    private func startNaming(_ workspace: Workspace?) {
        nameDraft = workspace?.name ?? ""
        naming = Naming(workspace: workspace)
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

struct WorkspaceTab<Label: View>: View {
    @Environment(\.theme) private var theme
    let active: Bool
    let help: String?
    let action: () -> Void
    @ViewBuilder let label: () -> Label
    @State private var hovering = false

    var body: some View {
        let strong = active || hovering
        Button(action: action) {
            label()
                .opacity(strong ? 1 : 0.7)
                .padding(.horizontal, 10)
                .frame(minWidth: 26, minHeight: 26)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(theme.textColor.opacity(strong ? 0.55 : 0.35), lineWidth: 1)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle(scale: 0.95))
        .help(help ?? "")
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: strong)
    }
}

// MARK: Sidebar

/// The site's settings panel: workspaces, themes, weeks, account.
struct SidebarView: View {
    @Environment(BoardStore.self) private var store
    @Environment(UIState.self) private var ui
    @Environment(\.theme) private var theme
    @State private var naming: Workspace?
    @State private var creating = false
    @State private var nameDraft = ""
    @State private var deleting: Workspace?

    private static let pastWeeks = 12

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Settings").font(Typeface.semibold(15))
                Spacer()
                IconButton(glyph: "cross", size: 12, help: "Close") { ui.sidebarOpen = false }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(.top, TitlebarContent<AnyView>.height + 4)
            .padding(.bottom, 8)

            section("Workspaces") {
                ForEach(store.workspaces) { workspace in workspaceRow(workspace) }
                SidebarRow(active: false, action: {
                    nameDraft = ""
                    creating = true
                }) {
                    Text("+ new workspace").opacity(0.6)
                }
            }

            section("Themes", divider: true) {
                Picker("", selection: themeBinding) {
                    ForEach(Themes.options(custom: store.customThemes)) { Text($0.name).tag($0.id) }
                }
                .labelsHidden()
                .fixedSize()
            }

            section("Weeks", divider: false) {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 0) {
                        ForEach(Array(stride(from: 1, through: -Self.pastWeeks, by: -1)), id: \.self) { weekRow($0) }
                    }
                }
            }
            .padding(.top, 18)
            .frame(maxHeight: .infinity, alignment: .top)

            VStack(alignment: .leading, spacing: 8) {
                Text("Signed in as \(store.email ?? "")")
                    .font(Typeface.regular(14))
                    .opacity(0.92)
                    .lineLimit(1)
                    .truncationMode(.middle)
                OutlineButton(horizontalPadding: 10, height: 28, action: logOut) { Text("Logout") }
            }
            .padding(.top, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .top) { Hairline(.horizontal) }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 16)
        .frame(width: 344)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(theme.backgroundColor)
        .overlay(alignment: .trailing) { Hairline(.vertical) }
        .alert(creating ? "New workspace" : "Rename workspace", isPresented: namingShown) {
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

    private func section<Content: View>(_ title: String, divider: Bool = false, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(Typeface.semibold(14))
            content()
        }
        .padding(.top, divider ? 10 : 6)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) { if divider { Hairline(.horizontal) } }
    }

    private func workspaceRow(_ workspace: Workspace) -> some View {
        let active = workspace.id == store.activeWorkspaceId
        return SidebarRow(active: active, action: { Task { await store.selectWorkspace(workspace.id) } }) {
            HStack {
                Text(workspace.name).lineLimit(1)
                Spacer(minLength: 6)
                Menu {
                    Button("Rename…") {
                        nameDraft = workspace.name
                        naming = workspace
                    }
                    if !workspace.isDefault {
                        Button("Delete…", role: .destructive) { deleting = workspace }
                    }
                } label: {
                    Image(systemName: "ellipsis").opacity(0.45)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
            }
        }
    }

    private func weekRow(_ offset: Int) -> some View {
        SidebarRow(active: offset == store.weekOffset, action: { Task { await store.setWeekOffset(offset) } }) {
            HStack(alignment: .firstTextBaseline) {
                Text(WeekCalendar.rangeLabel(weekOffset: offset, now: store.today)).lineLimit(1)
                Spacer(minLength: 8)
                if let tag = tag(offset) {
                    Text(tag).opacity(offset == store.weekOffset ? 0.55 : 0.45)
                }
            }
        }
    }

    private func tag(_ offset: Int) -> String? {
        switch offset {
        case 0: "now"
        case 1: "next week"
        case -1: "last week"
        default: nil
        }
    }

    private var themeBinding: Binding<String> {
        Binding(
            get: { store.themeSelected ?? Themes.auto },
            set: { key in Task { await store.selectTheme(key) } }
        )
    }

    private var namingShown: Binding<Bool> {
        Binding(get: { naming != nil || creating }, set: { if !$0 { naming = nil; creating = false } })
    }

    private var deletingShown: Binding<Bool> {
        Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
    }

    private func saveName() {
        let target = naming
        let isNew = creating
        naming = nil
        creating = false
        Task {
            if isNew {
                await store.createWorkspace(named: nameDraft)
            } else if let target {
                await store.renameWorkspace(target.id, to: nameDraft)
            }
        }
    }

    private func logOut() {
        if store.hasUnsyncedEdits {
            let alert = NSAlert()
            alert.messageText = "Log out with unsaved edits?"
            alert.informativeText = "Some edits haven't reached the server yet. Logging out now loses them."
            alert.addButton(withTitle: "Log Out")
            alert.addButton(withTitle: "Cancel")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
        }
        ui.sidebarOpen = false
        Task { await store.signOut() }
    }
}

/// A clickable line in the sidebar; the active one is semibold.
struct SidebarRow<Content: View>: View {
    @Environment(\.theme) private var theme
    let active: Bool
    let action: () -> Void
    @ViewBuilder let content: () -> Content
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            content()
                .font(Typeface.regular(14).weight(active ? .semibold : .regular))
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(hovering ? theme.textColor.opacity(0.06) : .clear, in: RoundedRectangle(cornerRadius: 6))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, -8)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
    }
}
