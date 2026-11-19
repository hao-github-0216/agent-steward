// Markdown 檔的預覽:跟網頁程式碼頁一樣用 marked(GitHub 格式)+ DOMPurify 排版、同一套樣式,
// 看起來跟網頁一樣(表格、圖片、HTML、清單、核取方塊…);數學式用 KaTeX(網頁的 Notebook 也是用它)。
//   字型跟系統(會跟著「文字大小」設定)、深淺色跟系統;最小只能縮到寬度剛好塞滿
//   專案裡的圖片經 app 讀(用 app 已經登入的連線,不用另外登入)
//   連到專案裡別的檔案就在程式碼頁打開;外面的連結用 Safari;點其他地方切換全螢幕
// 排版程式跟網頁一樣從 cdn.jsdelivr.net 載(載不到就退回原生的簡單預覽)。
import SwiftUI
import WebKit

struct MarkdownWebView: UIViewRepresentable {
    @Environment(AppModel.self) private var model
    let project: String
    /// 這個檔案在專案裡的路徑:相對路徑的圖片、連結從它所在的資料夾算
    let path: String
    let source: String
    var onTap: () -> Void = {}
    /// 排版程式載不到(沒網路):改用原生的預覽
    var onFallback: () -> Void = {}

    static let scheme = "steward-file"

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let c = context.coordinator
        c.files.api = model.api
        c.files.project = project
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(c.files, forURLScheme: Self.scheme)
        config.userContentController.add(WeakMessageHandler(c), name: "md")
        let v = WKWebView(frame: .zero, configuration: config)
        v.isOpaque = false
        v.backgroundColor = .systemBackground
        v.scrollView.backgroundColor = .systemBackground
        v.navigationDelegate = c
        v.isInspectable = true
        v.accessibilityIdentifier = "markdown-view"
        sync(c)
        c.load(v, source: source, path: path)
        return v
    }

    func updateUIView(_ v: WKWebView, context: Context) {
        let c = context.coordinator
        sync(c)
        if c.source != source { c.update(v, source: source) }
    }

    private func sync(_ c: Coordinator) {
        c.onTap = onTap
        c.onFallback = onFallback
        let model = model
        c.openFile = { model.openCode(.file($0)) }
    }

    static func dismantleUIView(_ v: WKWebView, coordinator: Coordinator) {
        v.configuration.userContentController.removeScriptMessageHandler(forName: "md")
        coordinator.timeout?.cancel()
    }

    /// steward-file://p/<專案裡的路徑> → 專案裡的路徑
    static func projectPath(_ url: URL) -> String {
        String(url.path.drop(while: { $0 == "/" }))
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        let files = ProjectFileSchemeHandler()
        var source = ""
        var onTap: () -> Void = {}
        var onFallback: () -> Void = {}
        var openFile: (String) -> Void = { _ in }
        var timeout: Task<Void, Never>?
        private var ready = false

        func load(_ v: WKWebView, source: String, path: String) {
            self.source = source
            let dir = (path as NSString).deletingLastPathComponent
            let enc = dir.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ""
            let base = URL(string: "\(MarkdownWebView.scheme)://p/\(enc.isEmpty ? "" : enc + "/")")
            v.loadHTMLString(MarkdownWebView.page(source), baseURL: base)
            // 排版程式一直沒載好(網路很慢、被擋):改用原生的預覽
            timeout = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(12))
                guard let self, !Task.isCancelled, !self.ready else { return }
                self.onFallback()
            }
        }

        /// 檔案被改了(agent 改檔、重新載入):重新排版,停在原本捲到的地方
        func update(_ v: WKWebView, source: String) {
            self.source = source
            v.evaluateJavaScript("render(\(MarkdownWebView.json(source)), true)")
        }

        func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
            guard let body = m.body as? [String: Any], let type = body["type"] as? String else { return }
            switch type {
            case "ready":
                ready = true
                timeout?.cancel()
            case "tap":
                onTap()
            case "fallback":
                timeout?.cancel()
                onFallback()
            default:
                break
            }
        }

        func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard a.navigationType == .linkActivated, let url = a.request.url else { return decisionHandler(.allow) }
            if url.scheme == MarkdownWebView.scheme {
                // 同一份文件裡的 #錨點:照常捲過去
                var here = URLComponents(url: w.url ?? url, resolvingAgainstBaseURL: false)
                var there = URLComponents(url: url, resolvingAgainstBaseURL: false)
                here?.fragment = nil
                there?.fragment = nil
                if url.fragment != nil, here?.url == there?.url { return decisionHandler(.allow) }
                // 專案裡的別的檔案:在程式碼頁打開
                openFile(MarkdownWebView.projectPath(url))
            } else {
                UIApplication.shared.open(url)
            }
            decisionHandler(.cancel)
        }
    }
}

