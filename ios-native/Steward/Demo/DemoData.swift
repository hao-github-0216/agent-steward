import Foundation

enum DemoData {
    // 示範內容跟隨系統首選語言，不使用介面字串目錄。
    private static func text(_ chinese: String, _ english: String) -> String {
        (Locale.preferredLanguages.first ?? "").hasPrefix("zh") ? chinese : english
    }

    static let baseURL = URL(string: "https://demo.agentsteward.invalid/")!
    static let writeNotice = text("示範模式不會真的執行", "Demo mode does not run real actions") // i18n-ok: 依系統語言選擇的示範資料
    static let answer = text("這是示範模式，沒有連到真的管家。裝好電腦版的專案管家後，在這裡問的問題會由你設定的 AI 回答。", "This is demo mode, with no connection to a real steward. After you install Agent Steward on your computer, the AI you configure will answer questions here.") // i18n-ok: 依系統語言選擇的示範資料
    static let projectID = "demo-weather"
    private static let now = Date()
    private static let settings = SettingsSample(demo: true)

    private static func at(_ secondsAgo: TimeInterval) -> String {
        ISO8601DateFormatter().string(from: now.addingTimeInterval(-secondsAgo))
    }

    static let projects: [[String: Any]] = [
        ["id": projectID, "name": text("天氣小幫手", "Weather Helper"), "root": "/demo/weather-helper", "kind": "project", "status": "active", "private": false, // i18n-ok: 依系統語言選擇的示範資料
         "lastActivityAt": at(120),
         "state": ["goal": text("做一個簡單的 **Python 天氣網頁 App**。\n讓出門前查天氣更方便，也練習把程式、筆記和工作卡放在一起管理。", "Build a simple **Python weather web app**.\nMake it easier to check the weather before heading out, and practice managing code, notes, and cards together."), // i18n-ok: 依系統語言選擇的示範資料
                   "progress": text("- 已完成天氣摘要與基本頁面。\n- 正在加入降雨提醒、整理手機版排版。\n- 所有畫面目前都使用範例天氣資料。", "- Weather summaries and the basic page are complete.\n- Rain reminders and the mobile layout are in progress.\n- All screens currently use sample weather data."), // i18n-ok: 依系統語言選擇的示範資料
                   "nextSteps": [text("完成降雨提醒的測試。", "Finish testing rain reminders."), text("確認手機版頁面後，再加入一週預報。", "Check the mobile page, then add a weekly forecast.")], // i18n-ok: 依系統語言選擇的示範資料
                   "blockers": [text("還沒決定天氣圖示的樣式，圖示工作卡先暫停。", "The weather icon style is undecided, so the icon card is on hold.")], // i18n-ok: 依系統語言選擇的示範資料
                   "decisions": [text("先把今日天氣做好，再增加其他功能。", "Get today’s weather right before adding more features."), text("用 Python 提供資料，網頁保持簡單。", "Use Python to provide data and keep the web page simple.")], // i18n-ok: 依系統語言選擇的示範資料
                   "recent": [["at": at(600), "agent": text("範例程式助手", "Sample Coding Assistant"), "summary": text("完成天氣摘要與測試，補上使用說明。", "Completed weather summaries and tests, and added usage instructions.")], // i18n-ok: 依系統語言選擇的示範資料
                              ["at": at(1800), "agent": text("範例筆記助手", "Sample Notes Assistant"), "summary": text("整理了降雨提醒的規格。", "Organized the rain reminder requirements.")]], // i18n-ok: 依系統語言選擇的示範資料
                   "updatedAt": at(120)]],
        ["id": "demo-notes", "name": text("讀書筆記", "Reading Notes"), "root": "/demo/reading-notes", "kind": "project", "status": "active", "private": false, // i18n-ok: 依系統語言選擇的示範資料
         "lastActivityAt": at(3600),
         "state": ["goal": text("用 Markdown 整理虛構的讀書練習。\n每一章留下摘要和可以實作的小問題。", "Use Markdown to organize fictional reading exercises.\nKeep a summary and small practical questions for each chapter."), // i18n-ok: 依系統語言選擇的示範資料
                   "progress": text("- 建好章節目錄與筆記範本。\n- 已整理兩章摘要，正在補上練習題。", "- Created the chapter index and note template.\n- Summarized two chapters; practice questions are in progress."), // i18n-ok: 依系統語言選擇的示範資料
                   "nextSteps": [text("補上第三章重點。", "Add the key points from chapter three."), text("把練習題連到對應的筆記。", "Link practice questions to the relevant notes.")], // i18n-ok: 依系統語言選擇的示範資料
                   "blockers": [text("第三章的練習解答還在整理。", "The answers to the chapter three exercises are still being organized.")], "updatedAt": at(3600)]], // i18n-ok: 依系統語言選擇的示範資料
        ["id": "demo-errands", "name": text("雜務", "Misc"), "kind": "builtin", "status": "active", // i18n-ok: 依系統語言選擇的示範資料
         "state": ["goal": text("收集還沒歸到專案的待辦事項。", "Collect tasks that have not yet been assigned to a project."), "progress": text("已整理範例待辦清單。", "Organized the sample to-do list."), // i18n-ok: 依系統語言選擇的示範資料
                   "nextSteps": [text("把相關的事項歸到各個專案。", "Move related tasks into their projects.")], "blockers": [String](), "updatedAt": at(7200)]] // i18n-ok: 依系統語言選擇的示範資料
    ]

