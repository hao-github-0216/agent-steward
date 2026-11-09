# Third-party notices

agent-steward itself is released under the [MIT License](LICENSE). The installer also downloads the components below. Each one keeps its own license. Every download uses a pinned version, and the installer checks it against a pinned SHA-256 before using it. The versions and checksums are listed in [`components.json`](components.json).

中文說明：專案管家本身是 MIT 授權。安裝程式另外會下載下列元件，各自沿用原本的授權；每個下載都固定版本，並在使用前比對 SHA-256。版本與檢查碼記在 `components.json`。

## Components the installer downloads

| Component | Version | License | Downloaded from |
|---|---|---|---|
| [Node.js](https://nodejs.org) | 24.22.2 (only when no Node.js 22.6 or newer is installed) | MIT, plus the licenses of its bundled dependencies ([LICENSE](https://github.com/nodejs/node/blob/v24.22.2/LICENSE)) | nodejs.org |
| [herdr](https://github.com/hao-github-0216/herdr), modified build | steward-v0.9.5-1 | Apache-2.0 ([full text](licenses/herdr-LICENSE.txt)) | github.com/hao-github-0216/herdr releases |
| [ttyd](https://github.com/tsl0922/ttyd) | 1.7.7 (Linux and Windows; macOS uses Homebrew) | MIT ([full text](licenses/ttyd-LICENSE.txt)) | github.com/tsl0922/ttyd releases |
| npm dependencies of agent-steward | as locked in `package-lock.json` | see each package | registry.npmjs.org |

## Components downloaded only when you turn on a plugin

| Component | Version | License | Downloaded from |
|---|---|---|---|
| [uv](https://github.com/astral-sh/uv) (Jupyter notebook plugin) | 0.13.7 | MIT OR Apache-2.0 | github.com/astral-sh/uv releases |
| Python packages: ipykernel, numpy, pandas, matplotlib (Jupyter notebook plugin) | 7.4.0, 2.5.4, 3.1.1, 3.11.2 | BSD-3-Clause (ipykernel, numpy, pandas); Matplotlib License, PSF-based (matplotlib) | pypi.org |
| [TinyTeX](https://github.com/rstudio/tinytex-releases) (LaTeX plugin) | v2026.11 | MIT for TinyTeX itself; each TeX Live package keeps its own license | github.com/rstudio/tinytex-releases |

## Components bundled in the desktop App (macOS and Windows)

The desktop App does not download these components at install time. They ship inside the App, and the build checks each download against the SHA-256 pinned in `components.json` before bundling it.

| Component | Version | License |
|---|---|---|
| Node.js official binary | 24.22.2 | MIT, plus the licenses of its bundled dependencies |
| herdr, modified build | steward-v0.9.5-1 | Apache-2.0 |
| ttyd | 1.7.7 (on macOS, built from source by this project's `build-ttyd-macos` workflow) | MIT |
| Libraries linked into the macOS ttyd: json-c, libuv, mbedtls, libwebsockets | see `licenses/ttyd/LICENSES` in the App | MIT (json-c, libuv, libwebsockets); Apache-2.0 (mbedtls) |
| agent-steward and its npm dependencies | as locked in `package-lock.json` | MIT for agent-steward; see each package |
| Rust crates compiled into the App, including Tauri | as locked in `desktop/src-tauri/Cargo.lock` | listed per crate in `licenses/rust/README.md` in the App |

The full license texts are in the App's `licenses` folder. On macOS it is `Agent Steward.app/Contents/Resources/licenses/`. On Windows it is the `licenses` folder inside the install folder. The App's menu item "About and third-party licenses" opens this file from that folder. The Rust crate list is generated at build time from `cargo metadata`. It copies each crate's own license files. When a crate ships no license file, the list shows the license declared in its metadata.

中文說明：桌面 App 不會在安裝時下載東西，上表的元件直接包在 App 裡；打包時每個下載都比對 `components.json` 裡固定的 SHA-256。各元件的授權全文放在 App 的 `licenses` 資料夾：Mac 在 `Agent Steward.app/Contents/Resources/licenses/`，Windows 在安裝資料夾的 `licenses` 底下，App 選單的「關於與第三方授權」會打開資料夾裡的這份說明。編進 App 的 Rust 套件清單在建置時從 `cargo metadata` 產生，並附上各套件自己的授權檔；套件本身沒附授權檔時，清單會列出它在 metadata 裡標示的授權。

## About the modified herdr build

agent-steward uses a modified build of [herdr](https://github.com/herdrdev/herdr), which is licensed under the Apache License 2.0. The modified build is published at [hao-github-0216/herdr](https://github.com/hao-github-0216/herdr). It is based on upstream herdr v0.9.5 and adds two commits:

- Tasks, an inspector, file preview, and menu commands that agent-steward uses. These changes cover the shell client, the API and its schema, the CLI, platform helpers, and the integrations, and they come with new tests.
- A release workflow that builds herdr for macOS, Linux, and Windows.

Upstream herdr does not ship a NOTICE file. The full Apache License 2.0 text is in [licenses/herdr-LICENSE.txt](licenses/herdr-LICENSE.txt). For the exact changes, compare `v0.9.5` with `steward-v0.9.5-1` in that repository.

## Data and privacy

agent-steward and its installer do not send usage data or analytics anywhere. During installation, the network is used only to reach GitHub (agent-steward's own releases and the latest-version lookup) and the sources listed above.
