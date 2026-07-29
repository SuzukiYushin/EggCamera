import Foundation
import Network

final class TriggerReceiverServer {
    private struct TriggerBody: Decodable {
        let triggerId: String
        let zoom: Double?
        let exposureBias: Double?
    }

    private let queue = DispatchQueue(label: "com.eggcamera.mac.trigger")
    private weak var logger: AppLogger?
    private let onCapture: @Sendable (String, Double?, Double?) async -> Void
    private var listener: NWListener?

    let port: UInt16

    init(port: UInt16, logger: AppLogger, onCapture: @escaping @Sendable (String, Double?, Double?) async -> Void) {
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

            if HTTPMessage.isComplete(buffer) || isComplete {
                self.route(buffer, on: connection)
            } else {
                self.receive(on: connection, accumulated: buffer)
            }
        }
    }

    private func route(_ data: Data, on connection: NWConnection) {
        let separator = Data([0x0D, 0x0A, 0x0D, 0x0A])
        guard let range = data.range(of: separator) else {
            HTTPMessage.sendStatus(400, "Bad Request", on: connection)
            return
        }

        let requestLine = String(data: data[..<range.lowerBound], encoding: .utf8)?
            .components(separatedBy: "\r\n").first ?? ""
        guard requestLine.hasPrefix("POST /capture") else {
            HTTPMessage.sendStatus(404, "Not Found", on: connection)
            return
        }

        let body = Data(data[range.upperBound...])
        let triggerId: String
        let zoom: Double?
        let exposureBias: Double?
        if let parsed = try? JSONDecoder().decode(TriggerBody.self, from: body) {
            triggerId = parsed.triggerId
            zoom = parsed.zoom
            exposureBias = parsed.exposureBias
        } else {
            triggerId = "unknown"
            zoom = nil
            exposureBias = nil
        }

        HTTPMessage.sendStatus(202, "Accepted", on: connection)
        Task {
            await self.onCapture(triggerId, zoom, exposureBias)
        }
    }
}
