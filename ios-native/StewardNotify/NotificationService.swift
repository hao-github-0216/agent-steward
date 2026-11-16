import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        bestAttempt = request.content
        do {
            guard let payload = request.content.userInfo["e"] as? String,
                  let key = try PushCrypto.loadKey(),
                  let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
                finish()
                return
            }
            let plain = try PushCrypto.decrypt(keyData: key, payload: payload)
            content.title = plain.title
            content.body = plain.body
            content.userInfo["link"] = plain.link
            content.categoryIdentifier = ""
            content.userInfo.removeValue(forKey: "card")
            if let category = plain.category, ["proposal", "blocked"].contains(category),
               let card = plain.card, !card.isEmpty {
                content.categoryIdentifier = category
                content.userInfo["card"] = card
            }
            bestAttempt = content
        } catch {
            bestAttempt = request.content
        }
        finish()
    }

    override func serviceExtensionTimeWillExpire() {
        finish()
    }

    private func finish() {
        guard let handler = contentHandler, let content = bestAttempt else { return }
        contentHandler = nil
        handler(content)
    }
}
