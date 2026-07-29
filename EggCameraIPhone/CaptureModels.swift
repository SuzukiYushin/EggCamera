import AVFoundation
import Foundation

struct CaptureCommand: Codable {
    let requestID: String
    let callbackURL: String
    let preferredWidth: Int?
    let preferredHeight: Int?
    let zoom: Double?  // 撮影時センサークロップズーム倍率(1.0〜2.0)。省略/nil は等倍(後方互換)。
    let exposureBias: Double?  // 撮影時露出補正(EV)。省略/nil は補正なし(後方互換)。
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

    // 実際に配信された画像の実寸（cold-start低解像リテイクの判定に使う）
    var deliveredDimensions: CMVideoDimensions {
        switch self {
        case .photo(_, let dimensions, _, _): return dimensions
        case .deferredProxy(_, let selectedDimensions, _): return selectedDimensions
        }
    }
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
