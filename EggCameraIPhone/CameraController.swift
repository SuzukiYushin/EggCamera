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
    // 撮影時センサークロップズーム(光学品質)。crop.zoom がトリガ/wake で渡る。
    // sessionQueue 上でのみ読み書きする。activeFormat 変更で videoZoomFactor は 1.0 に
    // リセットされるため、フォーマット確定後に毎回 applyZoomLocked() で再適用する。
    private var requestedZoom: CGFloat = 1.0
    // 撮影時露出補正(EV)。exposure.bias がトリガ/wake で渡る。sessionQueue 上でのみ
    // 読み書きし、ズームと同様フォーマット確定後に applyExposureBiasLocked() で再適用する。
    private var requestedExposureBias: Float = 0
    private var activeDelegates: [PhotoCaptureDelegate] = []
    private let delegateLock = NSLock()

    // 省電力: 一定時間アクティビティ（wake/撮影/プレビュー取得）が無ければ
    // カメラセッションを止める。客がいない待機中の発熱・電力・電池劣化を抑える。
    // 復帰は wake()（iPad のスタート押下で呼ばれる）または撮影時の遅延起動。
    private var idleTimer: DispatchSourceTimer?
    private static let idleTimeout: TimeInterval = 180

    // ── 12MPフォーマットrace恒久対策（2026-07-04）─────────────────────────
    // セッション cold-start 直後は 48MP フォーマットの列挙/適用が撮影と競走し、初回1枚だけ
    // 12MP になる確率的 race がある（warmup は発生率低減の緩和策で根絶はできない）。対策は2層:
    //   1) cold-start 後の撮影は photoOutput.maxPhotoDimensions が 48MP 級になるまで待つ
    //   2) それでも低解像で出てきたら1回だけ即時リテイク（この時点でセッションは温まっている）
    // ※ 低照度ビニング(暗所で12MP)は仕様であり対象外。リテイクが発火するのは cold-start
    //   直後の1枚だけなので、暗所では追加1枚(どちらも12MP)を撮るだけで実害はない。
    private var lastSessionStartAt: CFTimeInterval = 0
    private static let coldStartWindow: CFTimeInterval = 10   // 起動後この秒数内の撮影を cold とみなす
    private static let fullResReadyTimeout: CFTimeInterval = 2.5
    private static let fullResMinArea = 40_000_000            // 48MP級の下限(8064x6048≈48.8M)。12MP≈12.2M

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
                self.lastSessionStartAt = CACurrentMediaTime() // 割り込み復帰も cold-start 扱い
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

    // 管理画面スライダー / wake?zoom= からのリアルタイムズーム。撮影を待たず
    // プレビュー(videoOutput)にも反映する。セッション未起動時は requestedZoom だけ
    // 更新し、次の ensureRunning/capture 後の applyZoomLocked で反映される。
    func setZoom(_ zoom: Double) {
        sessionQueue.async {
            self.requestedZoom = CGFloat(zoom)
            guard self.session.isRunning else { return }
            self.applyZoomLocked()
        }
    }

    // 管理画面スライダー / wake?ev= からのリアルタイム露出補正。撮影を待たず
    // プレビュー(videoOutput)にも反映する。セッション未起動時は requestedExposureBias
    // だけ更新し、次の ensureRunning/capture 後の applyExposureBiasLocked で反映される。
    func setExposureBias(_ bias: Double) {
        sessionQueue.async {
            self.requestedExposureBias = Float(bias)
            guard self.session.isRunning else { return }
            self.applyExposureBiasLocked()
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
        lastSessionStartAt = CACurrentMediaTime() // cold-start判定の起点（12MP race対策）
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

    func capture(preferredWidth: Int?, preferredHeight: Int?, zoom: Double?, exposureBias: Double?) async throws -> (CaptureIntermediate, CaptureCandidate?) {
        try await withCheckedThrowingContinuation { continuation in
            sessionQueue.async {
                self.captureAttemptLocked(preferredWidth: preferredWidth,
                                          preferredHeight: preferredHeight,
                                          zoom: zoom,
                                          exposureBias: exposureBias,
                                          attempt: 1) { result in
                    continuation.resume(with: result)
                }
            }
        }
    }

    // sessionQueue 上で呼ぶこと。attempt=1 で cold-start 低解像を検知したら attempt=2 を1回だけ再帰発火する。
    private func captureAttemptLocked(preferredWidth: Int?,
                                      preferredHeight: Int?,
                                      zoom: Double?,
                                      exposureBias: Double?,
                                      attempt: Int,
                                      completion: @escaping (Result<(CaptureIntermediate, CaptureCandidate?), Error>) -> Void) {
        // 念のための遅延起動: wake を取りこぼしても撮影は成立させる
        do {
            try ensureRunningLocked()
        } catch {
            completion(.failure(error))
            return
        }
        scheduleIdleStopLocked()
        applyBestPhotoFormatLocked() // 撮影ごとに最高画質を保証(12MP固定を自己修復)
        let coldStart = CACurrentMediaTime() - lastSessionStartAt < Self.coldStartWindow
        if coldStart {
            waitForFullResReadyLocked() // race対策1: フォーマット確定前にシャッターを切らない
        }
        if let zoom { self.requestedZoom = CGFloat(zoom) }
        applyZoomLocked() // activeFormat変更でzoomがリセットされるため、フォーマット確定後に再適用
        if let exposureBias { self.requestedExposureBias = Float(exposureBias) }
        if applyExposureBiasLocked() {
            waitForExposureSettleLocked() // バイアスを今変えた時だけAE収束を待つ(通常撮影は遅延ゼロ)
        }

        let candidate = chooseCandidate(preferredWidth: preferredWidth, preferredHeight: preferredHeight)
        let settings = makePhotoSettings(candidate: candidate)
        let expectedArea = area(photoOutput.maxPhotoDimensions)

        let delegate = PhotoCaptureDelegate(selectedDimensions: candidate?.dimensions) { [weak self] result in
            self?.remove(delegate: result.delegate)
            switch result.payload {
            case .success(let payload):
                // race対策2: cold-start直後の1枚が「要求の半分未満の実寸」なら即時リテイク(1回のみ)。
                // この時点でセッションは温まっているため2枚目は正常解像度になる。
                // self が無い場合も completion は必ず呼ぶ（continuation を漏らさない）。
                if let self, attempt == 1, coldStart, expectedArea > 0 {
                    let got = self.area(payload.deliveredDimensions)
                    if got > 0, got * 2 < expectedArea {
                        Task { @MainActor in
                            self.logger?.log("cold-start低解像を検知 got=\(self.describe(payload.deliveredDimensions)) expectedArea=\(expectedArea) → 即時リテイク")
                        }
                        self.sessionQueue.async {
                            self.captureAttemptLocked(preferredWidth: preferredWidth,
                                                      preferredHeight: preferredHeight,
                                                      zoom: zoom,
                                                      exposureBias: exposureBias,
                                                      attempt: 2,
                                                      completion: completion)
                        }
                        return
                    }
                }
                completion(.success((payload, candidate)))
            case .failure(let error):
                completion(.failure(error))
            }
        }

        store(delegate: delegate)
        let outMax = describe(photoOutput.maxPhotoDimensions)
        let setMax = describe(settings.maxPhotoDimensions)
        photoOutput.capturePhoto(with: settings, delegate: delegate)
        Task { @MainActor in
            self.logger?.log("capturePhoto fired attempt=\(attempt) cold=\(coldStart) selected=\(self.describe(candidate?.dimensions)) settingsMax=\(setMax) outputMax=\(outMax) deferredEnabled=\(candidate?.autoDeferredEnabled == true)")
        }
    }

    // sessionQueue 上で呼ぶこと。cold-start直後、photoOutput.maxPhotoDimensions が48MP級に
    // 到達するまで applyBestPhotoFormatLocked を再試行しながら最大 fullResReadyTimeout 待つ。
    // 起動直後は device.formats に48MPフォーマットがまだ列挙されていないことがあり、
    // 「最高画質を適用」しても12MPが最高、という一瞬が存在する（=raceの正体）。
    // 到達できないままタイムアウトした場合はそのまま撮影に進む（fail-open。従来と同じ挙動＋ログ）。
    private func waitForFullResReadyLocked() {
        let deadline = CACurrentMediaTime() + Self.fullResReadyTimeout
        var polls = 0
        while area(photoOutput.maxPhotoDimensions) < Self.fullResMinArea {
            if CACurrentMediaTime() >= deadline {
                let cur = describe(photoOutput.maxPhotoDimensions)
                Task { @MainActor in
                    self.logger?.log("⚠ full-res ready 待ちタイムアウト(\(Self.fullResReadyTimeout)s) outputMax=\(cur) のまま撮影続行")
                }
                return
            }
            Thread.sleep(forTimeInterval: 0.1)
            applyBestPhotoFormatLocked()
            polls += 1
        }
        if polls > 0 {
            let waited = String(format: "%.1f", Double(polls) * 0.1)
            Task { @MainActor in
                self.logger?.log("full-res ready 待ち \(waited)s で48MP級に到達（raceを回避）")
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

        applyBestPhotoFormatLocked()
        applyZoomLocked() // 初回構成・ライブプレビュー時にも要求ズームを反映
        applyExposureBiasLocked()
    }

    // 最高画質(最大の写真エリア)のフォーマットを activeFormat に設定し、photoOutput.maxPhotoDimensions も合わせる。
    // 既に最高画質なら何もしない(冪等)。撮影のたびに呼ぶことで、カメラ起動直後にまだ48MPフォーマットが
    // 列挙されていない一瞬に初回設定が走って12MPを掴んだまま固定される問題を、次の撮影で自己修復する。
    // (sessionQueue 上で呼ぶこと)
    private func applyBestPhotoFormatLocked() {
        guard let device else { return }
        guard let best = device.formats.max(by: { maxArea($0) < maxArea($1) }) else { return }
        // 真因(2026-06-23): activeFormat は48MP対応(photo dims{4032,8064})でも、撮影上限を握る
        // photoOutput.maxPhotoDimensions が12MPに固定されると48MPで撮れない。さらにこの値や activeFormat の
        // 変更は session.beginConfiguration()/commitConfiguration() の中で行わないと反映されない。
        let needFormatSwitch = maxArea(device.activeFormat) < maxArea(best)
        let curLargest = device.activeFormat.supportedMaxPhotoDimensions.max(by: { area($0) < area($1) })
        let needDimsBump = curLargest.map { area(photoOutput.maxPhotoDimensions) < area($0) } ?? false
        guard needFormatSwitch || needDimsBump else { return } // 既に最高画質なら何もしない(冪等・無駄な再構成を避ける)

        session.beginConfiguration()
        if needFormatSwitch {
            do {
                try device.lockForConfiguration()
                device.activeFormat = best
                device.unlockForConfiguration()
            } catch {
                Task { @MainActor in self.logger?.log("activeFormat lock失敗: \(error.localizedDescription)") }
            }
        }
        if let largest = device.activeFormat.supportedMaxPhotoDimensions.max(by: { area($0) < area($1) }) {
            photoOutput.maxPhotoDimensions = largest
        }
        session.commitConfiguration()

        let lg = device.activeFormat.supportedMaxPhotoDimensions.max(by: { area($0) < area($1) })
            .map { "\($0.width)x\($0.height)" } ?? "-"
        Task { @MainActor in
            self.logger?.log("最高画質を適用(自己修復): maxPhotoDimensions=\(lg) switchedFormat=\(needFormatSwitch)")
        }
    }

    // sessionQueue 上で呼ぶこと。requestedZoom を device.videoZoomFactor へ反映する。
    // videoZoomFactor はデバイス級プロパティで photoOutput(撮影)と videoOutput(/frame)の
    // 両方に同時適用される。lockForConfiguration のみで足りる(beginConfiguration不要・ちらつき回避)。
    private func applyZoomLocked() {
        guard let device else { return }
        // 上限は端末の物理上限(maxAvailableVideoZoomFactor)まで許容する。無劣化範囲の
        // 提示は管理画面のズームゲージ側で行う方針のため、ここでは物理上限のみで保護する。
        let lo = device.minAvailableVideoZoomFactor
        let maxAvail = device.maxAvailableVideoZoomFactor
        let hi = maxAvail
        let z = max(lo, min(requestedZoom, hi))
        do {
            try device.lockForConfiguration()
            device.videoZoomFactor = z
            device.unlockForConfiguration()
            Task { @MainActor in self.logger?.log("zoom適用: videoZoomFactor=\(z) 最大\(maxAvail)") }
        } catch {
            Task { @MainActor in self.logger?.log("zoom lock失敗: \(error.localizedDescription)") }
        }
    }

    // sessionQueue 上で呼ぶこと。requestedExposureBias を device.setExposureTargetBias へ反映する。
    // 露出バイアスはデバイス級プロパティで photoOutput(撮影)と videoOutput(/frame)の両方に効く。
    // 自動露出(AE)の目標値をずらす方式なので、AEモード自体は連続オートのまま維持される。
    // 戻り値: バイアス値を実際に変更したか（変更時は撮影前に waitForExposureSettleLocked が必要）。
    @discardableResult
    private func applyExposureBiasLocked() -> Bool {
        guard let device else { return false }
        let lo = device.minExposureTargetBias
        let hi = device.maxExposureTargetBias
        let b = max(lo, min(requestedExposureBias, hi))
        guard abs(device.exposureTargetBias - b) > 0.001 else { return false } // 冪等(未変更なら触らない)
        do {
            try device.lockForConfiguration()
            device.setExposureTargetBias(b, completionHandler: nil)
            device.unlockForConfiguration()
            Task { @MainActor in self.logger?.log("露出補正適用: exposureTargetBias=\(b)EV (範囲\(lo)〜\(hi))") }
            return true
        } catch {
            Task { @MainActor in self.logger?.log("露出補正 lock失敗: \(error.localizedDescription)") }
            return false
        }
    }

    // sessionQueue 上で呼ぶこと。setExposureTargetBias は非同期で、AE(ISO/シャッター)が
    // 追従するまで数百msかかる。収束を待たずにシャッターを切ると旧露出のまま写る
    // （2026-07-27 実測: ライブは反映・撮影は無反映のズレの原因）。バイアス変更時のみ呼ぶ。
    // タイムアウト時はそのまま撮影続行（fail-open）。
    private func waitForExposureSettleLocked() {
        guard let device else { return }
        let deadline = CACurrentMediaTime() + 1.2
        while device.isAdjustingExposure {
            if CACurrentMediaTime() >= deadline {
                Task { @MainActor in self.logger?.log("⚠ 露出収束待ちタイムアウト(1.2s) そのまま撮影続行") }
                return
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        Thread.sleep(forTimeInterval: 0.15) // AE確定直後の残り香を吸収
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
