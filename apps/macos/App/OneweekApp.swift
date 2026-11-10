import AppKit
import OneweekKit
import SwiftUI
import UniformTypeIdentifiers
import WidgetKit

@main
struct OneweekApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var store = AppSetup.makeStore()
    @State private var ui = UIState()

    var body: some Scene {
        Window("oneweek", id: "main") {
            RootView()
                .environment(store)
                .environment(ui)
                .frame(minWidth: 1000, minHeight: 620)
                .onAppear { appDelegate.store = store }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1440, height: 900)
        .commands {
            CommandGroup(replacing: .appSettings) {
                Button("Settings…") { ui.sidebarOpen.toggle() }
                    .keyboardShortcut(",")
            }
            CommandGroup(replacing: .newItem) {
                Button("New Task") {
                    store.beginNewTask(in: Slot.days.first(where: store.isToday) ?? .general)
                }
                .keyboardShortcut("n")
            }
            CommandGroup(replacing: .undoRedo) {
                Button("Undo") { undo(redo: false) }.keyboardShortcut("z")
                Button("Redo") { undo(redo: true) }.keyboardShortcut("z", modifiers: [.command, .shift])
            }
            CommandMenu("Task") { taskCommands }
            CommandMenu("Week") {
                Button("Previous Week") { Task { await store.setWeekOffset(store.weekOffset - 1) } }
                    .keyboardShortcut("[")
                Button("Next Week") { Task { await store.setWeekOffset(store.weekOffset + 1) } }
                    .keyboardShortcut("]")
                Button("This Week") { Task { await store.setWeekOffset(0) } }
                    .keyboardShortcut("t")
            }
        }
    }

    /// Acts on the row with the caret.
    @ViewBuilder
    private var taskCommands: some View {
        let id = store.activeRowId
        let row = id.flatMap(store.row)
        Button(row?.checked == true ? "Mark as Not Done" : "Mark as Done") { id.map(store.toggleChecked) }
            .keyboardShortcut(.return)
            .disabled(id == nil)
        Button(row?.subtask == true ? "Make Task" : "Make Subtask") { id.map { store.indent($0) } }
            .disabled(id == nil)
        Button(row?.isMain == true ? "Remove from Main Thing" : "Make Main Thing") { id.map(store.toggleMainThing) }
            .keyboardShortcut("m", modifiers: [.command, .shift])
            .disabled(id == nil)
        Divider()
        Button("Delete Task") { id.map(store.delete) }
            .keyboardShortcut(.delete)
            .disabled(id == nil)
    }

    /// In a text field ⌘Z is the field's own undo; elsewhere it brings back a deleted task.
    private func undo(redo: Bool) {
        if let field = NSApp.keyWindow?.firstResponder as? NSTextView, let manager = field.undoManager {
            if redo { manager.redo() } else { manager.undo() }
        } else if !redo {
            store.undoDelete()
        }
    }
}

/// Window state that the menu bar shares with the views.
@MainActor
@Observable
final class UIState {
    var sidebarOpen = false
}

/// Quitting waits for the last edits to be saved, but never for long: they are on disk first.
final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var store: BoardStore?
    private var replied = false

    @MainActor
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let store else { return .terminateNow }
        Task { @MainActor in
            await store.appWillResignActive()
            self.reply(sender)
        }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(3))
            self.reply(sender)
        }
        return .terminateLater
    }

    @MainActor
    private func reply(_ sender: NSApplication) {
        guard !replied else { return }
        replied = true
        sender.reply(toApplicationShouldTerminate: true)
    }
}

enum AppSetup {
    @MainActor
    static func makeStore() -> BoardStore {
        let root = SharedContainer.url
        let backend = SupabaseBackend(vault: SessionVault(directory: root))
        let store = BoardStore(backend: backend, local: LocalStore(root: root))
        store.onSnapshotWritten = { WidgetCenter.shared.reloadAllTimelines() }
        return store
    }
}

extension UTType {
    static let oneweekRow = UTType(exportedAs: "ru.nikitanova.oneweek.task-row")
}

extension NSPasteboard.PasteboardType {
    static let oneweekRow = NSPasteboard.PasteboardType(UTType.oneweekRow.identifier)
}

/// The system font, sized like the site (1em there is 16px).
enum Typeface {
    static let bodySize: CGFloat = 15
    static let body = NSFont.systemFont(ofSize: bodySize)
    /// One line of task text.
    static let lineHeight = NSLayoutManager().defaultLineHeight(for: body)

    static func regular(_ size: CGFloat) -> Font { .system(size: size) }
    static func semibold(_ size: CGFloat) -> Font { .system(size: size, weight: .semibold) }
}

private struct ThemeKey: EnvironmentKey {
    static let defaultValue = ThemeColors(text: "#3a3f48", background: "#eceef2")
}

extension EnvironmentValues {
    var theme: ThemeColors {
        get { self[ThemeKey.self] }
        set { self[ThemeKey.self] = newValue }
    }
}

extension ThemeColors {
    /// The site's `--color-border`: text at 20%.
    var hairline: Color { textColor.opacity(0.2) }
}

extension Animation {
    /// Movement that respects "Reduce motion".
    static func calm(_ base: Animation, reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : base
    }
}
