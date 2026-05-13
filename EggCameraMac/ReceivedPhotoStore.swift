import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

final class ReceivedPhotoStore {
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
        let fileName = "\(envelope.metadata.requestID)_\(processed.pixelWidth)x\(processed.pixelHeight).\(processed.fileExtension)"
        let fileURL = directoryURL.appendingPathComponent(fileName)
        try processed.data.write(to: fileURL, options: .atomic)

        let photo = ReceivedPhoto(metadata: envelope.metadata, fileURL: fileURL)
        photos.insert(photo, at: 0)
        return photo
    }

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
        let targetWidth = outputSize.width
        let targetHeight = outputSize.height

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
            if type.conforms(to: .jpeg) {
                return "jpg"
            }
            if type.conforms(to: .heic) || type.conforms(to: .heif) {
                return "heic"
            }
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
