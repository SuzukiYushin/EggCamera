import AVFoundation
import CoreImage
import Foundation
import ImageIO
import QuartzCore

final class CameraController: NSObject {
    private let session = AVCaptureSession()
    private let photoOutput = AVCapturePhotoOutput()
    private let videoOutput = AVCaptureVideoDataOutput()
    private let sessionQueue = DispatchQueue(label: "com.eggcamera.iphone.camera")
    private let videoQueue = DispatchQueue(label: "com.eggcamera.iphone.preview-frames")
    private weak var logger: AppLogger?
    private var device: AVCaptureDevice?
    private var activeDelegates: [PhotoCaptureDelegate] = []
    private let delegateLock = NSLock()

    // 省電力: 一定時間アクティビティ（wake/撮影/プレビュー取得）が無ければ
    // カメラセッションを止める。客がいない待機中の発熱・電力・電池劣化を抑える。
    // 復帰は wake()（iPad のスタート押下で呼ばれる）または撮影時の遅延起動。
    private var idleTimer: DispatchSourceTimer?
    private static let idleTimeout: TimeInterval = 180

    // ブラウザのライブプレビュー用: 最新フレームのJPEGを保持（GET /frame が読む）
    private let frameLock = NSLock()
    private var latestFrameJPEG: Data?
    private var lastFrameEncodedAt: TimeInterval = 0
    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private static let previewFPS: Double = 10
    private static let previewLongEdge: CGFloat = 720

    func latestPreviewFrame() -> Data? {
        frameLock.lock()
        defer { frameLock.unlock() }
        return latestFrameJPEG
    }

    init(logger: AppLogger) {
        self.logger = logger
        super.init()
        NotificationCenter.default.addObserver(self,
                                               selector: #selector(sessionWasInterrupted),
                                               name: AVCaptureSession.wasInterruptedNotification,
                                               object: session)
        NotificationCenter.default.addObserver(self,
                                               selector: #selector(sessionInterruptionEnded),
                                               name: AVCaptureSession.interruptionEndedNotification,
                                               object: session)
    }

    @objc private func sessionWasInterrupted(_ notification: Notification) {
        let reason = notification.userInfo?[AVCaptureSessionInterruptionReasonKey] as? Int ?? -1
        Task { @MainActor in
            self.logger?.log("AVCaptureSession interrupted reason=\(reason)")
        }
    }

    @objc private func sessionInterruptionEnded(_ notification: Notification) {
        Task { @MainActor in
            self.logger?.log("AVCaptureSession interruption ended — restarting")
        }
        sessionQueue.async {
            if !self.session.isRunning {
                self.session.startRunning()
                Task { @MainActor in
                    self.logger?.log("AVCaptureSession restarted after interruption")
                }
            }
        }
    }

    func makePreviewLayer() -> AVCaptureVideoPreviewLayer {
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        return layer
    }

