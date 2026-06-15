import AVFoundation
import Foundation

final class CapturePipeline {
    private let cameraController: CameraController
    private let transferClient: TransferClient
    private weak var logger: AppLogger?

    init(cameraController: CameraController,
         transferClient: TransferClient,
         logger: AppLogger) {
        self.cameraController = cameraController
        self.transferClient = transferClient
        self.logger = logger
    }

    // USB(プル型): 撮影して UploadEnvelope(JSON) を返す。Mac は POST /capture の
    // レスポンスとして写真を受け取る（旧: callbackURL への WiFi 逆POSTは廃止）。
    func performCapture(command: CaptureCommand) async throws -> Data {
        let captureStartedAt = Date()
        await MainActor.run {
            logger?.log("Accepted capture request id=\(command.requestID) preferred=\(command.preferredWidth?.description ?? "-")x\(command.preferredHeight?.description ?? "-")")
        }

        let (intermediate, candidate) = try await cameraController.capture(preferredWidth: command.preferredWidth,
                                                                           preferredHeight: command.preferredHeight)

        let finalPhoto = makeFinalPhoto(from: intermediate)
        let metadata = CaptureMetadata(
            requestID: command.requestID,
            localIdentifier: "",
            pixelWidth: finalPhoto.pixelWidth,
            pixelHeight: finalPhoto.pixelHeight,
            creationDate: finalPhoto.creationDate,
            deferred: finalPhoto.deferred,
            fileType: finalPhoto.fileType,
            selectedDimensions: describe(candidate?.dimensions),
            autoDeferredSupported: candidate?.autoDeferredSupported ?? false,
            autoDeferredEnabled: candidate?.autoDeferredEnabled ?? false,
            captureStartedAt: captureStartedAt,
            assetReadyAt: Date(),
            uploadedAt: Date(),
            fileSizeBytes: finalPhoto.data.count
        )

        let envelope = UploadEnvelope(metadata: metadata, imageBase64: finalPhoto.data.base64EncodedString())
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let body = try encoder.encode(envelope)

        await MainActor.run {
            logger?.log("Capture pipeline finished id=\(command.requestID) result=\(finalPhoto.pixelWidth)x\(finalPhoto.pixelHeight) bytes=\(finalPhoto.data.count)")
        }
        return body
    }

    private func makeFinalPhoto(from intermediate: CaptureIntermediate) -> FinalPhotoPayload {
        switch intermediate {
        case .photo(let data, let dimensions, let fileType, let deferred):
            return FinalPhotoPayload(data: data,
                                     localIdentifier: "",
                                     pixelWidth: Int(dimensions.width),
                                     pixelHeight: Int(dimensions.height),
                                     creationDate: Date(),
                                     fileType: fileType,
                                     deferred: deferred)
        case .deferredProxy(let data, let selectedDimensions, let fileType):
            return FinalPhotoPayload(data: data,
                                     localIdentifier: "",
                                     pixelWidth: Int(selectedDimensions.width),
                                     pixelHeight: Int(selectedDimensions.height),
                                     creationDate: Date(),
                                     fileType: fileType,
                                     deferred: true)
        }
    }

    private func describe(_ dimensions: CMVideoDimensions?) -> String {
        guard let dimensions else { return "-" }
        return "\(dimensions.width)x\(dimensions.height)"
    }
}

enum PipelineError: Error, LocalizedError {
    case invalidCallbackURL

    var errorDescription: String? {
        "Capture callback URL is invalid."
    }
}
