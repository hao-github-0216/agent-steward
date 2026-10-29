// 跟管家網頁同一套顏色(web/index.html 的 :root,淺色/深色各一組),兩邊看起來是同一個東西。
// 橘色只用在貓(浮動球),其他強調色都是網頁的藍。
import SwiftUI
import UIKit

enum Theme {
    private static func pair(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }

    static let bg = pair(0xF6F5F2, 0x15171A)
    static let panel = pair(0xFFFFFF, 0x1D2024)
    static let ink = pair(0x1F2328, 0xE6E6E6)
    static let muted = pair(0x6B7280, 0x9AA1AA)
    static let line = pair(0xE3E1DC, 0x2C3036)
    static let accent = pair(0x2F6FDF, 0x6B9CFF)
    static let ok = pair(0x1F8A4C, 0x4CC38A)
    static let warn = pair(0xB7791F, 0xE0B04F)
    static let bad = pair(0xC2410C, 0xF08A5D)
    static let chip = pair(0xEEF2F9, 0x252A33)
    static let col = pair(0xEFEDE8, 0x191C20)
    /// 浮動球的底色(網頁 #stewardBall)
    static let ball = Color(UIColor(hex: 0xFFF1DC))
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

/// 網頁的 button.small(白底細框小按鈕);primary = 藍底白字
struct SmallButtonStyle: ButtonStyle {
    var primary = false
    var compact = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: compact ? 12 : 13))
            .padding(.horizontal, compact ? 7 : 10).padding(.vertical, 5)
            .foregroundStyle(primary ? Color.white : Theme.ink)
            .background(primary ? Theme.accent : Theme.panel, in: RoundedRectangle(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(primary ? Theme.accent : Theme.line))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

extension ButtonStyle where Self == SmallButtonStyle {
    static var small: SmallButtonStyle { SmallButtonStyle() }
    static var smallPrimary: SmallButtonStyle { SmallButtonStyle(primary: true) }
}

/// 網頁的 .card-panel:白底、細框、圓角 12、淡陰影
struct CardPanel: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 16).padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.panel, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
            .shadow(color: .black.opacity(0.05), radius: 4, y: 1)
    }
}

/// 網頁 h4 的小標題(12px、灰、粗)
struct SectionLabel: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.muted)
            .padding(.top, 8).padding(.bottom, 2)
    }
}

/// 網頁的勾選框(☐ 文字)
struct CheckBox: View {
    let title: String
    @Binding var isOn: Bool

    var body: some View {
        Button { isOn.toggle() } label: {
            HStack(spacing: 6) {
                Image(systemName: isOn ? "checkmark.square.fill" : "square")
                    .foregroundStyle(isOn ? Theme.accent : Theme.muted)
                Text(title).foregroundStyle(Theme.ink)
            }
            .font(.system(size: 14))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

/// 網頁的 .chip(淡藍底小標籤)
struct Chip: View {
    let text: String
    var dim = false
    var body: some View {
        Text(text).font(.system(size: 12))
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(Theme.chip, in: Capsule())
            .foregroundStyle(dim ? Theme.muted : Theme.ink)
    }
}
