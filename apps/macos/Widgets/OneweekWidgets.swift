import AppIntents
import OneweekKit
import SwiftUI
import WidgetKit

@main
struct OneweekWidgetBundle: WidgetBundle {
    var body: some Widget {
        DayWidget()
        WeekWidget()
    }
}
