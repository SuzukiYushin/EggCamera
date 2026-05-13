import Foundation

final class AppLogger {
    private(set) var entries: [LogEntry] = []
    private let fileURL: URL

    init(logDirectory: URL) {
        try? FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
        self.fileURL = logDirectory.appendingPathComponent("app.log")
    }

    func log(_ message: String) {
        let entry = LogEntry(message: message)
        entries.append(entry)
        if entries.count > 400 {
            entries.removeFirst(entries.count - 400)
        }
        let line = "[\(entry.timestamp.formatted(date: .numeric, time: .standard))] \(message)\n"
        if let data = line.data(using: .utf8) {
            if FileManager.default.fileExists(atPath: fileURL.path) {
                if let handle = try? FileHandle(forWritingTo: fileURL) {
                    _ = try? handle.seekToEnd()
                    try? handle.write(contentsOf: data)
                    try? handle.close()
                }
            } else {
                try? data.write(to: fileURL, options: .atomic)
            }
        }
        print("[EggCameraMac] \(message)")
    }
}
