import AppKit
import OneweekKit
import SwiftUI

/// The editable text of a row: an `NSTextView` that SwiftUI sizes and never replaces.
///
/// The row keeps the same text view for as long as it exists, so nothing the
/// store does can take the caret away. While it has focus the view's string is
/// the truth: updates from the store only land after the user leaves.
struct TaskTextView: NSViewRepresentable {
    let rowId: UUID
    let text: String
    let textColor: NSColor
    let completed: Bool
    let focusRequest: Int?
    let theme: ThemeColors
    let store: BoardStore

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> RowTextView {
        let view = RowTextView(usingTextLayoutManager: false)
        view.delegate = context.coordinator
        view.rowId = rowId
        view.store = store
        view.isRichText = false
        view.importsGraphics = false
        view.allowsUndo = true
        view.drawsBackground = false
        view.isHorizontallyResizable = false
        view.isVerticallyResizable = false
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.widthTracksTextView = false
        view.textContainer?.heightTracksTextView = false
        view.textContainer?.containerSize = NSSize(width: 200, height: CGFloat.greatestFiniteMagnitude)
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false
        view.isAutomaticTextReplacementEnabled = false
        view.isContinuousSpellCheckingEnabled = false
        view.font = Typeface.body
        view.string = text
        applyStyle(to: view)
        return view
    }

    func updateNSView(_ view: RowTextView, context: Context) {
        context.coordinator.parent = self
        if !view.isEditingRow, view.string != text {
            view.string = text
        }
        applyStyle(to: view)
        if let focusRequest, context.coordinator.handledFocus != focusRequest {
            context.coordinator.handledFocus = focusRequest
            view.takeFocus(whenInWindow: true)
            store.focusHandled(focusRequest)
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: RowTextView, context: Context) -> CGSize? {
        let width = min(proposal.width ?? 240, 4000)
        guard width > 1 else { return nil }
        return CGSize(width: width, height: TextMeasure.height(of: nsView.string, width: width))
    }

    private func applyStyle(to view: RowTextView) {
        let color = completed ? textColor.withAlphaComponent(0.45) : textColor
        var attributes: [NSAttributedString.Key: Any] = [.font: Typeface.body, .foregroundColor: color]
        if completed { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
        view.typingAttributes = attributes
        view.theme = theme
        view.insertionPointColor = textColor
        view.selectedTextAttributes = [.backgroundColor: textColor.withAlphaComponent(0.2)]
        // Marked text is the input method's; restyling it would end the composition.
        guard !view.hasMarkedText(), let storage = view.textStorage else { return }
        let full = NSRange(location: 0, length: storage.length)
        var same = storage.length == 0
        if !same {
            var range = NSRange()
            let current = storage.attributes(at: 0, effectiveRange: &range)
            same = NSEqualRanges(range, full)
                && (current[.foregroundColor] as? NSColor) == color
                && (current[.strikethroughStyle] as? Int) == attributes[.strikethroughStyle] as? Int
                && (current[.font] as? NSFont) == Typeface.body
        }
        if !same { storage.setAttributes(attributes, range: full) }
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: TaskTextView
        var handledFocus: Int?

        init(_ parent: TaskTextView) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? RowTextView else { return }
            parent.store.updateText(parent.rowId, view.string)
        }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            let store = parent.store
            let id = parent.rowId
            switch selector {
            case #selector(NSResponder.insertNewline(_:)):
                if NSApp.currentEvent?.modifierFlags.contains(.shift) == true {
                    textView.insertNewlineIgnoringFieldEditor(nil)
                    return true
                }
                if !store.enter(id, text: textView.string) {
                    textView.window?.makeFirstResponder(nil)
                }
                return true
            case #selector(NSResponder.insertTab(_:)):
                store.indent(id, outdent: false)
                return true
            case #selector(NSResponder.insertBacktab(_:)):
                store.indent(id, outdent: true)
                return true
            case #selector(NSResponder.cancelOperation(_:)):
                textView.window?.makeFirstResponder(nil)
                return true
            default:
                return false
            }
        }
    }
}

final class RowTextView: NSTextView {
    var rowId = UUID()
    weak var store: BoardStore?
    /// Between gaining and losing first responder. An app switch doesn't lose it.
    private(set) var isEditingRow = false
    private var isDraggingRow = false
    private var wantsFocusInWindow = false
    var theme: ThemeColors?

