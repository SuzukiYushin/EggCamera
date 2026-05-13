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

    func performCapture(command: CaptureCommand) async throws -> CaptureMetadata {
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

        guard let callbackURL = URL(string: command.callbackURL) else {
            throw PipelineError.invalidCallbackURL
        }

        try await transferClient.upload(finalPhoto: finalPhoto, metadata: metadata, callbackURL: callbackURL)
        await MainActor.run {
            logger?.log("Capture pipeline finished id=\(command.requestID) result=\(finalPhoto.pixelWidth)x\(finalPhoto.pixelHeight)")
        }
        return metadata
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
