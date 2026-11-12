import Foundation
import Security
import LocalAuthentication

struct VaultStatus: Decodable {
    let initialized, locked, locking: Bool
    let id: String?
}

enum VaultKeychain {
    private static let service = "net.realmi.local-encoder.vault.v1"

    private static func query(_ identity: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: identity]
    }

    private static func failure(_ status: OSStatus) -> NSError {
        NSError(domain: "VaultKeychain", code: Int(status), userInfo: [NSLocalizedDescriptionKey:
            "키체인 본인 인증을 완료하지 못했습니다 (\(status)). 보관함 비밀번호로 열 수 있습니다."])
    }

    static func remember(_ password: String, identity: String) throws {
        // This locally built app has no Apple provisioning profile. The login
        // keychain supports it; a nil trusted list grants trust only to this app.
        // Authentication is required below before any secret is retrieved.
        var access: SecAccess?
        let accessStatus = SecAccessCreate("Local LLM Encoder 보관함" as CFString, nil, &access)
        guard accessStatus == errSecSuccess, let access else { throw failure(accessStatus) }
        var item = query(identity)
        item[kSecAttrAccess as String] = access
        item[kSecAttrLabel as String] = "Local LLM Encoder 보관함"
        item[kSecValueData as String] = Data(password.utf8)
        let status = SecItemAdd(item as CFDictionary, nil)
        // An existing protected credential is retained; no silent replacement.
        guard status == errSecSuccess || status == errSecDuplicateItem else { throw failure(status) }
    }

    static func password(identity: String) throws -> String {
        let context = LAContext()
        context.localizedReason = "암호화된 녹음 보관함을 엽니다."
        context.localizedCancelTitle = "취소"
        defer { context.invalidate() }
        let authenticated = DispatchSemaphore(value: 0)
        var accepted = false
        var authenticationError: Error?
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: context.localizedReason) { success, error in
            accepted = success
            authenticationError = error
            authenticated.signal()
        }
        authenticated.wait()
        guard accepted else { throw authenticationError ?? failure(errSecUserCanceled) }
        var item = query(identity)
        item[kSecReturnData as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(item as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data, let password = String(data: data, encoding: .utf8) else { throw failure(status) }
        return password
    }
}
