import Foundation
import Network

final class CaptureCommandClient {
    private final class ResumeState: @unchecked Sendable {
        let lock = NSLock()
        var resumed = false

        func tryResume() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            guard !resumed else { return false }
            resumed = true
            return true
        }
    }

    private let queue = DispatchQueue(label: "com.eggcamera.mac.command-client")

    func sendCapture(to host: String?,
                     port: Int,
                     callbackURL: String,
                     preferredWidth: Int?,
                     preferredHeight: Int?) async throws -> Data {
        let endpoint = try await resolveEndpoint(host: host, port: port)

        let command = CaptureCommand(requestID: UUID().uuidString,
                                     callbackURL: callbackURL,
                                     preferredWidth: preferredWidth,
                                     preferredHeight: preferredHeight)

        let body = try JSONEncoder.iso8601.encode(command)
        let requestHeader = [
            "POST /capture HTTP/1.1",
            "Host: eggcamera",
            "Content-Type: application/json",
            "Content-Length: \(body.count)",
            "Connection: close",
            "", ""
        ].joined(separator: "\r\n")

        var payload = Data(requestHeader.utf8)
        payload.append(body)

        // USB(プル型): レスポンスボディ(UploadEnvelope JSON=写真)を受け取って返す。
        return try await send(payload: payload, to: endpoint)
    }

    private func resolveEndpoint(host: String?, port: Int) async throws -> NWEndpoint {
        if let host, !host.isEmpty {
            guard let nwPort = NWEndpoint.Port(rawValue: UInt16(port)) else {
                throw CommandClientError.invalidPort
            }
            return .hostPort(host: .name(host, nil), port: nwPort)
        }

        return try await discoverBonjourEndpoint()
    }

    private func discoverBonjourEndpoint(timeout: TimeInterval = 10) async throws -> NWEndpoint {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<NWEndpoint, Error>) in
            let browser = NWBrowser(for: .bonjourWithTXTRecord(type: "_eggcamera._tcp", domain: nil), using: .tcp)
            let state = ResumeState()

            @Sendable func finish(_ result: Result<NWEndpoint, Error>) {
                guard state.tryResume() else { return }
                browser.cancel()
                continuation.resume(with: result)
            }

            browser.stateUpdateHandler = { state in
                if case .failed(let error) = state {
                    finish(.failure(error))
                }
            }

            browser.browseResultsChangedHandler = { results, _ in
                if let endpoint = results.first?.endpoint {
                    finish(.success(endpoint))
                }
            }

            browser.start(queue: queue)
            queue.asyncAfter(deadline: .now() + timeout) {
                finish(.failure(CommandClientError.bonjourTimeout))
            }
        }
    }

    private func send(payload: Data, to endpoint: NWEndpoint) async throws -> Data {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
            let connection = NWConnection(to: endpoint, using: .tcp)
            let state = ResumeState()
            var responseBuffer = Data()

            @Sendable func finish(_ result: Result<Data, Error>) {
                guard state.tryResume() else { return }
                connection.cancel()
                continuation.resume(with: result)
            }

            func receive() {
                connection.receive(minimumIncompleteLength: 1, maximumLength: 1_048_576) { data, _, isComplete, error in
                    if let error {
                        finish(.failure(error))
                        return
                    }

                    if let data {
                        responseBuffer.append(data)
                    }

                    if isComplete {
                        // 接続クローズまで読み切ったので、ヘッダ+ボディ全体が揃っている。
                        let separator = Data([0x0D, 0x0A, 0x0D, 0x0A])
                        guard let range = responseBuffer.range(of: separator) else {
                            finish(.failure(CommandClientError.invalidResponse))
                            return
                        }

                        let header = String(data: responseBuffer[..<range.lowerBound], encoding: .utf8) ?? ""
                        let statusLine = header.components(separatedBy: "\r\n").first ?? ""
                        // USB(プル型): 200 + UploadEnvelope(JSON=写真) を返す。ボディを取り出す。
                        if statusLine.contains("200") {
                            let bodyData = Data(responseBuffer[range.upperBound...])
                            finish(.success(bodyData))
                        } else {
                            finish(.failure(CommandClientError.captureRejected))
                        }
                    } else {
                        receive()
                    }
                }
            }

            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    connection.send(content: payload, completion: .contentProcessed { error in
                        if let error {
                            finish(.failure(error))
                        } else {
                            receive()
                        }
                    })
                case .failed(let error):
                    finish(.failure(error))
                default:
                    break
                }
            }

            connection.start(queue: queue)
        }
    }
}

enum CommandClientError: Error, LocalizedError {
    case invalidPort
    case captureRejected
    case bonjourTimeout
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .invalidPort: return "The configured port is invalid."
        case .captureRejected: return "The iPhone did not accept the capture command."
        case .bonjourTimeout: return "Could not discover the iPhone capture service."
        case .invalidResponse: return "The iPhone returned an invalid HTTP response."
        }
    }
}
