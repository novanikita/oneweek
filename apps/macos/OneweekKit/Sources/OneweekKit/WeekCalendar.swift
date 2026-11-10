import Foundation

/// Weeks run Monday to Sunday in local time; dates in the database are local `yyyy-MM-dd`.
public enum WeekCalendar {
    public static let dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar
    }

    /// Local midnight of the Monday of the week containing `date`, shifted by whole weeks.
    public static func monday(of date: Date, offset: Int = 0) -> Date {
        let cal = calendar
        let start = cal.startOfDay(for: date)
        let weekday = cal.component(.weekday, from: start) // Sunday == 1
        let sinceMonday = (weekday + 5) % 7
        return cal.date(byAdding: .day, value: offset * 7 - sinceMonday, to: start)!
    }

    public static func addingDays(_ days: Int, to date: Date) -> Date {
        calendar.date(byAdding: .day, value: days, to: date)!
    }

    public static func iso(_ date: Date) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)
    }

    public static func dayOfMonth(_ date: Date) -> Int {
        calendar.component(.day, from: date)
    }

    public static func isSameDay(_ a: Date, _ b: Date) -> Bool {
        calendar.isDate(a, inSameDayAs: b)
    }

    public static func startOfNextDay(after date: Date) -> Date {
        calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: date))!
    }

    public static func address(of slot: Slot, weekOffset: Int, now: Date) -> ListAddress {
        switch slot {
        case .general:
            return ListAddress(kind: .general, date: iso(monday(of: now, offset: weekOffset)))
        case .nextWeek:
            return ListAddress(kind: .general, date: iso(monday(of: now, offset: weekOffset + 1)))
        default:
            let day = addingDays(slot.dayIndex!, to: monday(of: now, offset: weekOffset))
            return ListAddress(kind: .daily, dayName: slot.dayName, date: iso(day))
        }
    }

    public static func date(of slot: Slot, weekOffset: Int, now: Date) -> Date? {
        guard let index = slot.dayIndex else { return nil }
        return addingDays(index, to: monday(of: now, offset: weekOffset))
    }

    private static let monthNames = [
        "january", "february", "march", "april", "may", "june", "july",
        "august", "september", "october", "november", "december",
    ]

    /// "9 november — 15 november".
    public static func rangeLabel(weekOffset: Int, now: Date) -> String {
        let cal = calendar
        let start = monday(of: now, offset: weekOffset)
        let end = addingDays(6, to: start)
        let startMonth = monthNames[cal.component(.month, from: start) - 1]
        let endMonth = monthNames[cal.component(.month, from: end) - 1]
        return "\(dayOfMonth(start)) \(startMonth) — \(dayOfMonth(end)) \(endMonth)"
    }

    /// "this week", "next week", "last week", or the dates.
    public static func label(weekOffset: Int, now: Date) -> String {
        switch weekOffset {
        case 0: return "this week"
        case 1: return "next week"
        case -1: return "last week"
        default: return rangeLabel(weekOffset: weekOffset, now: now)
        }
    }
}
