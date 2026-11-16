import SwiftUI

@main
struct StewardWatchApp: App {
    @StateObject private var store = WatchStore()

    var body: some Scene {
        WindowGroup {
            WatchProjectsView()
                .environmentObject(store)
        }
    }
}