    func startSession() async throws {
        try await withCheckedThrowingContinuation { continuation in
            sessionQueue.async {
                do {
                    try self.ensureRunningLocked()
                    self.scheduleIdleStopLocked()
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    // iPad のスタート押下時に呼ばれる。撮影ページ到達前にカメラを温めておき、
    // 待ち時間をなくす。同時にアイドルタイマを延長する。
    func keepAwake() {
        sessionQueue.async {
            do {
                try self.ensureRunningLocked()
            } catch {
                Task { @MainActor in self.logger?.log("keepAwake start failed: \(error.localizedDescription)") }
            }
            self.scheduleIdleStopLocked()
        }
    }

    // プレビュー取得など、稼働中のアクティビティでアイドル時間を延長する
    // （稼働していなければ何もしない＝/frame だけでは起動しない）。
    func noteActivity() {
        sessionQueue.async {
            guard self.session.isRunning else { return }
            self.scheduleIdleStopLocked()
        }
    }

    func stopSession() {
        sessionQueue.async {
            self.idleTimer?.cancel()
            self.idleTimer = nil
            guard self.session.isRunning else { return }
            self.session.stopRunning()
            Task { @MainActor in
                self.logger?.log("AVCaptureSession stopped")
            }
        }
    }

    // sessionQueue 上で呼ぶこと。未起動なら構成して起動する。
    private func ensureRunningLocked() throws {
        guard !session.isRunning else { return }
        try configureSessionIfNeeded()
        session.startRunning()
        Task { @MainActor in self.logger?.log("AVCaptureSession started") }
    }

    // sessionQueue 上で呼ぶこと。アイドルタイマを idleTimeout 後に張り直す。
    private func scheduleIdleStopLocked() {
        idleTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: sessionQueue)
        timer.schedule(deadline: .now() + Self.idleTimeout)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            self.idleTimer = nil
            guard self.session.isRunning else { return }
            self.session.stopRunning()
            Task { @MainActor in self.logger?.log("AVCaptureSession stopped (idle \(Int(Self.idleTimeout))s)") }
        }
        idleTimer = timer
        timer.resume()
    }

    func supportedDimensionsSummary() -> String {
        guard let device else { return "-" }
        let values = device.activeFormat.supportedMaxPhotoDimensions
            .map { "\($0.width)x\($0.height)" }
            .sorted()
        return values.isEmpty ? "-" : values.joined(separator: ", ")
    }

    func capture(preferredWidth: Int?, preferredHeight: Int?) async throws -> (CaptureIntermediate, CaptureCandidate?) {
        try await withCheckedThrowingContinuation { continuation in
            sessionQueue.async {
                // 念のための遅延起動: wake を取りこぼしても撮影は成立させる
                do {
                    try self.ensureRunningLocked()
                } catch {
                    continuation.resume(throwing: error)
                    return
                }
                self.scheduleIdleStopLocked()

                let candidate = self.chooseCandidate(preferredWidth: preferredWidth, preferredHeight: preferredHeight)
                let settings = self.makePhotoSettings(candidate: candidate)

                let delegate = PhotoCaptureDelegate(selectedDimensions: candidate?.dimensions) { [weak self] result in
                    self?.remove(delegate: result.delegate)
                    switch result.payload {
                    case .success(let payload):
                        continuation.resume(returning: (payload, candidate))
                    case .failure(let error):
                        continuation.resume(throwing: error)
                    }
                }

                self.store(delegate: delegate)
                self.photoOutput.capturePhoto(with: settings, delegate: delegate)
                Task { @MainActor in
                    self.logger?.log("capturePhoto fired selected=\(self.describe(candidate?.dimensions)) deferredEnabled=\(candidate?.autoDeferredEnabled == true)")
                }
            }
        }
    }

    private func configureSessionIfNeeded() throws {
        guard session.inputs.isEmpty else { return }

        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .photo

        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            throw CameraError.cameraUnavailable
        }

        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input), session.canAddOutput(photoOutput) else {
            throw CameraError.configurationFailed
        }

        session.addInput(input)
        session.addOutput(photoOutput)
        photoOutput.maxPhotoQualityPrioritization = .quality
        self.device = device

        // ライブプレビュー配信用の映像出力（静止画撮影には影響しない）
        videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        videoOutput.alwaysDiscardsLateVideoFrames = true
        videoOutput.setSampleBufferDelegate(self, queue: videoQueue)
        if session.canAddOutput(videoOutput) {
            session.addOutput(videoOutput)
            if let connection = videoOutput.connection(with: .video) {
                if #available(iOS 17.0, *) {
                    if connection.isVideoRotationAngleSupported(90) {
                        connection.videoRotationAngle = 90 // 縦向き
                    }
                } else if connection.isVideoOrientationSupported {
                    connection.videoOrientation = .portrait
                }
            }
        }

        if let format = device.formats.max(by: { maxArea($0) < maxArea($1) }) {
            try device.lockForConfiguration()
            device.activeFormat = format
            device.unlockForConfiguration()
        }

        if let largest = device.activeFormat.supportedMaxPhotoDimensions.max(by: { area($0) < area($1) }) {
            photoOutput.maxPhotoDimensions = largest
        }
    }

    private func chooseCandidate(preferredWidth: Int?, preferredHeight: Int?) -> CaptureCandidate? {
        guard let device else { return nil }
        let supported = device.activeFormat.supportedMaxPhotoDimensions
        guard !supported.isEmpty else { return nil }

        let selected: CMVideoDimensions
        if let preferredWidth, let preferredHeight, preferredWidth > 0, preferredHeight > 0 {
            let desiredLong = max(preferredWidth, preferredHeight)
            let desiredShort = min(preferredWidth, preferredHeight)
            selected = supported.min { lhs, rhs in
                score(lhs, desiredLong: desiredLong, desiredShort: desiredShort) <
                score(rhs, desiredLong: desiredLong, desiredShort: desiredShort)
            } ?? supported[0]
        } else {
            selected = supported.max(by: { area($0) < area($1) }) ?? supported[0]
        }

        let autoDeferredSupported: Bool
        if #available(iOS 17.0, *) {
            autoDeferredSupported = photoOutput.isAutoDeferredPhotoDeliverySupported
        } else {
            autoDeferredSupported = false
        }

        let autoDeferredEnabled = false
        return CaptureCandidate(dimensions: selected,
                                autoDeferredSupported: autoDeferredSupported,
                                autoDeferredEnabled: autoDeferredEnabled)
    }

    private func makePhotoSettings(candidate: CaptureCandidate?) -> AVCapturePhotoSettings {
        let settings: AVCapturePhotoSettings
        if photoOutput.availablePhotoCodecTypes.contains(.hevc) {
            settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.hevc])
        } else {
            settings = AVCapturePhotoSettings()
        }

        settings.photoQualityPrioritization = .quality
        if let candidate {
            settings.maxPhotoDimensions = candidate.dimensions
            if #available(iOS 17.0, *) {
                photoOutput.isAutoDeferredPhotoDeliveryEnabled = candidate.autoDeferredEnabled
            }
        }
        return settings
    }

    private func store(delegate: PhotoCaptureDelegate) {
        delegateLock.lock()
        activeDelegates.append(delegate)
        delegateLock.unlock()
    }

    private func remove(delegate: PhotoCaptureDelegate) {
        delegateLock.lock()
        activeDelegates.removeAll { $0 === delegate }
        delegateLock.unlock()
    }

    private func area(_ dimensions: CMVideoDimensions) -> Int {
        Int(dimensions.width) * Int(dimensions.height)
    }

    private func maxArea(_ format: AVCaptureDevice.Format) -> Int {
        format.supportedMaxPhotoDimensions.map(area).max() ?? 0
    }

    private func score(_ dimensions: CMVideoDimensions, desiredLong: Int, desiredShort: Int) -> Int {
        let longEdge = max(Int(dimensions.width), Int(dimensions.height))
        let shortEdge = min(Int(dimensions.width), Int(dimensions.height))
        return abs(longEdge - desiredLong) * 10 + abs(shortEdge - desiredShort)
    }

    private func describe(_ dimensions: CMVideoDimensions?) -> String {
        guard let dimensions else { return "-" }
        return "\(dimensions.width)x\(dimensions.height)"
    }
}