    override var mouseDownCanMoveWindow: Bool { false }

    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted {
            isEditingRow = true
            store?.rowBeganEditing(rowId)
        }
        return accepted
    }

    override func resignFirstResponder() -> Bool {
        let accepted = super.resignFirstResponder()
        if accepted, isEditingRow {
            isEditingRow = false
            store?.rowEndedEditing(rowId)
            showStoredText()
        }
        return accepted
    }

    /// Leaving a row may tidy its text (hh:mm moves to the front).
    private func showStoredText() {
        guard let stored = store?.text(of: rowId), stored != string, let storage = textStorage else { return }
        let attributes = typingAttributes
        string = stored
        storage.setAttributes(attributes, range: NSRange(location: 0, length: storage.length))
    }

    /// A row just created isn't in the window yet: the caret lands when it arrives.
    func takeFocus(whenInWindow: Bool) {
        guard window != nil else {
            wantsFocusInWindow = whenInWindow
            return
        }
        DispatchQueue.main.async { [self] in
            guard let window else {
                wantsFocusInWindow = true
                return
            }
            window.makeFirstResponder(self)
            setSelectedRange(NSRange(location: (string as NSString).length, length: 0))
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil, wantsFocusInWindow {
            wantsFocusInWindow = false
            takeFocus(whenInWindow: false)
        }
    }

    /// The wrap width comes only from the real frame. SwiftUI measures rows at
    /// trial widths too; those go to `TextMeasure` and never touch this view.
    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        guard let container = textContainer, container.containerSize.width != newSize.width else { return }
        container.containerSize = NSSize(width: newSize.width, height: .greatestFiniteMagnitude)
    }

    /// Task actions first, then the usual text ones.
    override func menu(for event: NSEvent) -> NSMenu? {
        guard let store, let row = store.row(rowId) else { return super.menu(for: event) }
        let id = rowId
        // Right-clicking a row puts the caret in it, so the text commands act on this row.
        if window?.firstResponder !== self {
            window?.makeFirstResponder(self)
            setSelectedRange(NSRange(location: characterIndexForInsertion(at: convert(event.locationInWindow, from: nil)), length: 0))
        }
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.addItem(ClosureMenuItem(row.checked ? "Mark as Not Done" : "Mark as Done") { store.toggleChecked(id) })

        let colors = NSMenu()
        for color in [nil] + TaskColors.palette.map(Optional.some) {
            let item = ClosureMenuItem(color == nil ? "No Color" : "") { store.setColor(id, color) }
            item.state = row.color == color ? .on : .off
            if let color, let fill = theme?.highlightHex(color) { item.image = Self.swatch(NSColor(hex: fill)) }
            colors.addItem(item)
        }
        let colorItem = NSMenuItem(title: "Color", action: nil, keyEquivalent: "")
        colorItem.submenu = colors
        menu.addItem(colorItem)

        menu.addItem(ClosureMenuItem(row.subtask ? "Make Task" : "Make Subtask") { store.indent(id) })
        menu.addItem(ClosureMenuItem(row.isMain ? "Remove from Main Thing" : "Make Main Thing") { store.toggleMainThing(id) })
        menu.addItem(.separator())
        menu.addItem(ClosureMenuItem("Delete Task") { store.delete(id) })
        menu.addItem(.separator())
        menu.addItem(ClosureMenuItem("Cut", key: "x") { [weak self] in self?.cutSelectionOrTask() })
        menu.addItem(ClosureMenuItem("Copy", key: "c") { [weak self] in self?.copySelectionOrTask() })
        let paste = ClosureMenuItem("Paste", key: "v") { [weak self] in self?.paste(nil) }
        paste.isEnabled = NSPasteboard.general.string(forType: .string) != nil
        menu.addItem(paste)
        return menu
    }

    /// With nothing selected, Cut and Copy take the whole task.
    private func cutSelectionOrTask() {
        if selectedRange().length == 0 { selectAll(nil) }
        cut(nil)
    }

    private func copySelectionOrTask() {
        guard selectedRange().length == 0 else { return copy(nil) }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(string, forType: .string)
    }

    private static func swatch(_ color: NSColor) -> NSImage {
        NSImage(size: NSSize(width: 14, height: 14), flipped: false) { rect in
            color.setFill()
            NSBezierPath(roundedRect: rect.insetBy(dx: 1, dy: 1), xRadius: 3, yRadius: 3).fill()
            return true
        }
    }

    /// Several lines become sibling tasks, like on the web.
    override func paste(_ sender: Any?) {
        let text = NSPasteboard.general.string(forType: .string) ?? ""
        guard text.contains(where: \.isNewline), let store else {
            pasteAsPlainText(sender)
            return
        }
        let lines = text.components(separatedBy: .newlines)
        store.updateText(rowId, string)
        // The first line continues whatever is around the caret.
        let ns = string as NSString
        let range = selectedRange()
        let first = ns.substring(to: range.location) + (lines.first ?? "") + ns.substring(from: NSMaxRange(range))
        string = first
        store.paste(rowId, lines: [first] + lines.dropFirst())
    }

    // MARK: Click or drag

    /// A press on a row that isn't being edited may be a click into it or the start of a drag.
    override func mouseDown(with event: NSEvent) {
        guard let window, window.firstResponder !== self else {
            super.mouseDown(with: event)
            return
        }
        let start = event.locationInWindow
        var isDrag = false
        window.trackEvents(matching: [.leftMouseDragged, .leftMouseUp], timeout: .greatestFiniteMagnitude, mode: .eventTracking) { next, stop in
            guard let next, next.type == .leftMouseDragged else {
                stop.pointee = true
                return
            }
            if hypot(next.locationInWindow.x - start.x, next.locationInWindow.y - start.y) > 4 {
                isDrag = true
                stop.pointee = true
            }
        }
        if isDrag {
            beginRowDrag(event)
        } else {
            window.makeFirstResponder(self)
            setSelectedRange(NSRange(location: characterIndexForInsertion(at: convert(event.locationInWindow, from: nil)), length: 0))
        }
    }

    private func beginRowDrag(_ event: NSEvent) {
        guard let store else { return }
        let item = NSPasteboardItem()
        item.setString(rowId.uuidString, forType: .oneweekRow)
        let dragging = NSDraggingItem(pasteboardWriter: item)
        let image = NSImage(size: bounds.size)
        if let rep = bitmapImageRepForCachingDisplay(in: bounds) {
            cacheDisplay(in: bounds, to: rep)
            image.addRepresentation(rep)
        }
        dragging.setDraggingFrame(bounds, contents: image)
        store.beginDragging(rowId)
        isDraggingRow = true
        beginDraggingSession(with: [dragging], event: event, source: self)
    }

    override func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        isDraggingRow ? .move : super.draggingSession(session, sourceOperationMaskFor: context)
    }

    override func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
        guard isDraggingRow else {
            super.draggingSession(session, endedAt: screenPoint, operation: operation)
            return
        }
        isDraggingRow = false
        store?.endDragging()
    }
}

