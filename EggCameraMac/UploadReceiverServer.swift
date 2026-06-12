import Foundation
import Network

final class UploadReceiverServer {
    private let queue = DispatchQueue(label: "com.eggcamera.mac.upload")
    private weak var logger: AppLogger?
    private weak var store: ReceivedPhotoStore?
    private var listener: NWListener?

    let port: UInt16

    init(port: UInt16, logger: AppLogger, store: ReceivedPhotoStore) {
        self.port = port
        self.logger = logger
        self.store = store
    }

    func start() throws {
        let listener = try NWListener(using: .tcp, on: NWEndpoint.Port(rawValue: port)!)
        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection)
        }
        listener.start(queue: queue)
        self.listener = listener
        Task { @MainActor in
            self.logger?.log("Upload receiver listening on :\(self.port)")
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
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
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
        guard requestLine.hasPrefix("POST /upload") else {
            HTTPMessage.sendStatus(404, "Not Found", on: connection)
            return
        }

        let body = Data(data[range.upperBound...])
        guard let envelope = try? JSONDecoder.iso8601.decode(UploadEnvelope.self, from: body) else {
            HTTPMessage.sendStatus(400, "Invalid JSON", on: connection)
            return
        }

        Task { @MainActor in
            do {
                let photo = try self.store?.save(envelope: envelope)
                self.logger?.log("Received photo id=\(envelope.metadata.requestID) size=\(envelope.metadata.pixelWidth)x\(envelope.metadata.pixelHeight) deferred=\(envelope.metadata.deferred)")
                if let photo {
                    self.logger?.log("Saved photo path=\(photo.fileURL.path)")
                } else {
                    self.logger?.log("Store unavailable for received photo")
                }
            } catch {
                self.logger?.log("Failed to save uploaded photo error=\(error.localizedDescription)")
            }
        }

        HTTPMessage.sendStatus(200, "OK", on: connection)
    }
}