    private static func card(_ id: String, _ title: String, _ column: String, _ instructions: String, _ criteria: String,
                             ago: TimeInterval, note: String? = nil, thread: [[String: Any]]? = nil) -> [String: Any] {
        var value: [String: Any] = ["id": id, "projectId": projectID, "title": title, "agent": text("範例程式助手", "Sample Coding Assistant"), // i18n-ok: 依系統語言選擇的示範資料
                                    "instructions": instructions, "doneCriteria": criteria, "column": column,
                                    "attempts": column == "proposed" ? 0 : 1, "createdAt": at(86_400), "updatedAt": at(ago)]
        if let note { value["note"] = note }
        if let thread { value["thread"] = thread }
        return value
    }

    static let cards: [[String: Any]] = [
        card("demo-card-01", text("加入一週天氣預報", "Add a weekly weather forecast"), "proposed", text("在今日天氣下方加入未來七天的預報卡片，先使用範例資料。", "Add forecast cards for the next seven days below today’s weather, using sample data first."), text("每天都顯示溫度與天氣摘要，窄螢幕也能閱讀。", "Show the temperature and weather summary for each day, readable even on narrow screens."), ago: 300), // i18n-ok: 依系統語言選擇的示範資料
        card("demo-card-02", text("增加深色模式", "Add dark mode"), "proposed", text("依照裝置的外觀設定切換背景與文字顏色。", "Switch background and text colors to match the device’s appearance settings."), text("亮色、深色模式的文字都有足夠對比。", "Text has enough contrast in both light and dark modes."), ago: 900), // i18n-ok: 依系統語言選擇的示範資料
        card("demo-card-03", text("補上資料驗證測試", "Add data validation tests"), "approved", text("為範例天氣資料加入欄位檢查與測試。", "Add field validation and tests for the sample weather data."), text("缺少溫度或天氣摘要時，能顯示清楚的提示。", "Show a clear message when the temperature or weather summary is missing."), ago: 1500), // i18n-ok: 依系統語言選擇的示範資料
        card("demo-card-04", text("加入降雨提醒", "Add rain reminders"), "running", text("降雨機率超過門檻時，在網頁上顯示帶傘提醒。", "Show an umbrella reminder on the page when the chance of rain exceeds the threshold."), text("不同降雨機率都有測試，提醒不會重複出現。", "Test different rain probabilities and ensure reminders are not repeated."), ago: 120, note: text("正在確認提醒文字與測試案例。", "Checking the reminder text and test cases.")), // i18n-ok: 依系統語言選擇的示範資料
        card("demo-card-05", text("調整手機版排版", "Adjust the mobile layout"), "running", text("調整天氣卡片的間距，讓小螢幕可以單手操作。", "Adjust weather card spacing so the page can be used one-handed on small screens."), text("主要資訊不需要左右捲動，按鈕大小適合觸控。", "Key information needs no horizontal scrolling, and buttons are sized for touch."), ago: 420), // i18n-ok: 依系統語言選擇的示範資料
        card("demo-card-06", text("選擇天氣圖示", "Choose weather icons"), "blocked", text("為晴天、陰天與下雨選擇同一套圖示。", "Choose a single icon set for sunny, cloudy, and rainy weather."), text("圖示風格一致，並附上文字說明。", "Icons have a consistent style and include text descriptions."), ago: 2400, note: text("卡住原因：還沒決定要用線條或填色圖示，等確認樣式再繼續。", "Blocked: the choice between outline and filled icons is still pending. Continue after the style is confirmed.")), // i18n-ok: 依系統語言選擇的示範資料
        card("demo-card-07", text("完成今日天氣摘要", "Complete today’s weather summary"), "done", text("用 Python 整理範例溫度和天氣描述。", "Use Python to format sample temperatures and weather descriptions."), text("網頁能顯示今日天氣摘要，測試通過。", "The page displays today’s weather summary and tests pass."), ago: 600, note: text("已完成摘要與範例測試。", "Completed the summary and sample tests."), thread: [ // i18n-ok: 依系統語言選擇的示範資料
            ["id": "demo-turn-01", "role": "user", "text": text("如果今天沒有天氣資料，會顯示什麼？", "What will be displayed if there is no weather data today?"), "at": at(1200), "status": "answered"], // i18n-ok: 依系統語言選擇的示範資料
            ["id": "demo-turn-02", "role": "assistant", "text": text("會顯示 **暫時沒有天氣資料**，不會把缺少的溫度當成零度。\n\n也補上了空資料的測試。", "It will display **Weather data is temporarily unavailable**, rather than treating a missing temperature as zero degrees.\n\nI also added a test for empty data."), "at": at(600)] // i18n-ok: 依系統語言選擇的示範資料
        ]),
        card("demo-card-08", text("撰寫專案 README", "Write the project README"), "done", text("補上專案目標、檔案說明與本機執行方式。", "Add the project goal, file descriptions, and instructions for running locally."), text("第一次看到專案也能照著說明閱讀程式。", "A first-time reader can follow the instructions to read the code."), ago: 5400) // i18n-ok: 依系統語言選擇的示範資料
    ]

