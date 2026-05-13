import Foundation

struct CaptureCommand: Codable {
    let requestID: String
    let callbackURL: String
    let preferredWidth: Int?
    let preferredHeight: Int?
}

struct CaptureMetadata: Codable, Identifiable {
    var id: String { requestID }

    let requestID: String
    let localIdentifier: String
    let pixelWidth: Int
    let pixelHeight: Int
    let creationDate: Date
    let deferred: Bool
    let fileType: String
    let selectedDimensions: String
    let autoDeferredSupported: Bool
    let autoDeferredEnabled: Bool
    let captureStartedAt: Date
    let assetReadyAt: Date
    let uploadedAt: Date
    let fileSizeBytes: Int
}

struct UploadEnvelope: Codable {
    let metadata: CaptureMetadata
    let imageBase64: String
}

struct ReceivedPhoto: Identifiable {
    let id = UUID()
    let metadata: CaptureMetadata
    let fileURL: URL
}

struct LogEntry: Identifiable {
    let id = UUID()
    let timestamp = Date()
    let message: String
}
