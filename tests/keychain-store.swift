// Disposable storage probe. It never reads credentials or automates authentication.
import Foundation
import Security
import LocalAuthentication

@main
struct KeychainStoreCheck {
    static func main() throws {
        let identity = "test-" + UUID().uuidString
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                   kSecAttrService as String: "net.realmi.local-encoder.vault.v1",
                                   kSecAttrAccount as String: identity]
        try VaultKeychain.remember("disposable-" + UUID().uuidString, identity: identity)
        defer { SecItemDelete(query as CFDictionary) }
        var attributesQuery = query
        attributesQuery[kSecReturnAttributes as String] = true
        var attributes: CFTypeRef?
        let status = SecItemCopyMatching(attributesQuery as CFDictionary, &attributes)
        guard status == errSecSuccess else { throw NSError(domain: "KeychainStoreCheck", code: Int(status)) }
        print("PASS: isolated Keychain item saved with the app access list; metadata lookup succeeded")
        let context = LAContext()
        print("Device-owner authentication available: \(context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil))")
        context.invalidate()
    }
}