    static let suggestions = [text("這個專案現在做到哪裡？", "How far along is this project?"), text("下一步可以先做什麼？", "What could we do next?"), text("有哪些工作卡需要我決定？", "Which cards need my decision?")] // i18n-ok: 依系統語言選擇的示範資料
    private static let conversation: [[String: Any]] = [
        ["id": "demo-chat-01", "role": "me", "text": text("幫我整理天氣小幫手的目標。", "Summarize the goal of Weather Helper for me."), "at": at(3600)], // i18n-ok: 依系統語言選擇的示範資料
        ["id": "demo-chat-02", "role": "bot", "text": text("目標是做一個 **出門前一眼看懂** 的天氣網頁。\n\n- 先顯示今日溫度與天氣摘要。\n- 接著加入降雨提醒。\n- 最後再擴充一週預報。", "The goal is a weather page you can **understand at a glance before heading out**.\n\n- Start with today’s temperature and weather summary.\n- Then add rain reminders.\n- Finally, expand to a weekly forecast."), "at": at(3540)], // i18n-ok: 依系統語言選擇的示範資料
        ["id": "demo-chat-03", "role": "me", "text": text("現在的進度和下一步呢？可以給我一小段範例嗎？", "What is the current progress and what comes next? Can you give me a short example?"), "at": at(1800)], // i18n-ok: 依系統語言選擇的示範資料
        ["id": "demo-chat-04", "role": "bot", "text": text("**今日天氣摘要已完成**，接下來先把降雨提醒做好。\n\n1. 補上不同降雨機率的測試。\n2. 調整手機版的卡片間距。\n3. 確認天氣圖示的樣式。\n\n```python\ndef umbrella_hint(rain_chance):\n    return \"記得帶傘\" if rain_chance >= 60 else \"放心出門\"\n```\n\nMarkdown 也可以顯示數學式，例如 $E=mc^2$。\n\n這些都是範例資料，沒有真的派工或執行程式。", "**Today’s weather summary is complete**. Next, focus on rain reminders.\n\n1. Add tests for different rain probabilities.\n2. Adjust card spacing on mobile.\n3. Confirm the weather icon style.\n\n```python\ndef umbrella_hint(rain_chance):\n    return \"Bring an umbrella\" if rain_chance >= 60 else \"Ready to head out\"\n```\n\nMarkdown can also display math, such as $E=mc^2$.\n\nThis is all sample data. No tasks have actually been dispatched and no code has been run."), "at": at(1740)] // i18n-ok: 依系統語言選擇的示範資料
    ]