// ── ライブプレビューのフレーム生成 ──────────────────────────────
extension CameraController: AVCaptureVideoDataOutputSampleBufferDelegate {
    func captureOutput(_ output: AVCaptureOutput,
                       didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        // FPSを間引いてCPU/帯域を節約
        let now = CACurrentMediaTime()
        guard now - lastFrameEncodedAt >= 1.0 / Self.previewFPS else { return }
        lastFrameEncodedAt = now

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        var image = CIImage(cvPixelBuffer: pixelBuffer)
        let longEdge = max(image.extent.width, image.extent.height)
        if longEdge > Self.previewLongEdge {
            let scale = Self.previewLongEdge / longEdge
            image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        }

        let qualityKey = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
        guard let jpeg = ciContext.jpegRepresentation(
            of: image,
            colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
            options: [qualityKey: 0.55]
        ) else { return }

        frameLock.lock()
        latestFrameJPEG = jpeg
        frameLock.unlock()
    }
}

enum CameraError: Error, LocalizedError {
    case sessionNotRunning
    case cameraUnavailable
    case configurationFailed
    case photoDataUnavailable
    case deferredProxyUnavailable

    var errorDescription: String? {
        switch self {
        case .sessionNotRunning: return "Camera session is not running."
        case .cameraUnavailable: return "Back camera is unavailable."
        case .configurationFailed: return "Failed to configure camera session."
        case .photoDataUnavailable: return "Failed to generate photo data."
        case .deferredProxyUnavailable: return "Deferred photo proxy was unavailable."
        }
    }
}

private final class PhotoCaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate {
    struct CompletionResult {
        let delegate: PhotoCaptureDelegate
        let payload: Result<CaptureIntermediate, Error>
    }

    private let selectedDimensions: CMVideoDimensions?
    private let completion: (CompletionResult) -> Void
    private var hasCompleted = false

    init(selectedDimensions: CMVideoDimensions?,
         completion: @escaping (CompletionResult) -> Void) {
        self.selectedDimensions = selectedDimensions
        self.completion = completion
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        guard !hasCompleted else { return }
        if let error {
            finish(.failure(error))
            return
        }

        guard let data = photo.fileDataRepresentation() else {
            finish(.failure(CameraError.photoDataUnavailable))
            return
        }

        let dimensions = imageDimensions(from: data) ?? selectedDimensions ?? CMVideoDimensions(width: 0, height: 0)
        finish(.success(.photo(data: data,
                               dimensions: dimensions,
                               fileType: "public.heic",
                               deferred: false)))
    }

    @available(iOS 17.0, *)
    func photoOutput(_ output: AVCapturePhotoOutput,
                     didFinishCapturingDeferredPhotoProxy deferredPhotoProxy: AVCaptureDeferredPhotoProxy?,
                     error: Error?) {
        guard !hasCompleted else { return }
        if let error {
            finish(.failure(error))
            return
        }

        guard let deferredPhotoProxy,
              let data = deferredPhotoProxy.fileDataRepresentation() else {
            finish(.failure(CameraError.deferredProxyUnavailable))
            return
        }

        let dimensions = imageDimensions(from: data) ?? selectedDimensions ?? CMVideoDimensions(width: 0, height: 0)
        finish(.success(.deferredProxy(data: data,
                                       selectedDimensions: dimensions,
                                       fileType: "public.heic")))
    }

    private func finish(_ payload: Result<CaptureIntermediate, Error>) {
        hasCompleted = true
        completion(CompletionResult(delegate: self, payload: payload))
    }

    private func imageDimensions(from data: Data) -> CMVideoDimensions? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int else {
            return nil
        }

        return CMVideoDimensions(width: Int32(width), height: Int32(height))
    }
}