/// 訊息處理器會被網頁設定一直抓著:用弱參照轉給 Coordinator,關掉預覽時才放得掉
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}

/// steward-file://p/<專案裡的路徑>:預覽裡的圖片經 app 讀(用 app 已經登入的連線)
final class ProjectFileSchemeHandler: NSObject, WKURLSchemeHandler {
    var api: API?
    var project = ""
    var useView = false
    /// 還沒被網頁取消的請求(取消之後再回應會當掉)
    private var live = Set<ObjectIdentifier>()

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        guard let url = task.request.url, let api else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        live.insert(id)
        let path = MarkdownWebView.projectPath(url)
        let project = project
        let useView = useView
        Task { @MainActor in
            do {
                let data: Data
                if useView {
                    data = try await api.viewFile(project: project, path: path)
                } else {
                    data = try await api.rawFile(project: project, path: path)
                }
                guard self.live.remove(id) != nil else { return }
                let mime = Self.mime(path)
                let encoding = ["text/html", "text/css"].contains(mime) ? "utf-8" : nil
                task.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: encoding))
                task.didReceive(data)
                task.didFinish()
            } catch {
                guard self.live.remove(id) != nil else { return }
                task.didFailWithError(error)
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        live.remove(ObjectIdentifier(task))
    }

    static func mime(_ path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "html", "htm": "text/html"
        case "css": "text/css"
        case "woff": "font/woff"
        case "woff2": "font/woff2"
        case "ttf": "font/ttf"
        case "otf": "font/otf"
        case "png": "image/png"
        case "jpg", "jpeg": "image/jpeg"
        case "gif": "image/gif"
        case "webp": "image/webp"
        case "svg": "image/svg+xml"
        case "heic": "image/heic"
        case "bmp": "image/bmp"
        case "ico": "image/x-icon"
        case "pdf": "application/pdf"
        case "mp4", "m4v": "video/mp4"
        case "mov": "video/quicktime"
        default: "application/octet-stream"
        }
    }
}

extension MarkdownWebView {
    /// 放進 <script> 的字串(JSON;把 < 換掉,內容裡的 </script> 才不會把程式提早結束)
    static func json(_ s: String) -> String {
        let d = (try? JSONEncoder().encode(s)) ?? Data("\"\"".utf8)
        return String(decoding: d, as: UTF8.self).replacingOccurrences(of: "<", with: "\\u003c")
    }

