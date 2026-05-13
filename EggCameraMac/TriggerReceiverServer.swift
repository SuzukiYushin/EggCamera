import Foundation
import Network

final class TriggerReceiverServer {
    private struct TriggerBody: Decodable {
        let triggerId: String
    }

    private let queue = DispatchQueue(label: "com.eggcamera.mac.trigger")
    private weak var logger: AppLogger?
    private let onCapture: @Sendable (String) async -> Void
    private var listener: NWListener?

    let port: UInt16

    init(port: UInt16, logger: AppLogger, onCapture: @escaping @Sendable (String) async -> Void) {
        self.port = port
        self.logger = logger
        self.onCapture = onCapture
    }

    func start() throws {
        let listener = try NWListener(using: .tcp, on: NWEndpoint.Port(rawValue: port)!)
        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection)
        }
        listener.start(queue: queue)
        self.listener = listener
        Task { @MainActor in
            self.logger?.log("Trigger receiver listening on :\(self.port)")
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

        let requestLine = String(data: data[..<range.lowerBound], encoding: .utf8)?
            .components(separatedBy: "\r\n").first ?? ""
        guard requestLine.hasPrefix("POST /capture") else {
            send(status: 404, message: "Not Found", on: connection)
            return
        }

        let body = Data(data[range.upperBound...])
        let triggerId: String
        if let parsed = try? JSONDecoder().decode(TriggerBody.self, from: body) {
            triggerId = parsed.triggerId
        } else {
            triggerId = "unknown"
        }

        send(status: 202, message: "Accepted", on: connection)
        Task {
            await self.onCapture(triggerId)
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

        return data.count - range.upperBound >= contentLength
    }

    private func send(status: Int, message: String, on connection: NWConnection) {
        let response = [
            "HTTP/1.1 \(status) \(message)",
            "Content-Length: 0",
            "Connection: close",
            "", ""
        ].joined(separator: "\r\n")
        connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}
