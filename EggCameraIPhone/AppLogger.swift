import Foundation

@MainActor
final class AppLogger: ObservableObject {
    @Published private(set) var entries: [LogEntry] = []
    private let fileURL: URL = {
        let base = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first!
        let dir = base.appendingPathComponent("Logs", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("app.log")
    }()

    func log(_ message: String) {
        let entry = LogEntry(message: message)
        entries.append(entry)
        if entries.count > 300 {
            entries.removeFirst(entries.count - 300)
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
        print("[EggCameraIPhone] \(message)")
    }
}