    /// 預覽頁:樣式照網頁的 .md-body(字型、顏色換成系統的),排版程式和版本跟網頁一樣
    static func page(_ source: String) -> String {
        """
        <!doctype html>
        <html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=5">
        <style>
        :root { color-scheme: light dark; --ink: #1d1d1f; --muted: #6e6e73; --line: #d2d2d7; --chip: #f2f2f7; --accent: #2f6fdf; --bg: #ffffff; }
        @media (prefers-color-scheme: dark) { :root { --ink: #f5f5f7; --muted: #98989d; --line: #3a3a3c; --chip: #1c1c1e; --accent: #6b9cff; --bg: #000000; } }
        html { -webkit-text-size-adjust: 100%; }
        body { margin: 0; background: var(--bg); color: var(--ink); font: -apple-system-body; }
        .md-body { max-width: 860px; margin: 0 auto; padding: 14px 16px 48px; line-height: 1.6; word-wrap: break-word; }
        .md-body h1, .md-body h2 { border-bottom: 1px solid var(--line); padding-bottom: .3em; }
        .md-body h1 { font-size: 1.8em; } .md-body h2 { font-size: 1.4em; } .md-body h3 { font-size: 1.15em; }
        .md-body img { max-width: 100%; height: auto; }
        .md-body code { font-family: ui-monospace, Menlo, monospace; font-size: .86em; background: var(--chip); padding: 1px 5px; border-radius: 4px; }
        .md-body pre { background: var(--chip); padding: 12px 14px; border-radius: 8px; overflow: auto; }
        .md-body pre code { background: none; padding: 0; }
        .md-body blockquote { margin: 0; padding: 0 14px; border-left: 4px solid var(--line); color: var(--muted); }
        .md-body table { border-collapse: collapse; display: block; overflow: auto; }
        .md-body th, .md-body td { border: 1px solid var(--line); padding: 5px 12px; }
        .md-body a { color: var(--accent); }
        .md-body input[type=checkbox] { margin-right: 6px; }
        .md-body hr { border: 0; border-top: 1px solid var(--line); margin: 1.5em 0; }
        .md-body .math-display { display: block; overflow-x: auto; overflow-y: hidden; text-align: center; margin: .6em 0; }
        .md-body .md-diagram { overflow-x: auto; margin: .6em 0; text-align: center; }
        .md-body .md-diagram svg { max-width: 100%; height: auto; }
        .md-body .md-diagram-error { color: var(--muted); }
        </style>
        <script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js"></script>
        </head><body><article class="md-body" id="md"></article>
        <script>
        const post = (m) => window.webkit && window.webkit.messageHandlers.md.postMessage(m);
        const KATEX = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist";
        let katexLoad = null;
        // 有數學式才載 KaTeX(跟網頁的 Notebook 同一個版本);載不到就顯示原文
        function loadKatex() {
          if (katexLoad) return katexLoad;
          katexLoad = new Promise((ok) => {
            const l = document.createElement("link"); l.rel = "stylesheet"; l.href = KATEX + "/katex.min.css"; document.head.appendChild(l);
            const s = document.createElement("script"); s.src = KATEX + "/katex.min.js";
            s.onload = () => ok(window.katex || null); s.onerror = () => ok(null);
            document.head.appendChild(s);
          });
          return katexLoad;
        }
        const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
        const mathSpan = (tex, display) => `<span class="math${display ? " math-display" : ""}" data-tex="${esc(tex)}" data-display="${display ? 1 : 0}"></span>`;
        // 數學式:獨立一行 $$…$$、\\[…\\];行內 \\(…\\)、$…$($ 後面不是空白、前面不是空白、後面不接數字,才不會把金額當數學式)
        const mathExt = [
          { name: "mathBlock", level: "block",
            start(src) { const i = src.search(/\\$\\$|\\\\\\[/); return i < 0 ? undefined : i; },
            tokenizer(src) {
              const m = /^\\$\\$([\\s\\S]+?)\\$\\$[ \\t]*(?:\\n|$)/.exec(src) || /^\\\\\\[([\\s\\S]+?)\\\\\\][ \\t]*(?:\\n|$)/.exec(src);
              if (m) return { type: "mathBlock", raw: m[0], text: m[1].trim() };
            },
            renderer(t) { return mathSpan(t.text, true); } },
          { name: "mathInline", level: "inline",
            start(src) { const i = src.search(/\\$|\\\\\\(/); return i < 0 ? undefined : i; },
            tokenizer(src) {
              let m = /^\\$\\$([^\\n]+?)\\$\\$/.exec(src);
              if (m) return { type: "mathInline", raw: m[0], text: m[1].trim(), display: true };
              m = /^\\\\\\(([\\s\\S]+?)\\\\\\)/.exec(src);
              if (m) return { type: "mathInline", raw: m[0], text: m[1].trim(), display: false };
              m = /^\\$(?![\\s$])((?:\\\\.|[^\\\\\\n$])+?)\\$(?!\\d)/.exec(src);
              if (m && !/\\s$/.test(m[1])) return { type: "mathInline", raw: m[0], text: m[1], display: false };
            },
            renderer(t) { return mathSpan(t.text, t.display); } },
        ];
        const hasMath = (s) => /\\$|\\\\\\(|\\\\\\[/.test(s);
        const mermaidErrorMessage = \(json(String(localized: "圖表語法有誤:{error}", bundle: AppLanguage.bundle)));
        let mermaidLoad = null, renderVersion = 0;
        function mermaidError(block, error) {
          const message = document.createElement("div");
          message.className = "md-diagram-error";
          message.textContent = mermaidErrorMessage.replace("{error}", () => error.message || String(error));
          block.parentNode.after(message);
        }
        // 只有 Mermaid 程式碼區塊才載入圖表程式;舊的非同步排版不能改動新內容。
        async function renderMermaid(box, version, current) {
          const blocks = [...box.querySelectorAll("pre > code.language-mermaid")];
          if (!blocks.length) return;
          let mermaid;
          try {
            mermaidLoad ||= import("https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs").catch((error) => { mermaidLoad = null; throw error; });
            mermaid = (await mermaidLoad).default;
            if (!current()) return;
            mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default" });
          } catch (error) {
            if (current()) for (const block of blocks) mermaidError(block, error);
            return;
          }
          for (const [index, block] of blocks.entries()) {
            if (!current()) return;
            const id = `md-mermaid-${version}-${index}`;
            try {
              const { svg } = await mermaid.render(id, block.textContent);
              if (!current()) return;
              const diagram = document.createElement("div");
              diagram.className = "md-diagram";
              diagram.innerHTML = DOMPurify.sanitize(svg, { ADD_TAGS: ["foreignObject"] });
              const image = diagram.querySelector("svg");
              if (image) {
                // 將節點文字設為圖表的無障礙標籤,供輔助功能讀取。
                const labels = [...image.querySelectorAll("text, .nodeLabel, .edgeLabel")].map((el) => el.textContent.trim()).filter(Boolean);
                image.setAttribute("role", "img");
                if (labels.length) image.setAttribute("aria-label", [...new Set(labels)].join(" "));
              }
              block.parentNode.replaceWith(diagram);
            } catch (error) {
              document.getElementById(`d${id}`)?.remove();
              if (current()) mermaidError(block, error);
            }
          }
        }
        async function render(src, keepScroll) {
          const version = ++renderVersion;
          const current = () => renderVersion === version;
          if (!window.marked || !window.DOMPurify) { post({ type: "fallback" }); return; }
          try {
            const y = window.scrollY;
            const katex = hasMath(src) ? await loadKatex() : null;
            if (!current()) return;
            const md = new marked.Marked({ gfm: true });
            if (hasMath(src)) md.use({ extensions: mathExt });
            const box = document.getElementById("md");
            box.innerHTML = DOMPurify.sanitize(md.parse(src));
            for (const el of box.querySelectorAll(".math[data-tex]")) {
              const tex = el.dataset.tex, display = el.dataset.display === "1";
              if (katex) katex.render(tex, el, { displayMode: display, throwOnError: false, output: "html" });
              else el.textContent = display ? `$$${tex}$$` : `$${tex}$`;
            }
            renderMermaid(box, version, current);
            // 外面的連結、圖片照常;捲回原本的位置
            if (keepScroll) window.scrollTo(0, y);
            post({ type: "ready" });
          } catch (e) { if (current()) post({ type: "fallback" }); }
        }
        // 點一下(不是點連結、勾選框、也沒有選字):切換全螢幕
        document.addEventListener("click", (e) => {
          if (e.target.closest("a, input, button, summary, label")) return;
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed) return;
          post({ type: "tap" });
        });
        render(\(json(source)), false);
        </script>
        </body></html>
        """ // i18n-ok: 內嵌 JavaScript 中的中文全是程式註解，不是介面文字。
    }
}
