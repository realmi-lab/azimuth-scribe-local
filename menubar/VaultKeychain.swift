import Foundation
import Security
import LocalAuthentication
import Darwin

struct VaultStatus: Decodable {
    let initialized, locked, locking: Bool
    let id: String?
    let authMode: String?
    enum CodingKeys: String, CodingKey {
        case initialized, locked, locking, id
        case authMode = "auth_mode"
    }
}

enum NativeVaultChannel {
    static func call(_ payload: [String: Any], root: URL) throws -> [String: Any] {
        let path = root.appendingPathComponent("data/.native-auth.sock").path
        var address = sockaddr_un()
        guard path.utf8.count < MemoryLayout.size(ofValue: address.sun_path) else {
            throw failure("Mac 인증 서버 경로가 너무 깁니다. 설치된 앱에서 실행하세요.")
        }
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { bytes in
            path.withCString { _ = strlcpy(bytes.baseAddress!.assumingMemoryBound(to: CChar.self), $0, bytes.count) }
        }
        let socketFD = socket(AF_UNIX, SOCK_STREAM, 0)
        guard socketFD >= 0 else { throw failure("Mac 인증 서버에 연결할 수 없습니다.") }
        defer { close(socketFD) }
        var noSignal: Int32 = 1
        setsockopt(socketFD, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
        var timeout = timeval(tv_sec: 600, tv_usec: 0)
        setsockopt(socketFD, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(socketFD, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(socketFD, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard connected == 0 else { throw failure("Mac 인증 서버에 연결할 수 없습니다. 서버 시작을 확인하세요.") }
        var message = try JSONSerialization.data(withJSONObject: payload)
        message.append(10)
        try message.withUnsafeBytes { bytes in
            var sent = 0
            while sent < bytes.count {
                let count = write(socketFD, bytes.baseAddress!.advanced(by: sent), bytes.count - sent)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw failure("Mac 인증 요청을 전송하지 못했습니다.") }
                sent += count
            }
        }
        var response = Data(), buffer = [UInt8](repeating: 0, count: 2048)
        while !response.contains(10) && response.count <= 8192 {
            let count = read(socketFD, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw failure("Mac 인증 결과를 받지 못했습니다. 다시 인증하세요.") }
            response.append(contentsOf: buffer.prefix(count))
        }
        guard response.count <= 8192,
              let result = try JSONSerialization.jsonObject(with: response) as? [String: Any] else {
            throw failure("Mac 인증 결과를 읽을 수 없습니다.")
        }
        guard result["ok"] as? Bool == true else { throw failure(result["error"] as? String ?? "보관함을 열 수 없습니다.") }
        return result
    }

    static func failure(_ message: String) -> NSError {
        NSError(domain: "NativeVault", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}

enum VaultKeychain {
    private static let legacyService = "net.realmi.local-encoder.vault.v1"
    private static let service = "net.realmi.local-encoder.vault.macos.v2"

    private static func query(_ service: String, _ identity: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: identity]
    }

    private static func failure(_ status: OSStatus) -> NSError {
        NativeVaultChannel.failure("Mac 키체인을 사용할 수 없습니다 (\(status)). 기존 보관함 파일은 보존됩니다.")
    }

    // Call only after a fresh successful system authentication, in the same operation.
    private static func read(_ service: String, identity: String) throws -> String? {
        var item = query(service, identity)
        item[kSecReturnData as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(item as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, let secret = String(data: data, encoding: .utf8) else { throw failure(status) }
        return secret
    }

    private static func store(_ secret: String, identity: String) throws {
        // Ad-hoc builds use the login keychain and an ACL for this signed app.
        // Every read above is reached only after the system authentication below.
        var access: SecAccess?
        let created = SecAccessCreate("Local LLM Encoder Mac 인증 키" as CFString, nil, &access)
        guard created == errSecSuccess, let access else { throw failure(created) }
        var item = query(service, identity)
        item[kSecAttrAccess as String] = access
        item[kSecAttrLabel as String] = "Local LLM Encoder Mac 인증 키"
        item[kSecValueData as String] = Data(secret.utf8)
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw failure(status) }
        guard try read(service, identity: identity) == secret else { throw failure(errSecDecode) }
    }

    private static func authenticate(_ method: String, context: LAContext) throws {
        context.localizedCancelTitle = "취소"
        context.localizedFallbackTitle = ""
        context.touchIDAuthenticationAllowableReuseDuration = 0
        let done = DispatchSemaphore(value: 0)
        var accepted = false
        var authenticationError: Error?
        let reply: (Bool, Error?) -> Void = { success, error in
            accepted = success; authenticationError = error; done.signal()
        }
        let reason = "암호화된 녹음과 메모 보관함을 엽니다."
        if method == "touchid" {
            var error: NSError?
            guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error), context.biometryType == .touchID else {
                throw NativeVaultChannel.failure("Touch ID를 사용할 수 없습니다. Mac 로그인 암호로 인증하세요.")
            }
            context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason, reply: reply)
        } else if method == "password" {
            // A passcode-only constraint excludes Apple Watch and app passwords.
            var error: Unmanaged<CFError>?
            guard let control = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .devicePasscode, &error) else {
                throw NativeVaultChannel.failure("Mac 로그인 암호 인증을 시작할 수 없습니다.")
            }
            context.evaluateAccessControl(control, operation: .useItem, localizedReason: reason, reply: reply)
        } else { throw NativeVaultChannel.failure("지원하지 않는 Mac 인증 방식입니다.") }
        done.wait()
        guard accepted else {
            if let error = authenticationError as? LAError, [.userCancel, .systemCancel, .appCancel].contains(error.code) {
                throw NativeVaultChannel.failure("인증을 취소했습니다. 보관함은 잠겨 있습니다.")
            }
            throw authenticationError ?? NativeVaultChannel.failure("Mac 본인 인증을 완료하지 못했습니다.")
        }
    }

    static func open(status: VaultStatus, method: String, context: LAContext, root: URL) throws -> [String: Any] {
        defer { context.invalidate() }
        try authenticate(method, context: context)
        let identity = status.id ?? UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        var nativeSecret = try read(service, identity: identity)
        let legacySecret: String?
        if status.initialized && status.authMode != "macos" {
            guard let existing = try read(legacyService, identity: identity) else {
                throw NativeVaultChannel.failure("기존 보관함의 키체인 연결이 없습니다. 기존 앱에서 키체인 연결을 마친 뒤 다시 시도하세요. 파일은 보존됩니다.")
            }
            legacySecret = existing
        } else { legacySecret = nil }
        if nativeSecret == nil {
            guard !status.initialized || legacySecret != nil else { throw failure(errSecItemNotFound) }
            var bytes = [UInt8](repeating: 0, count: 32)
            let generated = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
            guard generated == errSecSuccess else { throw failure(generated) }
            nativeSecret = Data(bytes).base64EncodedString()
            // Store and verify first. A failed server migration keeps both credentials.
            try store(nativeSecret!, identity: identity)
        }
        var request: [String: Any] = ["id": identity, "secret": nativeSecret!]
        request["action"] = !status.initialized ? "initialize" : legacySecret != nil ? "migrate" : "unlock"
        if let legacySecret { request["legacy_secret"] = legacySecret }
        let result = try NativeVaultChannel.call(request, root: root)
        // Retain the old entry for restoring old backups; it cannot open the new wrapper.
        return result
    }
}