    private static let originalPython = text( // i18n-ok: 依系統語言選擇的示範資料
    """
    def weather_summary(temperature, description):
        return f"{temperature}°C，{description}"


    print(weather_summary(24, "晴時多雲"))
    """, // i18n-ok: 依系統語言選擇的示範資料
    """
    def weather_summary(temperature, description):
        return f"{temperature}°C, {description}"


    print(weather_summary(24, "Partly cloudy"))
    """) + "\n"

    static let files: [String: String] = [
        "weather.py": text( // i18n-ok: 依系統語言選擇的示範資料
        """
        def weather_summary(temperature, description):
            if temperature is None:
                return "暫時沒有天氣資料"
            return f"今日 {temperature}°C，{description}"


        print(weather_summary(24, "晴時多雲"))
        """, // i18n-ok: 依系統語言選擇的示範資料
        """
        def weather_summary(temperature, description):
            if temperature is None:
                return "Weather data is temporarily unavailable"
            return f"Today: {temperature}°C, {description}"


        print(weather_summary(24, "Partly cloudy"))
        """) + "\n",
        "docs/notes.md": text( // i18n-ok: 依系統語言選擇的示範資料
        """
        # 天氣小幫手筆記

        ## 下一步
        - [x] 完成今日天氣摘要
        - [ ] 加入降雨提醒
        - [ ] 調整手機版排版

        **練習重點**：先用範例資料把畫面做好，再接上資料來源。

        這份筆記完全虛構，只用來示範 Markdown 預覽。
        """, // i18n-ok: 依系統語言選擇的示範資料
        """
        # Weather Helper Notes

        ## Next steps
        - [x] Complete today’s weather summary
        - [ ] Add rain reminders
        - [ ] Adjust the mobile layout

        **Practice focus**: build the interface with sample data first, then connect a data source.

        These notes are entirely fictional and only demonstrate Markdown preview.
        """) + "\n",
        "README.md": text( // i18n-ok: 依系統語言選擇的示範資料
        """
        # 天氣小幫手

        一個用 Python 練習的天氣網頁 App。

        ![範例天氣圖示](docs/weather.svg)

        ## 功能
        - 今日天氣摘要
        - 降雨提醒（製作中）
        - 手機也能閱讀的版面

        ## 檔案
        | 檔案 | 說明 |
        | --- | --- |
        | weather.py | 整理今日天氣 |
        | docs/notes.md | 開發筆記 |

        ## 試讀程式
        ```python
        python weather.py
        ```

        所有專案、路徑與對話都是虛構範例，沒有連到任何管家。
        """, // i18n-ok: 依系統語言選擇的示範資料
        """
        # Weather Helper

        A weather web app for practicing Python.

        ![Sample weather icon](docs/weather.svg)

        ## Features
        - Today’s weather summary
        - Rain reminders (in progress)
        - A mobile-friendly layout

        ## Files
        | File | Description |
        | --- | --- |
        | weather.py | Format today’s weather |
        | docs/notes.md | Development notes |

        ## Try the code
        ```python
        python weather.py
        ```

        All projects, paths, and conversations are fictional examples, with no connection to any steward.
        """) + "\n"
    ]

    private static let weatherImage = text( // i18n-ok: 依系統語言選擇的示範資料
    """
    <svg xmlns="http://www.w3.org/2000/svg" width="320" height="96" viewBox="0 0 320 96">
      <rect width="320" height="96" rx="16" fill="#eaf3ff"/>
      <circle cx="52" cy="48" r="24" fill="#ffc857"/>
      <text x="96" y="44" font-size="22" fill="#243b53">24°C</text>
      <text x="96" y="72" font-size="16" fill="#243b53">範例天氣：晴時多雲</text>
    </svg>
    """, // i18n-ok: 依系統語言選擇的示範資料
    """
    <svg xmlns="http://www.w3.org/2000/svg" width="320" height="96" viewBox="0 0 320 96">
      <rect width="320" height="96" rx="16" fill="#eaf3ff"/>
      <circle cx="52" cy="48" r="24" fill="#ffc857"/>
      <text x="96" y="44" font-size="22" fill="#243b53">24°C</text>
      <text x="96" y="72" font-size="16" fill="#243b53">Sample: Partly cloudy</text>
    </svg>
    """)

