import AVFoundation
import Foundation

struct CaptureCommand: Codable {
    let requestID: String
    let callbackURL: String
    let preferredWidth: Int?
    let preferredHeight: Int?
}

struct CaptureMetadata: Codable {
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

struct CaptureCandidate {
    let dimensions: CMVideoDimensions
    let autoDeferredSupported: Bool
    let autoDeferredEnabled: Bool
}

enum CaptureIntermediate {
    case photo(data: Data, dimensions: CMVideoDimensions, fileType: String, deferred: Bool)
    case deferredProxy(data: Data, selectedDimensions: CMVideoDimensions, fileType: String)
}

struct FinalPhotoPayload {
    let data: Data
    let localIdentifier: String
    let pixelWidth: Int
    let pixelHeight: Int
    let creationDate: Date
    let fileType: String
    let deferred: Bool
}

struct LogEntry: Identifiable {
    let id = UUID()
    let timestamp = Date()
    let message: String
}
