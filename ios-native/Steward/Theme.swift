// 顏色:用 iOS 的系統顏色(深淺色由系統處理,跟其他 Apple app 一樣),
// 只有強調色用管家網頁的藍(#2f6fdf / 深色 #6b9cff),跟網頁看起來是同一個東西。橘色只用在貓(浮動球)。
import SwiftUI
import UIKit

enum Theme {
    static let accent = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: 0x6B9CFF) : UIColor(hex: 0x2F6FDF) })
    /// 浮動球的底色(網頁 #stewardBall)
    static let ball = Color(UIColor(hex: 0xFFF1DC))
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

/// 工作卡欄位的顏色(跟網頁一樣的意思:提案藍、進行中橘、卡住紅、完成綠)
func columnColor(_ column: String) -> Color {
    switch column {
    case "proposed": Theme.accent
    case "approved", "running": .orange
    case "blocked": .red
    case "done": .green
    default: .secondary
    }
}