    private static let commits: [[String: Any]] = [
        ("a1b2c3d", text("補上今日天氣摘要的測試", "Add tests for today’s weather summary")), ("b2c3d4e", text("加入天氣摘要", "Add weather summaries")), ("c3d4e5f", text("整理開發筆記", "Organize development notes")), // i18n-ok: 依系統語言選擇的示範資料
        ("d4e5f6a", text("補上專案使用說明", "Add project usage instructions")), ("e5f6a7b", text("建立天氣小幫手", "Create Weather Helper")) // i18n-ok: 依系統語言選擇的示範資料
    ].enumerated().map { index, entry in
        ["hash": entry.0 + String(repeating: "0", count: 33), "short": entry.0, "author": text("範例作者", "Sample Author"), // i18n-ok: 依系統語言選擇的示範資料
         "date": at(Double(index + 1) * 7200), "subject": entry.1]
    }

    private static let worktrees: [[String: Any]] = [
        ["id": "main", "path": "/demo/weather-helper", "cwd": "/demo/weather-helper", "exists": true, "source": "main", "branch": "main",
         "head": commits[0]["hash"]!, "dirty": 1, "changed": 1, "relevant": true, "folder": "", "lastModified": at(120)],
        ["id": "demo-forecast", "path": "/demo/forecast-preview", "cwd": "/demo/forecast-preview", "exists": true, "source": "manual", "branch": "forecast-preview",
         "head": commits[0]["hash"]!, "dirty": 0, "changed": 0, "ahead": 1, "behind": 0, "relevant": true, "folder": "", "lastModified": at(900)]
    ]

    struct Response {
        var status = 200
        var contentType = "application/json; charset=utf-8"
        var data: Data
        var eventStream = false
        var write = false
    }

