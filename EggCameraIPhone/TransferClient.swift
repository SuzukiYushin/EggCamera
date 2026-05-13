import Foundation

final class TransferClient {
    private weak var logger: AppLogger?

    init(logger: AppLogger) {
        self.logger = logger
    }

    func upload(finalPhoto: FinalPhotoPayload,
                metadata: CaptureMetadata,
                callbackURL: URL) async throws {
        let envelope = UploadEnvelope(metadata: metadata, imageBase64: finalPhoto.data.base64EncodedString())
        let body = try JSONEncoder.shared.encode(envelope)

        var request = URLRequest(url: callbackURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw TransferError.invalidResponse
        }

        await MainActor.run {
            self.logger?.log("Uploaded final photo to Mac size=\(finalPhoto.data.count) bytes")
        }
    }
}

enum TransferError: Error, LocalizedError {
    case invalidResponse

    var errorDescription: String? {
        "Mac upload receiver returned a non-success response."
    }
}

private extension JSONEncoder {
    static let shared: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
}
