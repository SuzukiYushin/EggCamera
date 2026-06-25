import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

final class ReceivedPhotoStore {
    private static let maxPhotos = 30
    private static let filenameDateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd_HHmmss"
        return f
    }()

    private(set) var photos: [ReceivedPhoto] = []
    private let directoryURL: URL
    private let outputSize: CGSize?
    private let centerCropToExactSize: Bool
    private weak var logger: AppLogger?

    init(directoryURL: URL, outputSize: CGSize?, centerCropToExactSize: Bool, logger: AppLogger?) {
        self.directoryURL = directoryURL
        self.outputSize = outputSize
        self.centerCropToExactSize = centerCropToExactSize
        self.logger = logger
        try? FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    }

    func save(envelope: UploadEnvelope) throws -> ReceivedPhoto {
        guard let imageData = Data(base64Encoded: envelope.imageBase64) else {
            throw StoreError.invalidBase64
        }

        let processed = processIfNeeded(imageData, fileType: envelope.metadata.fileType)
        let datePart = Self.filenameDateFormatter.string(from: envelope.metadata.creationDate)
        let fileName = "\(datePart).\(processed.fileExtension)"
        let fileURL = directoryURL.appendingPathComponent(fileName)
        try processed.data.write(to: fileURL, options: .atomic)

        let photo = ReceivedPhoto(metadata: envelope.metadata, fileURL: fileURL)
        photos.insert(photo, at: 0)
        trimToLimit()
        return photo
    }

    // MARK: - Trimming (disk-based so it survives restarts)

    private func trimToLimit() {
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: directoryURL,
            includingPropertiesForKeys: nil,
            options: .skipsHiddenFiles
        ) else { return }

        let imageFiles = files
            .filter { !$0.hasDirectoryPath }
            .sorted { $0.lastPathComponent < $1.lastPathComponent } // yyyyMMdd_HHmmss → oldest first

        guard imageFiles.count > Self.maxPhotos else { return }

        let toDelete = imageFiles.prefix(imageFiles.count - Self.maxPhotos)
        for url in toDelete {
            try? FileManager.default.removeItem(at: url)
            photos.removeAll { $0.fileURL == url }
            logger?.log("Trimmed old photo file=\(url.lastPathComponent)")
        }
    }

    // MARK: - Image processing

    private func processIfNeeded(_ imageData: Data, fileType: String) -> ProcessedImage {
        guard let outputSize else {
            return ProcessedImage(data: imageData,
                                  fileExtension: preferredExtension(for: fileType),
                                  pixelWidth: 0,
                                  pixelHeight: 0)
        }

        guard let source = CGImageSourceCreateWithData(imageData as CFData, nil),
              let sourceType = CGImageSourceGetType(source),
              let orientedImage = createOrientedImage(from: source) else {
            logger?.log("Image processing fallback: could not decode source image")
            return ProcessedImage(data: imageData,
                                  fileExtension: preferredExtension(for: fileType),
                                  pixelWidth: 0,
                                  pixelHeight: 0)
        }

        let sourceWidth = CGFloat(orientedImage.width)
        let sourceHeight = CGFloat(orientedImage.height)

        // 低照度ビニング等でソースが小さい(12MP=3024x4032)時、出力サイズ(4000x6000)へ
        // 引き伸ばすと偽の解像度＝眠い画になる。拡大が必要なら、ソースが無拡大で満たせる
        // ところまで出力サイズを半分ずつ縮める（48MP→4000x6000 / 12MP→2000x3000）。
        // 最終合成のレイアウトは compose 側が出力寸法へ比例追従するため崩れない。
        var adaptiveSize = outputSize
        if centerCropToExactSize {
            while adaptiveSize.width >= 2, adaptiveSize.height >= 2,
                  max(adaptiveSize.width / sourceWidth, adaptiveSize.height / sourceHeight) > 1 {
                adaptiveSize = CGSize(width: (adaptiveSize.width / 2).rounded(),
                                      height: (adaptiveSize.height / 2).rounded())
            }
        }
        let targetWidth = adaptiveSize.width
        let targetHeight = adaptiveSize.height

        let scale = centerCropToExactSize
            ? max(targetWidth / sourceWidth, targetHeight / sourceHeight)
            : min(targetWidth / sourceWidth, targetHeight / sourceHeight)
        let drawWidth = sourceWidth * scale
        let drawHeight = sourceHeight * scale
        let x = (targetWidth - drawWidth) / 2
        let y = (targetHeight - drawHeight) / 2

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(data: nil,
                                      width: Int(targetWidth),
                                      height: Int(targetHeight),
                                      bitsPerComponent: 8,
                                      bytesPerRow: 0,
                                      space: colorSpace,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            logger?.log("Image processing fallback: could not create bitmap context")
            return ProcessedImage(data: imageData,
                                  fileExtension: preferredExtension(forType: sourceType),
                                  pixelWidth: 0,
                                  pixelHeight: 0)
        }

        context.interpolationQuality = .high
        context.setFillColor(CGColor(gray: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight))
        context.draw(orientedImage, in: CGRect(x: x, y: y, width: drawWidth, height: drawHeight))

        guard let rendered = context.makeImage(),
              let encoded = encode(rendered, sourceType: sourceType) else {
            logger?.log("Image processing fallback: could not encode processed image")
            return ProcessedImage(data: imageData,
                                  fileExtension: preferredExtension(forType: sourceType),
                                  pixelWidth: 0,
                                  pixelHeight: 0)
        }

        logger?.log("Processed image on Mac: \(Int(sourceWidth))x\(Int(sourceHeight)) -> \(rendered.width)x\(rendered.height) cropCenter=\(centerCropToExactSize)")
        return ProcessedImage(data: encoded,
                              fileExtension: preferredExtension(forType: sourceType),
                              pixelWidth: rendered.width,
                              pixelHeight: rendered.height)
    }

    private func createOrientedImage(from source: CGImageSource) -> CGImage? {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int else {
            return CGImageSourceCreateImageAtIndex(source, 0, nil)
        }

        let maxPixel = max(width, height)
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    private func encode(_ image: CGImage, sourceType: CFString) -> Data? {
        let mutableData = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(mutableData, sourceType, 1, nil) else {
            return nil
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            return nil
        }
        return mutableData as Data
    }

    private func preferredExtension(for fileType: String) -> String {
        if let type = UTType(fileType) {
            return preferredExtension(forType: type.identifier as CFString)
        }
        return fileType.contains("jpeg") ? "jpg" : "heic"
    }

    private func preferredExtension(forType sourceType: CFString) -> String {
        if let type = UTType(sourceType as String) {
            if type.conforms(to: .jpeg) { return "jpg" }
            if type.conforms(to: .heic) || type.conforms(to: .heif) { return "heic" }
            return type.preferredFilenameExtension ?? "img"
        }
        return "heic"
    }
}

private struct ProcessedImage {
    let data: Data
    let fileExtension: String
    let pixelWidth: Int
    let pixelHeight: Int
}

enum StoreError: Error, LocalizedError {
    case invalidBase64

    var errorDescription: String? {
        "Received image payload was not valid base64."
    }
}