    private static func json(_ value: Any, status: Int = 200, write: Bool = false) -> Response {
        Response(status: status, data: (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data(), write: write)
    }

    private static func missing() -> Response { json(["error": text("示範模式沒有這個功能", "This feature is not available in demo mode")], status: 404) } // i18n-ok: 依系統語言選擇的示範資料

    private static func body(_ request: URLRequest) -> [String: Any] {
        if let data = request.httpBody { return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
        guard request.value(forHTTPHeaderField: "content-type")?.contains("application/json") == true,
              let stream = request.httpBodyStream else { return [:] }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(contentsOf: buffer.prefix(count))
        }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    static func response(for request: URLRequest) -> Response {
        guard let url = request.url else { return missing() }
        let path = url.pathComponents.filter { $0 != "/" }
        let method = request.httpMethod ?? "GET"
        let payload = body(request)
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func q(_ name: String) -> String { query.first { $0.name == name }?.value ?? "" }
        let success: [String: Any] = ["ok": true]

        if url.path == "/api/settings" || url.path.hasPrefix("/api/settings/") || url.path.hasPrefix("/api/auth/") ||
            ["/api/push/status", "/api/push/test", "/api/desktop/update"].contains(url.path) {
            let body = try? JSONSerialization.data(withJSONObject: payload)
            let (status, object) = settings.response(for: request, body: body)
            return json(object, status: status, write: status < 400 && method != "GET")
        }

        switch (method, path.joined(separator: "/")) {
        case ("GET", "api/board"): return json(["projects": projects, "cards": cards, "spaceInfo": [String: Any](), "setup": ["missing": [String]()]])
        case ("GET", "api/projects"): return json(["projects": projects])
        case ("POST", "api/projects"): return json(["ok": true, "id": projectID], write: true)
        case ("GET", "api/agents"): return json(["agents": [["id": "demo-coder", "name": text("範例程式助手", "Sample Coding Assistant")], ["id": "demo-writer", "name": text("範例筆記助手", "Sample Notes Assistant")]]]) // i18n-ok: 依系統語言選擇的示範資料
        case ("GET", "api/current"): return json(["project": projectID, "source": "demo"])
        case ("PUT", "api/current"): return json(success, write: true)
        case ("GET", "api/worktree-counts"): return json(["counts": [projectID: 1, "demo-notes": 0, "demo-errands": 0]])
        case ("POST", "api/push/register"), ("POST", "api/terminal/focus"), ("POST", "api/snap/agent"):
            return json(success, write: true)
        case ("GET", "api/events"):
            return Response(contentType: "text/event-stream", data: Data(": ping\n\n".utf8), eventStream: true)
        case ("POST", "api/chat"):
            return chatReply(message: payload["message"] as? String ?? "")
        default: break
        }

        if path.count >= 3, path[0] == "api", path[1] == "chat", projects.contains(where: { $0["id"] as? String == path[2] }) {
            let operation = path.dropFirst(3).joined(separator: "/")
            switch (method, operation) {
            case ("GET", ""): return json(["items": q("before").isEmpty ? conversation : [], "more": false])
            case ("DELETE", ""): return json(success, write: true)
            case ("GET", "suggest"), ("POST", "suggest"): return json(["items": suggestions], write: method == "POST")
            case ("POST", "draft"):
                return chatReply(message: payload["message"] as? String ?? "", draft: true)
            default:
                if method == "POST", path.count == 5, path[3] == "draft" { return chatReply(message: "", draft: true) }
                return missing()
            }
        }

        if path.count >= 3, path[0] == "api", path[1] == "cards", let card = cards.first(where: { $0["id"] as? String == path[2] }) {
            let operation = path.dropFirst(3).joined(separator: "/")
            if method == "POST" {
                if operation == "focus" { return json(success, write: true) }
                if ["", "move", "ask"].contains(operation) || (path.count == 6 && path[3] == "ask" && ["cancel", "retry"].contains(path[5])) {
                    return json(card, write: true)
                }
            }
            return missing()
        }

        if path.count >= 3, path[0] == "api", path[1] == "projects", projects.contains(where: { $0["id"] as? String == path[2] }) {
            if method == "GET", path.count == 4, path[3] == "subdirs" { return json(["dirs": [["name": "docs", "root": "/demo/weather-helper/docs", "project": false]]]) }
            if method == "POST", path.count == 3 || (path.count == 4 && ["bootstrap", "strays", "space-name"].contains(path[3])) {
                return json(["ok": true, "moved": 0, "space": text("天氣小幫手", "Weather Helper")], write: true) // i18n-ok: 依系統語言選擇的示範資料
            }
            return missing()
        }

        guard path.count >= 4, path[0] == "api", path[1] == "code", projects.contains(where: { $0["id"] as? String == path[2] }) else { return missing() }
        let operation = path.dropFirst(3).joined(separator: "/")
        let filePath = q("path")
        switch (method, operation) {
        case ("GET", "tree"):
            if q("dir").isEmpty {
                return json(["entries": [["name": "docs", "rel": "docs", "type": "dir"],
                                         ["name": "README.md", "rel": "README.md", "type": "file", "size": files["README.md"]!.utf8.count],
                                         ["name": "weather.py", "rel": "weather.py", "type": "file", "size": files["weather.py"]!.utf8.count, "git": "M"]]])
            }
            if q("dir") == "docs" { return json(["entries": [["name": "notes.md", "rel": "docs/notes.md", "type": "file", "size": files["docs/notes.md"]!.utf8.count]]]) }
        case ("GET", "file"):
            if let content = files[filePath] { return json(["path": filePath, "name": (filePath as NSString).lastPathComponent, "kind": "text", "content": content, "size": content.utf8.count, "hash": "demo-\(filePath)", "readonly": false]) }
        case ("PUT", "file"):
            return json(["ok": true, "hash": "demo-\(payload["path"] as? String ?? "")"], write: true)
        case ("GET", "raw"):
            if filePath == "docs/weather.svg" { return Response(contentType: "image/svg+xml", data: Data(weatherImage.utf8)) }
            if let content = files[filePath] { return Response(contentType: "text/plain; charset=utf-8", data: Data(content.utf8)) }
        case ("GET", "find"):
            return json(["files": files.keys.sorted().filter { q("q").isEmpty || $0.localizedCaseInsensitiveContains(q("q")) }])
        case ("POST", "stamps"):
            let stamps = Dictionary(uniqueKeysWithValues: Set(payload["paths"] as? [String] ?? []).map { path in
                (path, files[path] == nil ? ["gone": true] as [String: Any] : ["hash": "demo-\(path)"])
            })
            return json(stamps)
        case ("GET", "session"): return json([String: Any]())
        case ("POST", "fs"), ("PUT", "upload"), ("POST", "office/restore"): return json(success, write: true)
        case ("GET", "office/info"): return json(["editing": false, "versions": [String]()])
        case ("GET", "git/status"):
            return json(["repo": true, "branch": "main", "upstream": "origin/main", "ahead": 0, "behind": 0,
                         "staged": [], "unstaged": [["path": "weather.py", "code": " M"]], "untracked": [], "conflicted": []])
        case ("GET", "git/diff"):
            if let content = files[filePath] { return json(["original": filePath == "weather.py" ? originalPython : content, "modified": content]) }
        case ("POST", "git/log"): return json(["out": commits])
        case ("POST", "git/show"):
            if let commit = commits.first(where: { $0["hash"] as? String == payload["commit"] as? String }) {
                return json(["out": ["hash": commit["hash"]!, "author": text("範例作者", "Sample Author"), "date": commit["date"]!, "body": commit["subject"]!, "files": [["path": "weather.py", "code": "M"]]]]) // i18n-ok: 依系統語言選擇的示範資料
            }
        case ("POST", "git/branches"):
            return json(["out": [["name": "main", "current": true, "upstream": "origin/main", "remote": false], ["name": "forecast-preview", "current": false, "remote": false]]])
        case ("POST", "git/commitmsg"): return json(["message": text("調整天氣摘要的顯示文字", "Adjust the weather summary display text")], write: true) // i18n-ok: 依系統語言選擇的示範資料
        case ("POST", let op) where ["git/stage", "git/unstage", "git/discard", "git/commit", "git/checkout", "git/pull", "git/push", "git/fetch"].contains(op):
            return json(success, write: true)
        case ("GET", "worktrees"):
            return json(["repo": true, "repoRoot": "/demo/weather-helper", "target": "main", "items": worktrees])
        case ("GET", "worktrees/tree"):
            return json(["repo": true, "repoRoot": "/demo/weather-helper", "repoName": "weather-helper", "target": "main", "currentFolder": "", "folders": [], "items": worktrees, "leftovers": [],
                         "graph": ["nodes": commits, "branches": [["key": "main", "branch": "main", "forkAt": 0], ["key": "demo-forecast", "branch": "forecast-preview", "forkAt": 1, "ahead": 1]], "truncated": false]])
        case ("POST", "worktrees/ignore"): return json(["added": [], "file": ".gitignore"], write: true)
        case ("POST", "worktrees/untrack"): return json(["untracked": [], "note": writeNotice], write: true)
        default:
            if path.count == 6, path[3] == "worktrees", worktrees.contains(where: { $0["id"] as? String == path[4] }) {
                switch (method, path[5]) {
                case ("GET", "merge"):
                    return json(["target": "main", "branch": "forecast-preview", "commits": [["hash": commits[0]["hash"]!, "subject": text("加入預報卡片", "Add forecast cards")]], // i18n-ok: 依系統語言選擇的示範資料
                                 "files": [["status": "M", "path": "weather.py"]], "stat": "weather.py | 2 ++", "diff": text("+ # 範例預報卡片\n", "+ # Sample forecast cards\n"), "uncommitted": 0]) // i18n-ok: 依系統語言選擇的示範資料
                case ("POST", "merge"): return json(["merged": true, "commit": "a1b2c3d"], write: true)
                case ("POST", "remove"): return json(["removed": true], write: true)
                case ("POST", "chat"): return json(["kind": "new", "agent": text("範例程式助手", "Sample Coding Assistant"), "note": writeNotice], write: true) // i18n-ok: 依系統語言選擇的示範資料
                default: break
                }
            }
        }
        return missing()
    }

    private static func chatReply(message: String, draft: Bool = false) -> Response {
        var bot: [String: Any] = ["id": UUID().uuidString, "role": "bot", "text": answer, "at": at(0)]
        if draft { bot["draft"] = ["title": text("加入一週天氣預報", "Add a weekly weather forecast"), "agent": "demo-coder", "instructions": text("使用範例資料製作預報卡片。", "Use sample data to build forecast cards."), "doneCriteria": text("七天的預報都能閱讀。", "Forecasts for all seven days are readable."), "status": "draft"] } // i18n-ok: 依系統語言選擇的示範資料
        return json(["answer": answer, "me": ["id": UUID().uuidString, "role": "me", "text": message, "at": at(0)], "bot": bot], write: draft)
    }
}
