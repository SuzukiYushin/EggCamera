import Foundation

struct RuntimeConfiguration: Codable {
    let iphoneHost: String?
    let iphonePort: Int
    let callbackHost: String?
    let callbackPort: UInt16
    let triggerPort: UInt16?
    let preferredWidth: Int?
    let preferredHeight: Int?
    let captureIntervalSeconds: Int
    let sendCaptureOnLaunch: Bool
    let outputWidth: Int?
    let outputHeight: Int?
    let centerCropToExactSize: Bool
    let receivedPhotosDirectory: String
    let logsDirectory: String

    static let `default` = RuntimeConfiguration(
        iphoneHost: nil,
        iphonePort: 8080,
        callbackHost: nil,
        callbackPort: 8081,
        triggerPort: nil,
        preferredWidth: 8064,
        preferredHeight: 6048,
        captureIntervalSeconds: 0,
        sendCaptureOnLaunch: true,
        outputWidth: nil,
        outputHeight: nil,
        centerCropToExactSize: false,
        receivedPhotosDirectory: "../data/raw",
        logsDirectory: "../data/logs/swift"
    )

    static func load(path: String = "config.json") -> RuntimeConfiguration {
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
        let fileURL = cwd.appendingPathComponent(path)

        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return .default
        }

        do {
            let data = try Data(contentsOf: fileURL)
            return try JSONDecoder().decode(RuntimeConfiguration.self, from: data)
        } catch {
            fputs("[EggCameraMac] failed to parse config.json: \(error.localizedDescription)\n", stderr)
            return .default
        }
    }

    var resolvedCallbackHost: String {
        if let callbackHost, !callbackHost.isEmpty {
            return callbackHost
        }
        let host = ProcessInfo.processInfo.hostName
        return host.contains(".") ? host : "\(host).local"
    }

    var resolvedReceivedPhotosDirectory: URL {
        resolve(path: receivedPhotosDirectory)
    }

    var resolvedLogsDirectory: URL {
        resolve(path: logsDirectory)
    }

    var outputSize: CGSize? {
        guard let outputWidth,
              let outputHeight,
              outputWidth > 0,
              outputHeight > 0 else {
            return nil
        }
        return CGSize(width: outputWidth, height: outputHeight)
    }

    private func resolve(path: String) -> URL {
        if (path as NSString).isAbsolutePath {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
        return cwd.appendingPathComponent(path, isDirectory: true)
    }
}
