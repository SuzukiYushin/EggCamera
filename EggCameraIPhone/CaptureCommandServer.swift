import Foundation
import Network

final class CaptureCommandServer {
    private let pipeline: CapturePipeline
    private let cameraController: CameraController
    private weak var logger: AppLogger?
    private let queue = DispatchQueue(label: "com.eggcamera.iphone.commandserver")
    private var listener: NWListener?

    let port: UInt16 = 8080

    init(pipeline: CapturePipeline, cameraController: CameraController, logger: AppLogger) {
        self.pipeline = pipeline
        self.cameraController = cameraController
        self.logger = logger
    }

    func start() throws {
        // USB(usbmuxd/iproxy)経由で届くよう、ループバックを含む全インターフェースで
        // 素のTCPを待受する。peer-to-peer/Bonjour広告は使わない（USB直結のため不要で、
        // loopbackに非バインドとなり usbmuxd から繋がらない原因になる）。
        let listener = try NWListener(using: .tcp, on: NWEndpoint.Port(rawValue: port)!)
        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection)
        }
        listener.start(queue: queue)
        self.listener = listener
        Task { @MainActor in
            self.logger?.log("Capture command server listening on :\(self.port) (plain TCP / USB-reachable)")
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(on: connection, accumulated: Data())
    }

    private func receive(on connection: NWConnection, accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            guard error == nil else {
                connection.cancel()
                return
            }

            var buffer = accumulated
            if let data { buffer.append(data) }

            if self.isCompleteRequest(buffer) || isComplete {
                self.route(buffer, on: connection)
            } else {
                self.receive(on: connection, accumulated: buffer)
            }
        }
    }

    private func route(_ data: Data, on connection: NWConnection) {
        let separator = Data([0x0D, 0x0A, 0x0D, 0x0A])
        guard let range = data.range(of: separator) else {
            send(status: 400, message: "Bad Request", on: connection)
            return
        }

        let header = String(data: data[..<range.lowerBound], encoding: .utf8) ?? ""
        let requestLine = header.components(separatedBy: "\r\n").first ?? ""

        // ウェイク: iPad のスタート押下で呼ばれ、撮影ページ前にカメラを温める
        if requestLine.hasPrefix("POST /wake") {
            cameraController.keepAwake()
            send(status: 200, message: "OK", on: connection)
            return
        }

        // ライブプレビュー: 最新フレームのJPEGを1枚返す（ブラウザがポーリング）
        if requestLine.hasPrefix("GET /frame") {
            cameraController.noteActivity()
            if let frame = cameraController.latestPreviewFrame() {
                sendJPEG(frame, on: connection)
            } else {
                send(status: 503, message: "No Frame", on: connection)
            }
            return
        }

        guard requestLine.hasPrefix("POST /capture") else {
            send(status: 404, message: "Not Found", on: connection)
            return
        }

        let body = Data(data[range.upperBound...])
        guard let command = try? JSONDecoder.shared.decode(CaptureCommand.self, from: body) else {
            send(status: 400, message: "Invalid JSON", on: connection)
            return
        }

        // USB(プル型): 撮影完了まで待ち、写真(UploadEnvelope JSON)をこのレスポンスで返す。
        Task {
            do {
                let payload = try await self.pipeline.performCapture(command: command)
                self.sendJSON(payload, on: connection)
            } catch {
                await MainActor.run {
                    self.logger?.log("Capture pipeline failed id=\(command.requestID) error=\(error.localizedDescription)")
                }
                self.send(status: 500, message: "Capture Failed", on: connection)
            }
        }
    }

    private func isCompleteRequest(_ data: Data) -> Bool {
        let separator = Data([0x0D, 0x0A, 0x0D, 0x0A])
        guard let range = data.range(of: separator) else { return false }

        let header = String(data: data[..<range.lowerBound], encoding: .utf8) ?? ""
        let contentLength = header
            .components(separatedBy: "\r\n")
            .first(where: { $0.lowercased().hasPrefix("content-length:") })
            .flatMap { line -> Int? in
                let value = line.split(separator: ":", maxSplits: 1).last?.trimmingCharacters(in: .whitespaces)
                return value.flatMap(Int.init)
            } ?? 0

        let bodyCount = data.count - range.upperBound
        return bodyCount >= contentLength
    }

    private func send(status: Int, message: String, on connection: NWConnection) {
        let header = [
            "HTTP/1.1 \(status) \(message)",
            "Content-Length: 0",
            "Connection: close",
            "", ""
        ].joined(separator: "\r\n")
        connection.send(content: Data(header.utf8), completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private func sendJSON(_ body: Data, on connection: NWConnection) {
        let header = [
            "HTTP/1.1 200 OK",
            "Content-Type: application/json",
            "Content-Length: \(body.count)",
            "Connection: close",
            "", ""
        ].joined(separator: "\r\n")
        var payload = Data(header.utf8)
        payload.append(body)
        connection.send(content: payload, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private func sendJPEG(_ body: Data, on connection: NWConnection) {
        let header = [
            "HTTP/1.1 200 OK",
            "Content-Type: image/jpeg",
            "Content-Length: \(body.count)",
            "Cache-Control: no-store",
            "Connection: close",
            "", ""
        ].joined(separator: "\r\n")
        var payload = Data(header.utf8)
        payload.append(body)
        connection.send(content: payload, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}

private extension JSONDecoder {
    static let shared: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}