/// Row height at a given width, on layout objects shared by no text view.
@MainActor
private enum TextMeasure {
    private static let storage = NSTextStorage()
    private static let manager = NSLayoutManager()
    private static let container = NSTextContainer()
    private static let ready: Void = {
        container.lineFragmentPadding = 0
        manager.addTextContainer(container)
        storage.addLayoutManager(manager)
    }()

    static func height(of text: String, width: CGFloat) -> CGFloat {
        _ = ready
        container.size = NSSize(width: width, height: .greatestFiniteMagnitude)
        storage.setAttributedString(NSAttributedString(string: text, attributes: [.font: Typeface.body]))
        manager.ensureLayout(for: container)
        return ceil(max(manager.usedRect(for: container).height, manager.defaultLineHeight(for: Typeface.body)))
    }
}

/// A menu item that runs a closure.
private final class ClosureMenuItem: NSMenuItem {
    private let run: () -> Void

    /// `key` only shows the usual ⌘ shortcut next to the title.
    init(_ title: String, key: String = "", run: @escaping () -> Void) {
        self.run = run
        super.init(title: title, action: #selector(fire), keyEquivalent: key)
        target = self
    }

    @available(*, unavailable)
    required init(coder: NSCoder) { fatalError("not used") }

    @objc private func fire() { run() }
}

/// The toolbar's grip: dragging it moves the row, whether or not it is being edited.
struct DragHandle: NSViewRepresentable {
    let rowId: UUID
    let store: BoardStore
    let tint: NSColor

    func makeNSView(context: Context) -> DragHandleView {
        let view = DragHandleView()
        view.store = store
        return view
    }

    func updateNSView(_ view: DragHandleView, context: Context) {
        view.rowId = rowId
        view.icon.contentTintColor = tint
    }
}

final class DragHandleView: NSView, NSDraggingSource {
    var rowId = UUID()
    weak var store: BoardStore?
    let icon = NSImageView()
    private var hovering = false {
        didSet { animator().alphaValue = hovering ? 1 : 0.65 }
    }

    override var mouseDownCanMoveWindow: Bool { false }

    override init(frame: NSRect) {
        super.init(frame: frame)
        alphaValue = 0.65
        wantsLayer = true
        icon.image = NSImage(named: "drag-handle")
        icon.image?.isTemplate = true
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.translatesAutoresizingMaskIntoConstraints = false
        addSubview(icon)
        NSLayoutConstraint.activate([
            icon.centerXAnchor.constraint(equalTo: centerXAnchor),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            icon.widthAnchor.constraint(equalTo: widthAnchor, multiplier: 0.54),
            icon.heightAnchor.constraint(equalTo: heightAnchor, multiplier: 0.54),
        ])
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .openHand)
    }

    /// Claims the press, so the drag that follows comes here and not to the window.
    override func mouseDown(with event: NSEvent) {}

    override func mouseDragged(with event: NSEvent) {
        guard let store else { return }
        let item = NSPasteboardItem()
        item.setString(rowId.uuidString, forType: .oneweekRow)
        let dragging = NSDraggingItem(pasteboardWriter: item)
        dragging.setDraggingFrame(bounds, contents: icon.image ?? NSImage())
        store.beginDragging(rowId)
        beginDraggingSession(with: [dragging], event: event, source: self)
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        .move
    }

    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
        store?.endDragging()
    }
}
