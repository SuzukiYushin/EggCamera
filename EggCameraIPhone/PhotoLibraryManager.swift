import AVFoundation
import Foundation
import Photos

actor PhotoLibraryManager {
    private weak var logger: AppLogger?

    init(logger: AppLogger) {
        self.logger = logger
    }

    func requestAuthorization() async -> Bool {
        let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        return status == .authorized || status == .limited
    }

    func persist(intermediate: CaptureIntermediate) async throws -> FinalPhotoPayload {
        switch intermediate {
        case .photo(let data, let dimensions, let fileType, let deferred):
            let localIdentifier = try await saveResource(type: .photo, data: data)
            return try await awaitFinalAsset(localIdentifier: localIdentifier,
                                             fallbackData: data,
                                             fallbackDimensions: dimensions,
                                             fileType: fileType,
                                             deferred: deferred)

        case .deferredProxy(let data, let selectedDimensions, let fileType):
            let localIdentifier = try await saveResource(type: .photoProxy, data: data)
            return try await awaitFinalAsset(localIdentifier: localIdentifier,
                                             fallbackData: data,
                                             fallbackDimensions: selectedDimensions,
                                             fileType: fileType,
                                             deferred: true)
        }
    }

    private func saveResource(type: PHAssetResourceType, data: Data) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            var placeholder: String?
            PHPhotoLibrary.shared().performChanges({
                let request = PHAssetCreationRequest.forAsset()
                request.addResource(with: type, data: data, options: nil)
                placeholder = request.placeholderForCreatedAsset?.localIdentifier
            }, completionHandler: { success, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if success, let placeholder {
                    continuation.resume(returning: placeholder)
                } else {
                    continuation.resume(throwing: PhotoLibraryError.assetCreationFailed)
                }
            })
        }
    }

    private func awaitFinalAsset(localIdentifier: String,
                                 fallbackData: Data,
                                 fallbackDimensions: CMVideoDimensions,
                                 fileType: String,
                                 deferred: Bool) async throws -> FinalPhotoPayload {
        for attempt in 0..<20 {
            if let payload = try await fetchPayload(localIdentifier: localIdentifier,
                                                    fallbackData: fallbackData,
                                                    fallbackDimensions: fallbackDimensions,
                                                    fileType: fileType,
                                                    deferred: deferred) {
                await logger?.log("Final asset ready localIdentifier=\(localIdentifier) attempt=\(attempt)")
                return payload
            }

            try await Task.sleep(for: .seconds(1))
        }

        throw PhotoLibraryError.assetNotReady
    }

    private func fetchPayload(localIdentifier: String,
                              fallbackData: Data,
                              fallbackDimensions: CMVideoDimensions,
                              fileType: String,
                              deferred: Bool) async throws -> FinalPhotoPayload? {
        let fetchResult = PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil)
        guard let asset = fetchResult.firstObject else { return nil }

        let resources = PHAssetResource.assetResources(for: asset)
        guard let resource = resources.first(where: { $0.type == .photo || $0.type == .fullSizePhoto || $0.type == .alternatePhoto }) else {
            if deferred {
                return nil
            }

            return FinalPhotoPayload(data: fallbackData,
                                     localIdentifier: localIdentifier,
                                     pixelWidth: Int(fallbackDimensions.width),
                                     pixelHeight: Int(fallbackDimensions.height),
                                     creationDate: asset.creationDate ?? Date(),
                                     fileType: fileType,
                                     deferred: false)
        }

        let data = try await requestData(for: resource)
        return FinalPhotoPayload(data: data,
                                 localIdentifier: localIdentifier,
                                 pixelWidth: asset.pixelWidth,
                                 pixelHeight: asset.pixelHeight,
                                 creationDate: asset.creationDate ?? Date(),
                                 fileType: resource.uniformTypeIdentifier,
                                 deferred: deferred)
    }

    private func requestData(for resource: PHAssetResource) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            let options = PHAssetResourceRequestOptions()
            options.isNetworkAccessAllowed = true

            var buffer = Data()
            PHAssetResourceManager.default().requestData(for: resource, options: options) { chunk in
                buffer.append(chunk)
            } completionHandler: { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: buffer)
                }
            }
        }
    }
}

enum PhotoLibraryError: Error, LocalizedError {
    case assetCreationFailed
    case assetNotReady

    var errorDescription: String? {
        switch self {
        case .assetCreationFailed: return "Failed to create Photo Library asset."
        case .assetNotReady: return "Final Photo Library asset was not ready in time."
        }
    }
}
