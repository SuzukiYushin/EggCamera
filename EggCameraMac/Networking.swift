import Foundation
import Network

// 手書きHTTPサーバ（TriggerReceiverServer / UploadReceiverServer）が共有する
// リクエスト完了判定とレスポンス送信。各サーバで重複していたものを集約。
enum HTTPMessage {
    private static let headerSeparator = Data([0x0D, 0x0A, 0x0D, 0x0A])

    /// ヘッダの Content-Length 分のボディを受信し終えたか
    static func isComplete(_ data: Data) -> Bool {
        guard let range = data.range(of: headerSeparator) else { return false }

        let header = String(data: data[..<range.lowerBound], encoding: .utf8) ?? ""
        let contentLength = header
            .components(separatedBy: "\r\n")
            .first(where: { $0.lowercased().hasPrefix("content-length:") })
            .flatMap { line -> Int? in
                let value = line.split(separator: ":", maxSplits: 1).last?.trimmingCharacters(in: .whitespaces)
                return value.flatMap(Int.init)
            } ?? 0

        return data.count - range.upperBound >= contentLength
    }

    /// ステータスのみの空レスポンスを送って接続を閉じる
    static func sendStatus(_ status: Int, _ message: String, on connection: NWConnection) {
        let response = [
            "HTTP/1.1 \(status) \(message)",
            "Content-Length: 0",
            "Connection: close",
            "", ""
        ].joined(separator: "\r\n")
        connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}

// ISO8601 日付で統一した JSON コーダ。各ファイルの private 重複を集約。
extension JSONEncoder {
    static let iso8601: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
}

extension JSONDecoder {
    static let iso8601: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}
