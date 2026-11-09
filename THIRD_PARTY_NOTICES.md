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

## About the modified herdr build

agent-steward uses a modified build of [herdr](https://github.com/herdrdev/herdr), which is licensed under the Apache License 2.0. The modified build is published at [hao-github-0216/herdr](https://github.com/hao-github-0216/herdr). It is based on upstream herdr v0.9.5 and adds two commits:

- Tasks, an inspector, file preview, and menu commands that agent-steward uses. These changes cover the shell client, the API and its schema, the CLI, platform helpers, and the integrations, and they come with new tests.
- A release workflow that builds herdr for macOS, Linux, and Windows.

Upstream herdr does not ship a NOTICE file. The full Apache License 2.0 text is in [licenses/herdr-LICENSE.txt](licenses/herdr-LICENSE.txt). For the exact changes, compare `v0.9.5` with `steward-v0.9.5-1` in that repository.

## Data and privacy

agent-steward and its installer do not send usage data or analytics anywhere. During installation, the network is used only to reach GitHub (agent-steward's own releases and the latest-version lookup) and the sources listed above.
