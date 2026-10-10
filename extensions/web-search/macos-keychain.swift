import CoreFoundation
import Darwin
import Foundation
import Security

// 此文件是静态适配器；凭据只从 stdin 读取，不进入参数或输出。
func main() -> Never {
    let arguments = CommandLine.arguments
    guard arguments.count == 3 else { exit(2) }

    let account = arguments[1]
    let service = arguments[2]
    let allowedServices = [
        "pi-web-search-exa",
        "pi-web-search-parallel",
        "pi-web-search-tavily",
        "pi-web-search-firecrawl",
        "pi-web-search-serpapi",
    ]
    guard !account.isEmpty, allowedServices.contains(service) else { exit(2) }

    let secret = FileHandle.standardInput.readDataToEndOfFile()
    guard !secret.isEmpty, secret.count <= 4096,
          secret.allSatisfy({ $0 >= 0x21 && $0 <= 0x7e }) else { exit(2) }

    var query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrAccount as String: account,
        kSecAttrService as String: service,
    ]
    let attributes: [String: Any] = [kSecValueData as String: secret]
    let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)

    if updateStatus == errSecItemNotFound {
        query[kSecValueData as String] = secret
        guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else { exit(4) }
    } else if updateStatus != errSecSuccess {
        exit(3)
    }

    exit(0)
}

main()
