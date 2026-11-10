window.__ModuleLoader__.load({
  id: 'dsh-reakit',
  factory: function (require) {
    var React = require('react')
    var h = React.createElement
    var phases = { idle: '待初始化', preparing: '正在初始化', ready: '已就绪', error: '初始化失败', disabled: '已关闭' }
    var box = { border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2))', borderRadius: '12px', padding: '16px', margin: '12px 0', background: 'var(--dsw-alias-button-floating-fill, transparent)' }
    // Slot content does not inherit the host's settings typography. Scope every
    // reset to this panel; never resize the surrounding app or composer dock.
    var panelCss = '[data-rea-settings] h3{font-size:16px;line-height:24px;font-weight:600;margin:0 0 6px;}' +
      '[data-rea-settings] h4{font-size:13px;line-height:20px;font-weight:600;margin:0 0 6px;}' +
      '[data-rea-settings] p{margin:6px 0;}' +
      '[data-rea-settings] button,[data-rea-settings] input{font:inherit;}' +
      '[data-rea-settings] button{line-height:20px;padding:3px 10px;}' +
      '[data-rea-settings] input[type="checkbox"]{width:14px;height:14px;margin:0;flex-shrink:0;}' +
      '[data-rea-settings] pre{margin:6px 0;line-height:18px;}' +
      '[data-rea-settings] section>:first-child{margin-top:0;}' +
      '[data-rea-settings] section>:last-child{margin-bottom:0;}' +
      '[data-rea-settings] .rea-muted{color:var(--dsw-alias-label-secondary,inherit);font-size:12px;}' +
      '[data-rea-settings] .rea-setting-header{display:flex;align-items:center;justify-content:space-between;gap:12px;}' +
      '[data-rea-settings] .rea-setting-header h4{margin:0;}' +
      '[data-rea-settings] .rea-state{display:inline-flex;align-items:center;gap:6px;font-size:12px;border-radius:999px;padding:3px 9px;background:var(--dsw-alias-button-ghost-active-fill,transparent);}' +
      '[data-rea-settings] .rea-switch{border:0;border-radius:999px;padding:5px 13px;white-space:nowrap;cursor:pointer;box-shadow:inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border,currentColor);background:var(--dsw-alias-button-ghost-active-fill,transparent);color:inherit;}' +
      '[data-rea-settings] .rea-impact-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:14px 0;}' +
      '[data-rea-settings] .rea-impact-cell{padding:12px;border-radius:8px;background:var(--dsw-alias-button-ghost-active-fill,transparent);}' +
      '[data-rea-settings] .rea-impact-cell h4{font-size:12px;margin-bottom:6px;}' +
      '[data-rea-settings] .rea-note{padding:12px;border-inline-start:3px solid var(--dsw-alias-button-ghost-active-border,currentColor);border-radius:4px;}' +
      '[data-rea-settings] .rea-note p:last-child{margin-bottom:0;}' +
      '[data-rea-settings] .rea-optional{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:12px;margin:12px 0;}' +
      '[data-rea-settings] .rea-optional>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;padding:14px 16px;font-weight:600;}' +
      '[data-rea-settings] .rea-optional>summary::-webkit-details-marker{display:none;}' +
      '[data-rea-settings] .rea-optional-body{padding:0 16px 16px;}' +
      // The host lets closed-details children overflow their zero-height box.
      // Explicitly hide both levels so a collapsed entry hides its full prompt.
      '[data-rea-settings] .rea-optional:not([open])>.rea-optional-body{display:none;}' +
      '[data-rea-settings] [data-rea-config-instructions]:not([open])>pre{display:none;}' +
      '[data-rea-settings] .rea-config-button{border:0;border-radius:8px;padding:5px 12px;cursor:pointer;box-shadow:inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border,currentColor);background:var(--dsw-alias-button-ghost-active-fill,transparent);color:inherit;}' +
      '[data-rea-settings] .rea-version-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin:12px 0;}' +
      '[data-rea-settings] .rea-version-card{padding:12px;border-radius:8px;background:var(--dsw-alias-button-ghost-active-fill,transparent);overflow-wrap:anywhere;}' +
      '[data-rea-settings] .rea-version-card h4{margin:0 0 6px;}' +
      '[data-rea-settings] .rea-version-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;}'
    var rowStyle = { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', margin: '8px 0' }
    var textStyle = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '320px', overflow: 'auto', fontSize: '12px' }

    // Messages are keyed by their Chinese source text, so an unregistered or
    // test host still renders the original wording and never an empty string.
    var LOCALE_NS = 'dshReakit', EN = {
      "待初始化": "Idle",
      "正在初始化": "Starting",
      "已就绪": "Ready",
      "初始化失败": "Initialization failed",
      "已关闭": "Off",
      "输入框快捷开关": "Composer switch",
      "在输入框下方显示 REA 快捷开关": "Show the REA switch below the composer",
      "显示设置未保存，请稍后重试。": "The display setting was not saved; try again shortly.",
      "仅改变按钮显示，不启停 REA、不结束分析会话；选择会保存并同步到其他窗口。": "Only the button visibility changes; REA is not started or stopped and analysis sessions are untouched. The choice is saved and synced to other windows.",
      "处理中": "Working",
      "刚刚调用过": "Just used",
      "启动中": "Starting",
      "连接失败": "Connection failed",
      "REA：切换中…": "REA: switching…",
      "REA：状态不可用": "REA: status unavailable",
      "REA：正在处理工具调用": "REA: running a tool call",
      "，完成前无法关闭": " and cannot be closed until it finishes",
      "REA 关": "REA off",
      "REA 用": "REA busy",
      "REA 开": "REA on",
      "REA 快捷开关": "REA quick switch",
      "REA 正在处理工具调用，完成后再关闭": "REA is running a tool call; wait for it to finish before disabling",
      "关闭全局 REA 工具；未保存的临时分析和证据请先导出": "Disable the global REA tools; export unsaved analysis and evidence first",
      "开启全局 REA 工具": "Enable the global REA tools",
      "REA 正在处理工具调用，完成后再关闭；现在关闭会中断正在执行的分析": "REA is running a tool call; wait for it to finish, because disabling now interrupts the running analysis",
      "切换失败：": "Switch failed: ",
      "请在 DeepSeek Harness（DSH）中，为我当前已经安装的 dsh-reakit 插件配置本次所需的可选工具。仅在所用功能确实缺少外部依赖或相应配置时，先只读检查该项，再经我确认按需补齐；不要扫描全部可选组件，也不要一次安装全部组件。基础 Node / REA 已由插件管理，此任务不是依据 REA 原始仓库教程重新安装 REA，也不是重装插件。若本次没有明确的缺失项，先询问需要的分析功能，不默认开始安装。": "Configure the optional tools that this task needs for the dsh-reakit plugin already installed in DeepSeek Harness (DSH). Only when a capability I use is genuinely missing an external dependency or configuration, inspect that item read-only first and fill it in on demand after I confirm; do not scan every optional component and do not install everything at once. The base Node / REA is managed by the plugin, so this is not a reinstall of REA from the upstream repository tutorial and not a plugin reinstall. If nothing is clearly missing, ask what analysis capability I need instead of starting an install.",
      "先做只读检测，定位当前已安装的 dsh-reakit 实例，以该插件自带的 README.md、package.json、lib/config.js、lib/bootstrap.js 和 assets/engine/dependencies.lock.json 为依据，核对插件版本、支持的配置字段、锁定的 Node / REA 版本、REA 总开关和运行状态。不要把原始仓库 main 分支文档或未安装的开发目录当作当前插件的安装依据；无法定位实例或读取这些资料时先说明并询问，不猜测路径和 API。只检查本次需要的非敏感配置，不扫描其他插件或客户端配置。": "Start with read-only detection: locate the installed dsh-reakit instance and use that plugin's own README.md, package.json, lib/config.js, lib/bootstrap.js and assets/engine/dependencies.lock.json to confirm the plugin version, supported configuration fields, locked Node / REA versions, the REA switch and the runtime state. Do not treat the upstream main-branch docs or an uninstalled development directory as the basis for the installed plugin; when the instance cannot be located or those files cannot be read, say so and ask instead of guessing paths or APIs. Check only the non-sensitive configuration this task needs, and do not scan other plugins or client configuration.",
      "基础 Node / REA 由 dsh-reakit 插件管理：自动模式下复用插件已校验的托管运行时和锁定依赖；已有 nodePath / reaEntry 手工模式则保留，不擅自迁移。不要另行克隆 REA 仓库、全局安装 rea-agents、运行 npx rea 或 rea setup；不要新增独立 REA 服务或其他 MCP 客户端注册项，不要改插件锁文件。若基础运行时缺失或异常，先报告，再经我确认按本插件的托管准备/诊断流程处理；使用本插件 doctor / setup 辅助命令前核对其参数并沿用当前实例的 runtimeDir 或手工路径，不另建一套环境。": "The base Node / REA is managed by the dsh-reakit plugin: in automatic mode reuse the plugin's verified managed runtime and locked dependencies, and keep an existing nodePath / reaEntry manual mode without migrating it on your own. Do not clone the REA repository, install rea-agents globally, run npx rea or rea setup, add an independent REA service or another MCP client registration, or edit the plugin lockfile. If the base runtime is missing or broken, report it first and get my confirmation before following this plugin's managed setup/diagnostic flow; before using the plugin's doctor / setup helpers, check their arguments and reuse the current instance's runtimeDir or manual paths instead of building a second environment.",
      "额外组件只为该插件所需能力服务。优先复用已有兼容工具，按已安装插件及其实际锁定的 REA 发布包核对依赖版本、原生绑定和平台限制；上游资料仅辅助核对第三方依赖，不替代本插件的接入流程。内置静态分析不需要额外安装，不把文件存在或包已下载当成功能就绪。": "Extra components serve only the capabilities this plugin needs. Prefer an existing compatible tool, and verify dependency versions, native bindings and platform limits against the installed plugin and the REA release it actually locks; upstream material only helps to cross-check third-party dependencies and never replaces this plugin's integration flow. Built-in static analysis needs no extra install, and neither an existing file nor a downloaded package means a capability is ready.",
      "安装前列出必要组件、官方来源、准确版本、校验方式、安装路径、共享依赖升级与磁盘影响，获得我明确确认后才执行。需要管理员权限、商业许可证或不支持当前平台的情况应说明并停下。不要全局升级软件，不要运行未经审阅的安装脚本，不要启动分析目标、设备、浏览器或代理，不要修改系统/DSH 的 Node、PATH、npmrc 或其他客户端配置。浏览器操作遵守我的既有授权策略。": "Before installing, list the required components, official source, exact version, verification method, install path, shared-dependency upgrades and disk impact, and act only after my explicit confirmation. Explain and stop when administrator rights, a commercial licence or an unsupported platform is involved. Do not upgrade software globally, run unreviewed install scripts, start analysis targets, devices, browsers or proxies, or modify the system or DSH Node, PATH, npmrc or other client configuration. Browser work follows my existing authorisation policy.",
      "配置只作用于当前 dsh-reakit 实例：经授权后通过 DSH 官方 ConfigEditor 局部合并该条目的必要 env 键，保留其他全部配置。不要覆盖整个配置文件，不要用 volatile settings 写普通运行字段。保持现有 enabled、autoSetup、nodePath、reaEntry、runtimeDir、serverName 及快捷按钮显示偏好不变；如确需变更，逐项说明原因并另行取得确认。不要读取、输出或复制凭据。": "Configuration applies only to the current dsh-reakit instance: once authorised, merge just the required env keys into that entry through the official DSH ConfigEditor and keep every other setting. Do not overwrite the whole configuration file and do not write ordinary runtime fields through volatile settings. Keep the existing enabled, autoSetup, nodePath, reaEntry, runtimeDir, serverName and composer visibility preference unchanged; when a change is really needed, justify it item by item and confirm separately. Do not read, print or copy credentials.",
      "保持用户当前的 REA 开关状态；处于关闭状态时不得为了安装或验证擅自开启。需要启用或重启时，先说明影响，检查可访问的活动分析会话，提示导出未保存证据并取得确认；状态无法确认时先停下，不以重启代替诊断。": "Keep the user's current REA switch state; never enable REA while it is off just to install or verify something. When enabling or restarting is required, explain the impact first, inspect any reachable active analysis session, prompt to export unsaved evidence and get confirmation; stop when the state cannot be confirmed and never substitute a restart for diagnosis.",
      "完成后通过 DSH 中该 dsh-reakit 实例实际注册的 MCP 工具，对所需功能做最小验证；不要以独立 REA CLI 成功代替插件连接与能力验证。doctor 仅检查安装，不等于 MCP 或组件就绪；REA 关闭或缺少操作授权时明确标为待验证，不为验证改变开关。说明已完成、待配置、待验证和失败原因，不要伪称全部就绪。": "When done, verify the needed capability minimally through the MCP tools that this dsh-reakit instance actually registered in DSH; a standalone REA CLI success never replaces plugin connectivity and capability verification. doctor only checks the installation and does not mean the MCP or a component is ready; when REA is off or authorisation is missing, mark the result unverified rather than changing the switch. State what was done, what still needs configuring, what remains unverified and why anything failed, and never claim everything is ready.",
      "运行时版本": "Runtime version",
      "不自动升级": "no auto-upgrade",
      "当前 REA ": "Current REA ",
      "未知": "unknown",
      "。查看状态不联网，点击检查后才会读取官方发布元数据。": ". Reading status stays offline; only clicking check reads the official release metadata.",
      "正在检查…": "Checking…",
      "检查更新": "Check for updates",
      "Node 要求：": "Node requirement: ",
      "npm 官方发布": "official npm release",
      "平台：": "Platform: ",
      "Node.js 官方发布": "official Node.js release",
      "该 REA 版本已被标记为弃用，只展示信息，不提供准备或切换。": "This REA release is marked deprecated; it is shown for information only and cannot be prepared or switched to.",
      "当前 REA 不支持候选 Node；需要先升级 REA，不会单独替换 Node。": "The current REA does not support the candidate Node; upgrade REA first, because Node is never replaced on its own.",
      "上次版本切换已完成": "The last version switch completed",
      "正在回退到旧版本": "Rolling back to the previous version",
      "版本切换尚未完成": "The version switch has not completed",
      "从 REA ": "From REA ",
      " 到 REA ": " to REA ",
      "。旧运行时文件保留。": ". The previous runtime files are kept.",
      "我已导出活动分析会话，或确认没有需要保留的会话": "I exported the active analysis session, or there is nothing to keep",
      "我确认版本切换或回退会重启 REA": "I understand that switching or rolling back restarts REA",
      "准备并切换到此版本": "Prepare and switch to this version",
      "回退到之前的版本": "Roll back to the previous version",
      "当前版本已与官方候选一致，无需切换。": "The current version already matches the official candidate; nothing to switch.",
      "REA 状态暂不可用：": "REA status is temporarily unavailable: ",
      "无法访问剪贴板，请在下方展开的指令中手动复制。": "The clipboard is unavailable; expand the instructions below and copy them manually.",
      "已复制可选工具配置指令；仅针对本次缺失项检查，确认后再补齐依赖。": "Setup instructions copied; they cover only the currently missing items, and dependencies are installed after your confirmation.",
      "复制失败，请在下方展开的指令中手动复制。": "Copy failed; expand the instructions below and copy them manually.",
      "REA 设置": "REA settings",
      "工具接入、模型调用与按需配置": "Tool wiring, model calls and on-demand setup",
      "读取中": "Reading",
      "状态暂不可用": "Status unavailable",
      "正在读取 REA 状态…": "Reading REA status…",
      "REA 工具总开关": "REA tool switch",
      "关闭全局 REA 工具": "Disable the global REA tools",
      "切换中…": "Switching…",
      "已开启": "On",
      "与输入框中的 REA 按钮共用同一全局开关，状态保持同步。": "Shares one global switch with the REA button in the composer, and the state stays in sync.",
      "REA 正在处理 ": "REA is running ",
      " 个工具调用，完成前无法关闭；关闭会中断正在执行的分析。": " tool call(s) and cannot be disabled until they finish; disabling would interrupt the running analysis.",
      "开启时": "When on",
      "向模型提供完整 REA 工具定义，允许调用逆向分析能力。": "Exposes the full REA tool definitions to the model so it can call reverse-engineering capabilities.",
      "工具数量、参数 Schema 体积和工具上下文占用会增加。": "Tool count, parameter-schema size and tool context usage all grow.",
      "关闭时": "When off",
      "从后续模型请求中移除 REA 工具定义，模型不能再直接调用 REA。": "Removes the REA tool definitions from later model requests, so the model can no longer call REA directly.",
      "已安装环境保留，再次开启可以复用，不会卸载软件。": "The installed environment is kept and reused when you turn REA back on; nothing is uninstalled.",
      "关闭会结束临时分析会话，请先导出未保存证据。工具定义变化仅作用于后续请求，不会回溯删除既有对话。": "Disabling ends temporary analysis sessions, so export unsaved evidence first. Tool-definition changes affect later requests only and never rewrite existing conversations.",
      "模型调用提示": "Model call guidance",
      "当模型因工具参数 Schema 超过允许大小而调用失败时，可考虑临时关闭 REA 后重试；需要使用 REA 时再开启。": "If a model call fails because the tool parameter schema exceeds the allowed size, consider temporarily disabling REA and retrying; turn it back on when you need REA.",
      "以下为常见接口/模式示例，不表示这些模型一定失败；具体限制以所选提供方、接口版本和错误消息为准。": "The entries below are common interface/mode examples and do not mean these models always fail; the provider, API version and error message define the actual limit.",
      "Kimi / Moonshot：留意完整工具集合过大触发的 Schema 尺寸限制。": "Kimi / Moonshot: watch for schema-size limits triggered by a very large tool set.",
      "DeepSeek（strict 模式）：服务端会严格校验指定的 JSON Schema 子集。 ": "DeepSeek (strict mode): the server strictly validates the supported JSON Schema subset. ",
      "官方说明": "official docs",
      "GPT 系列（OpenAI strict 工具模式）：仅支持 JSON Schema 子集，其他接口模式的规则可能不同。 ": "GPT models (OpenAI strict tool mode): only a JSON Schema subset is supported, and other API modes may differ. ",
      "这类模型接口错误不是缺少分析器依赖；不会自动关闭 REA，也不会自动裁剪工具。": "Such model API errors are not missing-analyzer dependencies; REA is never disabled automatically and tools are never trimmed.",
      "本次使用的功能缺少已配置的可选工具依赖，可展开下方“可选工具配置”按需处理。": "A capability used in this session is missing a configured optional tool dependency; expand “Optional tool setup” below to handle it on demand.",
      "可选工具配置": "Optional tool setup",
      "非必需": "optional",
      "基础 Node / REA 由插件管理，通常无需额外安装。仅在所用功能确实缺少外部依赖时配置，不扫描全部可选组件。": "The base Node / REA is managed by the plugin and usually needs no extra install. Configure something only when a capability genuinely lacks an external dependency; nothing is scanned wholesale.",
      "复制配置指令": "Copy setup instructions",
      "查看或手动复制指令": "View or copy the instructions manually",
      "REA 组件请求失败": "REA component request failed",
      "已有 REA 安装": "Existing REA installation",
      "如果本机已经装过 REA，可以让插件直接使用它，而不是再准备一份托管运行时。": "If REA is already installed on this machine, let the plugin use that copy instead of preparing a managed runtime.",
      "正在使用已有安装：": "Using an existing installation: ",
      "当前使用插件托管的运行时": "Using the plugin-managed runtime",
      "检测已安装的 REA": "Detect an installed REA",
      "检测中…": "Detecting…",
      "切回托管运行时": "Switch back to the managed runtime",
      "使用此安装": "Use this installation",
      "可用于当前 Node": "compatible with the current Node",
      "不可用：": "unavailable: ",
      "未找到可用的全局 REA 安装（已扫描 {n} 个位置）。": "No usable global REA installation found (scanned {n} locations).",
      "操作失败：": "Operation failed: ",
      "将使用 Node：": "Runs under Node ",
      "插件托管 Node": "Plugin-managed Node",
      "自有 Node": "Own Node",
      "选择运行这个 REA 的 Node：": "Choose the Node that runs this REA: ",
      "不满足要求": "does not meet the requirement",
      "需要 Node {range}，当前 {version}。": "Requires Node {range}, but this one is {version}.",
      "一键升级到插件托管 Node（{version}）": "Upgrade to the plugin-managed Node ({version})",
      "插件托管 Node 也不满足该 REA 的要求，请先在“运行时版本”里检查更新。": "The plugin-managed Node does not satisfy this REA either; check for updates under \"Runtime version\" first.",
      "用这个 Node 接入": "Use this Node",
      "取消": "Cancel",
      "选择 Node 并接入": "Choose a Node",
      "可与兼容 Node 配合使用": "usable with a compatible Node",
      "检测到本机已有可用的 REA，可直接使用，无需下载插件运行时。": "A usable REA installation was found on this machine; use it and skip the download.",
      "使用本机已有的 REA": "Use the installed REA",
      "改用插件托管环境": "Use the plugin-managed runtime",
      "插件下载的运行时仍占用 {size}；删除后切回需重新下载。": "The downloaded runtime still occupies {size}; deleting it means downloading it again to switch back.",
      "删除插件运行时": "Delete the plugin runtime",
      "插件下载的运行时仍占用 {size}；删除后切回需重新下载，也可以保留。": "The downloaded runtime still occupies {size}; deleting it means downloading it again to switch back, or keep it.",
      "删除并释放空间": "Delete and free space",
      "保留": "Keep",
      "其他 profile 仍在使用共享运行时，暂不能删除：": "Other profiles still use the shared runtime, so it cannot be deleted yet: ",
      "本机没有可用的 Node 与 REA，请选择安装位置：": "No usable Node or REA found on this machine; choose where to install them:",
      "安装到插件环境（不碰系统 Node）": "Install into the plugin environment (leaves the system Node alone)",
      "或安装到本机，然后回来重新检测：": "Or install on this machine, then come back and detect again:",
      "复制命令": "Copy command",
      "我已安装，重新检测": "I installed it, detect again",
      "已复制": "Copied",
      "无法访问剪贴板，请手动复制。": "The clipboard is unavailable; copy it manually.",
      "插件下载的 Node 仍占用 {size}；已安装的 REA 会保留，切回只需重新下载 Node，也可以保留。": "The downloaded Node still occupies {size}; the installed REA is kept, so switching back only re-downloads Node — or keep it.",
      "删除 Node 并释放空间": "Delete Node and free space",
      "。旧版本已删除，切回时需重新下载。": " The previous version was deleted; switching back downloads it again."
    }

    var ZH = {}
    Object.keys(EN).forEach(function (key) { ZH[key] = key })
    function makeT(hostT) {
      return function (text, vars) {
        var out = text
        if (typeof hostT === 'function') { try { out = hostT(text, vars) || text } catch (_) { out = text } }
        if (!vars) return out
        return String(out).replace(/\{(\w+)\}/g, function (_, name) { return vars[name] == null ? '' : String(vars[name]) })
      }
    }

    var CONFIG_CHANGED = 'dsh-reakit:configuration-changed'

    // Cross-window messages contain no state or credentials: every surface reads
    // the accepted host snapshot again. No optimistic per-window enable flag.
    function notifyConfigurationChanged() {
      window.dispatchEvent(new Event(CONFIG_CHANGED))
      var channel
      try {
        if (typeof window.BroadcastChannel === 'function') {
          channel = new window.BroadcastChannel(CONFIG_CHANGED)
          channel.postMessage('refresh')
        }
      } catch (_) { /* Focus and bounded polling remain the fallback. */ }
      finally { if (channel) channel.close() }
    }

    // One global stylesheet for the composer indicator. Keyframes cannot live in
    // the dock subtree, and the panel's own <style> stays panel-scoped.
    function ensureIndicatorStyles() {
      if (typeof document === 'undefined' || !document.head) return
      if (document.getElementById('dsh-reakit-indicator-styles')) return
      var style = document.createElement('style')
      style.id = 'dsh-reakit-indicator-styles'
      // Explicit status colours read the same on light and dark themes; the
      // neutral states keep the inherited foreground colour.
      style.textContent = '[data-rea-quick-toggle] [data-rea-dot]{width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:currentColor;opacity:.3;}' +
        '[data-rea-quick-toggle] [data-rea-dot="ready"]{background:#22a06b;opacity:1;}' +
        '[data-rea-quick-toggle] [data-rea-dot="recent"]{background:#22a06b;opacity:1;box-shadow:0 0 0 1.5px #22a06b;animation:dsh-reakit-flash .55s ease-out 2;}' +
        '[data-rea-quick-toggle] [data-rea-dot="active"]{background:#22a06b;opacity:1;animation:dsh-reakit-pulse 1.1s ease-out infinite;}' +
        '[data-rea-quick-toggle] [data-rea-dot="pending"]{background:#e5a50a;opacity:1;}' +
        '[data-rea-quick-toggle] [data-rea-dot="error"]{background:#e5484d;opacity:1;}' +
        '@keyframes dsh-reakit-pulse{0%{box-shadow:0 0 0 0 rgba(34,160,107,.85)}70%{box-shadow:0 0 0 4px rgba(34,160,107,0)}100%{box-shadow:0 0 0 0 rgba(34,160,107,0)}}' +
        // One-shot ripple so a call that started and finished between two reads
        // still produces visible feedback; it is not a "running" claim.
        '@keyframes dsh-reakit-flash{0%{box-shadow:0 0 0 1.5px rgba(34,160,107,.95)}100%{box-shadow:0 0 0 5px rgba(34,160,107,0)}}' +
        '@media (prefers-reduced-motion:reduce){' +
        '[data-rea-quick-toggle] [data-rea-dot="active"]{animation:none;box-shadow:0 0 0 2px rgba(34,160,107,.55);}' +
        '[data-rea-quick-toggle] [data-rea-dot="recent"]{animation:none;}}'
      document.head.appendChild(style)
    }

    // Lightweight polling owns no component version probes. Keep one request
    // in flight and one timer per mounted surface; focus/events coalesce.
    function createStatusSync(read, update, options) {
      options = options || {}
      var target = options.target || window
      var schedule = options.schedule || setTimeout
      var cancel = options.cancel || clearTimeout
      var timer = null, pending = null, queued = false, stopped = false
      var phase = 'preparing', inflight = 0, lastCompletedAt = 0, channel = null
      try {
        if (typeof target.BroadcastChannel === 'function') {
          channel = new target.BroadcastChannel(CONFIG_CHANGED)
          channel.addEventListener('message', refresh)
        }
      } catch (_) { channel = null }
      function refresh() {
        if (stopped) return Promise.resolve()
        if (pending) { queued = true; return pending }
        if (timer !== null) { cancel(timer); timer = null }
        pending = Promise.resolve().then(read).then(function (snapshot) {
          if (stopped) return
          phase = snapshot.runtime.phase
          inflight = Number(snapshot.activity && snapshot.activity.inflight) || 0
          lastCompletedAt = Number(snapshot.activity && snapshot.activity.lastCompletedAt) || 0
          update(snapshot)
        }).catch(function () {
          // A temporary HMR gap is not a component installation failure.
          phase = 'preparing'
        }).finally(function () {
          pending = null
          if (stopped) return
          // The Host exposes no push channel to page plugins (`$on` keys are a
          // host-owned allowlist and `rpc.open` needs a transport stream), so the
          // indicator stays polled. Cadence is visibility-aware: fast enough to
          // catch short calls while the tab is watched, nearly idle when hidden.
          // A desktop window that is merely behind another app usually stays
          // `visible`, so focus is part of the signal: hidden (minimised or
          // occluded) throttles hardest, unfocused throttles gently, and a
          // watched window keeps the fast cadence.
          var hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
          var unfocused = typeof document !== 'undefined' && typeof document.hasFocus === 'function' && !document.hasFocus()
          var recent = Number(lastCompletedAt) > 0 && Date.now() - Number(lastCompletedAt) < 15_000
          var delay = queued ? 0
            : hidden ? (phase === 'disabled' ? 20_000 : 6000)
              : inflight > 0 ? 300
                : phase === 'disabled' ? 8000
                  : phase === 'error' ? 3000
                    : unfocused ? 2000
                      : recent ? 400
                        : 500
          queued = false
          timer = schedule(function () { timer = null; refresh() }, delay)
        })
        return pending
      }
      function dispose() {
        stopped = true
        if (timer !== null) cancel(timer)
        target.removeEventListener(CONFIG_CHANGED, refresh)
        target.removeEventListener('focus', refresh)
        if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('visibilitychange', onVisibility)
        if (channel) { channel.removeEventListener('message', refresh); channel.close() }
      }
      function onVisibility() {
        // A background tab resumes exactly where the indicator matters most.
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') refresh()
      }
      target.addEventListener(CONFIG_CHANGED, refresh)
      // The window regaining focus is the desktop equivalent of a tab coming
      // back: refresh at once instead of waiting out the slow cadence.
      target.addEventListener('focus', refresh)
      if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', onVisibility)
      refresh()
      return { refresh: refresh, dispose: dispose }
    }

    function useForm(form) {
      var source = React.useMemo(function () {
        return { subscribe: function (listener) { return form.subscribe(listener) }, getSnapshot: function () { return form.getSnapshot() } }
      }, [form])
      return React.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
    }

    function ComposerPreference(props) {
      var t = makeT(props.t)
      var snapshot = useForm(props.form)
      var busyState = React.useState(false), busy = busyState[0], setBusy = busyState[1]
      var errorState = React.useState(''), error = errorState[0], setError = errorState[1]
      var noticeState = React.useState(''), notice = noticeState[0], setNotice = noticeState[1]
      var pending = React.useRef(false), alive = React.useRef(true)
      React.useEffect(function () { alive.current = true; return function () { alive.current = false } }, [])
      return h('section', { style: box, 'data-rea-composer-preference': true },
        h('h4', null, t('输入框快捷开关')),
        h('label', { style: rowStyle }, h('input', {
          type: 'checkbox', 'aria-label': t('在输入框下方显示 REA 快捷开关'),
          checked: snapshot.status === 'ready' && snapshot.value.showComposerToggle === true,
          disabled: busy || snapshot.status !== 'ready' || !snapshot.writable,
          onChange: function (event) {
            if (pending.current || snapshot.status !== 'ready' || !snapshot.writable) return
            var visible = event.target.checked
            pending.current = true; setBusy(true); setError('')
            Promise.resolve().then(function () { return props.form.set('showComposerToggle', visible) }).then(function (accepted) {
              if (!accepted) throw new Error(t('显示设置未保存，请稍后重试。'))
            }).catch(function (failure) {
              if (alive.current) setError(String(failure.message || failure))
            }).finally(function () { pending.current = false; if (alive.current) setBusy(false) })
          }
        }), t('在输入框下方显示 REA 快捷开关')),
        h('p', null, t('仅改变按钮显示，不启停 REA、不结束分析会话；选择会保存并同步到其他窗口。')),
        error ? h('p', { role: 'alert' }, error) : null
      )
    }

    function QuickToggleView(props) {
      var t = makeT(props.t)
      var preference = useForm(props.form)
      var busyState = React.useState(false), busy = busyState[0], setBusy = busyState[1]
      var errorState = React.useState(''), error = errorState[0], setError = errorState[1]
      var pending = React.useRef(false), alive = React.useRef(true)
      React.useEffect(function () { alive.current = true; return function () { alive.current = false } }, [])
      if (preference.status !== 'ready' || preference.value.showComposerToggle !== true) return null
      var view = props.view
      var disabled = busy || !view.available || !view.configurationWritable
      var inflight = Number(view.activity && view.activity.inflight) || 0
      // Keep the control focusable while a call runs, but block disabling and
      // explain why instead of silently swallowing the click.
      var blocked = view.enabled && inflight > 0
      var running = view.available && view.enabled && view.runtime.phase === 'ready'
      // Call activity is reported only while the runtime is actually serving.
      var active = running && inflight > 0 && !busy
      // A call can finish between two polls; acknowledge it briefly so short
      // tool calls are visible instead of silently disappearing.
      var finishedAt = Number(view.activity && view.activity.lastCompletedAt) || 0
      var recent = running && !active && finishedAt > 0 && Date.now() - finishedAt < 8000
      var dot = busy || view.runtime.phase === 'preparing' ? 'pending' : !view.enabled ? 'off' : !view.available ? 'unknown' : view.runtime.phase === 'error' ? 'error' : active ? 'active' : recent ? 'recent' : 'ready'
      var runningText = active ? t('处理中') : recent ? t('刚刚调用过') : view.runtime.phase === 'preparing' ? t('启动中') : view.runtime.phase === 'error' ? t('连接失败') : !view.enabled ? t('已关闭') : t('已就绪')
      // "mcp__<server>__<tool>" -> "<tool>" for a readable hover label.
      var toolLabels = active ? view.activity.tools.map(function (name) { return name.split('__').slice(2).join('__') || name }) : []
      var fullText = busy ? t('REA：切换中…') : !view.available ? t('REA：状态不可用') : active ? t('REA：正在处理工具调用') + (toolLabels.length ? '（' + toolLabels.join('、') + '）' : '') + t('，完成前无法关闭') : 'REA：' + runningText
      var text = busy ? 'REA…' : !view.available ? 'REA ?' : !view.enabled ? t('REA 关') : view.runtime.phase === 'preparing' ? 'REA…' : view.runtime.phase === 'error' ? 'REA !' : active ? t('REA 用') : t('REA 开')
      return h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' }, 'data-rea-quick-toggle': true },
        h('button', {
          type: 'button', role: 'switch', 'aria-label': t('REA 快捷开关'), 'aria-description': fullText, 'aria-checked': view.enabled, 'aria-busy': active ? true : undefined, 'aria-disabled': blocked ? true : undefined, disabled: disabled,
          title: blocked ? t('REA 正在处理工具调用，完成后再关闭') : fullText + '；' + (view.enabled ? t('关闭全局 REA 工具；未保存的临时分析和证据请先导出') : t('开启全局 REA 工具')),
          style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '5px', boxSizing: 'border-box', flexShrink: 0, font: 'inherit', fontSize: '12px', lineHeight: '16px', height: '28px', minHeight: '28px', minWidth: '56px', padding: '0 8px', border: 'none', borderRadius: '14px', background: 'var(--dsw-alias-button-ghost-active-fill, transparent)', color: 'var(--dsw-alias-label-primary, inherit)', boxShadow: 'inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border, currentColor)', whiteSpace: 'nowrap', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1 },
          onClick: function () {
            if (pending.current || disabled) return
            if (blocked) { setError(t('REA 正在处理工具调用，完成后再关闭；现在关闭会中断正在执行的分析')); return }
            pending.current = true; setBusy(true); setError('')
            Promise.resolve().then(function () { return props.rpc('setEnabled', { enabled: !view.enabled }) }).catch(function (failure) {
              if (alive.current) setError(t('切换失败：') + String(failure.message || failure))
            }).finally(function () {
              notifyConfigurationChanged()
              pending.current = false
              if (alive.current) setBusy(false)
            })
          }
        }, h('span', { 'data-rea-dot': dot, 'aria-hidden': true }), text),
        error ? h('span', { role: 'alert', style: { fontSize: '12px' } }, error) : null
      )
    }

    function QuickToggle(props) {
      var state = React.useState(null), view = state[0], setView = state[1]
      React.useEffect(function () {
        var controller = new AbortController()
        var sync = createStatusSync(function () {
          return props.rpc('status', {}, controller.signal).then(function (snapshot) {
            return Object.assign({}, snapshot, { available: true })
          }).catch(function (failure) {
            if (!controller.signal.aborted) setView(function (current) { return current ? Object.assign({}, current, { available: false }) : current })
            throw failure
          })
        }, function (snapshot) { setView(snapshot) })
        return function () { sync.dispose(); controller.abort() }
      }, [props.rpc])
      if (!view || !view.settingsEntryId) return null
      return h(QuickToggleView, { rpc: props.rpc, view: view, t: props.t, form: props.configForms.get(view.settingsEntryId) })
    }

    function optionalToolsPrompt(t) { return [
      t('请在 DeepSeek Harness（DSH）中，为我当前已经安装的 dsh-reakit 插件配置本次所需的可选工具。仅在所用功能确实缺少外部依赖或相应配置时，先只读检查该项，再经我确认按需补齐；不要扫描全部可选组件，也不要一次安装全部组件。基础 Node / REA 已由插件管理，此任务不是依据 REA 原始仓库教程重新安装 REA，也不是重装插件。若本次没有明确的缺失项，先询问需要的分析功能，不默认开始安装。'),
      t('先做只读检测，定位当前已安装的 dsh-reakit 实例，以该插件自带的 README.md、package.json、lib/config.js、lib/bootstrap.js 和 assets/engine/dependencies.lock.json 为依据，核对插件版本、支持的配置字段、锁定的 Node / REA 版本、REA 总开关和运行状态。不要把原始仓库 main 分支文档或未安装的开发目录当作当前插件的安装依据；无法定位实例或读取这些资料时先说明并询问，不猜测路径和 API。只检查本次需要的非敏感配置，不扫描其他插件或客户端配置。'),
      t('基础 Node / REA 由 dsh-reakit 插件管理：自动模式下复用插件已校验的托管运行时和锁定依赖；已有 nodePath / reaEntry 手工模式则保留，不擅自迁移。不要另行克隆 REA 仓库、全局安装 rea-agents、运行 npx rea 或 rea setup；不要新增独立 REA 服务或其他 MCP 客户端注册项，不要改插件锁文件。若基础运行时缺失或异常，先报告，再经我确认按本插件的托管准备/诊断流程处理；使用本插件 doctor / setup 辅助命令前核对其参数并沿用当前实例的 runtimeDir 或手工路径，不另建一套环境。'),
      t('额外组件只为该插件所需能力服务。优先复用已有兼容工具，按已安装插件及其实际锁定的 REA 发布包核对依赖版本、原生绑定和平台限制；上游资料仅辅助核对第三方依赖，不替代本插件的接入流程。内置静态分析不需要额外安装，不把文件存在或包已下载当成功能就绪。'),
      t('安装前列出必要组件、官方来源、准确版本、校验方式、安装路径、共享依赖升级与磁盘影响，获得我明确确认后才执行。需要管理员权限、商业许可证或不支持当前平台的情况应说明并停下。不要全局升级软件，不要运行未经审阅的安装脚本，不要启动分析目标、设备、浏览器或代理，不要修改系统/DSH 的 Node、PATH、npmrc 或其他客户端配置。浏览器操作遵守我的既有授权策略。'),
      t('配置只作用于当前 dsh-reakit 实例：经授权后通过 DSH 官方 ConfigEditor 局部合并该条目的必要 env 键，保留其他全部配置。不要覆盖整个配置文件，不要用 volatile settings 写普通运行字段。保持现有 enabled、autoSetup、nodePath、reaEntry、runtimeDir、serverName 及快捷按钮显示偏好不变；如确需变更，逐项说明原因并另行取得确认。不要读取、输出或复制凭据。'),
      t('保持用户当前的 REA 开关状态；处于关闭状态时不得为了安装或验证擅自开启。需要启用或重启时，先说明影响，检查可访问的活动分析会话，提示导出未保存证据并取得确认；状态无法确认时先停下，不以重启代替诊断。'),
      t('完成后通过 DSH 中该 dsh-reakit 实例实际注册的 MCP 工具，对所需功能做最小验证；不要以独立 REA CLI 成功代替插件连接与能力验证。doctor 仅检查安装，不等于 MCP 或组件就绪；REA 关闭或缺少操作授权时明确标为待验证，不为验证改变开关。说明已完成、待配置、待验证和失败原因，不要伪称全部就绪。')
    ].join('\n\n') }

    function RuntimeVersions(props) {
      var t = makeT(props.t)
      var openState = React.useState(false), open = openState[0], setOpen = openState[1]
      var confirmedState = React.useState(false), confirmed = confirmedState[0], setConfirmed = confirmedState[1]
      var exportedState = React.useState(false), exported = exportedState[0], setExported = exportedState[1]
      var versions = props.versions || { phase: 'idle', candidate: null, transition: null }
      var candidate = versions.candidate, transition = versions.transition
      var canPrepare = !!(candidate && versions.updateAvailable && !candidate.rea.deprecated)
      var needsConfirmation = canPrepare || !!(transition && transition.rollbackAvailable)
      function run(method, args) {
        props.action(function () { return props.rpc(method, args).finally(notifyConfigurationChanged) })
      }
      function check() {
        setConfirmed(false); setExported(false)
        run('checkRuntimeUpdates', {})
      }
      var confirmation = { confirmed: confirmed, exported: exported }
      return h('details', { className: 'rea-optional', 'data-rea-runtime-versions': true, open: open, onToggle: function (event) { setOpen(event.currentTarget.open) } },
        h('summary', null, h('span', { 'aria-hidden': true }, open ? '▾' : '▸'), h('span', null, t('运行时版本')), h('span', { className: 'rea-muted', style: { marginLeft: 'auto', fontWeight: 400 } }, t('不自动升级'))),
        h('div', { className: 'rea-optional-body' },
          h('p', { className: 'rea-muted' }, t('当前 REA ') + (props.runtime.reaVersion || t('未知')) + ' · Node ' + (props.runtime.nodeVersion || t('未知')) + t('。查看状态不联网，点击检查后才会读取官方发布元数据。')),
          h('div', { className: 'rea-version-actions' }, h('button', { type: 'button', className: 'rea-config-button', disabled: props.busy || !props.configurationWritable, onClick: check }, versions.busy && versions.phase === 'checking' ? t('正在检查…') : t('检查更新'))),
          versions.message ? h('p', { className: 'rea-muted', role: versions.phase === 'error' ? 'alert' : 'status' }, versions.message) : null,
          candidate ? h('div', { className: 'rea-version-grid', 'data-rea-version-candidate': true },
            h('div', { className: 'rea-version-card' },
              h('h4', null, 'REA ' + candidate.rea.version),
              h('p', null, t('Node 要求：') + candidate.rea.nodeRange),
              h('p', { className: 'rea-muted', title: candidate.rea.integrity }, 'npm SRI：' + candidate.rea.integrity.slice(0, 24) + '…'),
              h('a', { href: candidate.rea.source, target: '_blank', rel: 'noopener noreferrer' }, t('npm 官方发布'))
            ),
            h('div', { className: 'rea-version-card' },
              h('h4', null, 'Node ' + candidate.node.version + (candidate.node.lts ? ' LTS' : '')),
              h('p', null, t('平台：') + candidate.platform + ' / ' + candidate.arch),
              h('p', { className: 'rea-muted' }, 'SHA-256：' + candidate.node.archive.sha256),
              h('a', { href: candidate.node.source, target: '_blank', rel: 'noopener noreferrer' }, t('Node.js 官方发布'))
            )
          ) : null,
          candidate && candidate.rea.deprecated ? h('p', { role: 'alert' }, t('该 REA 版本已被标记为弃用，只展示信息，不提供准备或切换。')) : null,
          candidate && versions.newerNodeRequiresReaUpgrade ? h('p', { className: 'rea-muted' }, t('当前 REA 不支持候选 Node；需要先升级 REA，不会单独替换 Node。')) : null,
          transition ? h('div', { className: 'rea-note', 'data-rea-runtime-transition': true },
            h('p', null, transition.state === 'ready' ? t('上次版本切换已完成') : transition.state === 'rolling-back' ? t('正在回退到旧版本') : t('版本切换尚未完成')),
            h('p', { className: 'rea-muted' }, t('从 REA ') + transition.from.reaVersion + ' / Node ' + transition.from.nodeVersion + t(' 到 REA ') + transition.to.reaVersion + ' / Node ' + transition.to.nodeVersion + t('。旧版本已删除，切回时需重新下载。'))
          ) : null,
          needsConfirmation ? h('div', { 'data-rea-version-confirmation': true },
            h('label', { style: rowStyle }, h('input', { type: 'checkbox', checked: exported, disabled: props.busy, onChange: function (event) { setExported(event.target.checked) } }), t('我已导出活动分析会话，或确认没有需要保留的会话')),
            h('label', { style: rowStyle }, h('input', { type: 'checkbox', checked: confirmed, disabled: props.busy, onChange: function (event) { setConfirmed(event.target.checked) } }), t('我确认版本切换或回退会重启 REA')),
            h('div', { className: 'rea-version-actions' },
              canPrepare ? h('button', { type: 'button', className: 'rea-config-button', disabled: props.busy || !props.configurationWritable || !confirmed || !exported, onClick: function () { run('prepareRuntimeSwitch', { token: versions.token, confirmation: confirmation }) } }, t('准备并切换到此版本')) : null,
              transition && transition.rollbackAvailable ? h('button', { type: 'button', className: 'rea-config-button', disabled: props.busy || !props.configurationWritable || !confirmed || !exported, onClick: function () { run('rollbackRuntime', { confirmation: confirmation }) } }, t('回退到之前的版本')) : null
            )
          ) : null,
          candidate && !versions.updateAvailable ? h('p', { className: 'rea-muted' }, t('当前版本已与官方候选一致，无需切换。')) : null
        )
      )
    }

    // A render failure must never leave an empty settings pane.
    function Boundary(props) {
      var state = React.useState(null), failure = state[0], setFailure = state[1]
      if (typeof React.Component !== 'function') return props.children
      function Guard() { return null }
      return h(Guard, { children: props.children })
    }

    function ExistingRuntime(props) {
      var t = makeT(props.t)
      var row = rowStyle
      var muted = { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, inherit)', overflowWrap: 'anywhere' }
      var column = { display: 'flex', flexDirection: 'column', gap: '8px', margin: '8px 0' }
      var card = { border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2))', borderRadius: '8px', padding: '10px 12px' }
      var pathStyle = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', overflowWrap: 'anywhere', margin: '4px 0' }
      var alertStyle = { color: 'var(--dsw-alias-state-error-primary, inherit)', fontSize: '12px' }
      var reportState = React.useState(null), report = reportState[0], setReport = reportState[1]
      var choiceState = React.useState(null), choice = choiceState[0], setChoice = choiceState[1]
      var pickState = React.useState(''), pick = pickState[0], setPick = pickState[1]
      var busyState = React.useState(false), busy = busyState[0], setBusy = busyState[1]
      var errorState = React.useState(''), error = errorState[0], setError = errorState[1]
      var envState = React.useState(null), environment = envState[0], setEnvironment = envState[1]
      var noticeState = React.useState(''), notice = noticeState[0], setNotice = noticeState[1]
      var alive = React.useRef(true)
      React.useEffect(function () { return function () { alive.current = false } }, [])
      function loadEnvironment() {
        props.rpc('managedEnvironment').then(function (value) { if (alive.current) setEnvironment(value) }).catch(function () {})
      }
      React.useEffect(function () { loadEnvironment() }, [])

      function copyText(value) {
        setNotice(t('已复制'))
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(value).catch(function () { setNotice(t('无法访问剪贴板，请手动复制。')) })
        } else setNotice(t('无法访问剪贴板，请手动复制。'))
      }
      function formatBytes(bytes) {
        var size = Number(bytes) || 0
        if (size >= 1024 * 1024 * 1024) return (size / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
        return Math.max(1, Math.round(size / (1024 * 1024))) + ' MB'
      }
      function adoptExisting(item) {
        run(function () {
          return props.rpc('adoptExisting', { reaEntry: item.reaEntry, nodePath: item.nodePath }).then(function () {
            if (!alive.current) return
            setReport(null); setChoice(null); setPick('')
            loadEnvironment()
            props.onChanged && props.onChanged()
          })
        })
      }
      function run(work) {
        setBusy(true); setError('')
        Promise.resolve().then(work).catch(function (failure) {
          if (alive.current) setError(t('操作失败：') + String(failure.message || failure))
        }).finally(function () { if (alive.current) setBusy(false) })
      }
      function detect() {
        run(function () {
          return props.rpc('detectExisting').then(function (value) {
            if (!alive.current) return
            setReport(value); setChoice(null); setPick('')
          })
        })
      }
      function choose(candidate) {
        run(function () {
          return props.rpc('detectNodes', { reaEntry: candidate.entry }).then(function (value) {
            if (!alive.current) return
            setChoice(value)
            var first = (value.nodes || []).filter(function (node) { return node.compatible })[0]
            setPick(first ? first.nodePath : '')
          })
        })
      }
      function adopt(nodePath) {
        var candidate = choice
        if (!candidate) return
        run(function () {
          return props.rpc('adoptExisting', { reaEntry: candidate.reaEntry, nodePath: nodePath }).then(function () {
            if (!alive.current) return
            setReport(null); setChoice(null); setPick('')
            loadEnvironment()
            props.onChanged && props.onChanged()
          })
        })
      }
      function keepEnvironment() {
        run(function () {
          return props.rpc('keepManagedEnvironment').then(function () {
            if (!alive.current) return
            setEnvironment(function (current) { return current ? Object.assign({}, current, { kept: true }) : current })
          })
        })
      }
      function removeEnvironment() {
        run(function () {
          return props.rpc('removeManagedEnvironment').then(function (value) {
            if (!alive.current) return
            setEnvironment(value.bytes ? { bytes: 0, generations: 0, root: environment && environment.root } : null)
            loadEnvironment()
          })
        })
      }
      function back() {
        run(function () {
          return props.rpc('useManagedRuntime').then(function () {
            if (!alive.current) return
            setReport(null); setChoice(null); setPick('')
            props.onChanged && props.onChanged()
          })
        })
      }

      function describeNode(node) {
        var parts = [node.managed ? t('插件托管 Node') : t('自有 Node'), node.nodeVersion]
        return parts.join(' · ')
      }
      function renderChoice() {
        if (!choice) return null
        var selected = (choice.nodes || []).filter(function (node) { return node.nodePath === pick })[0]
        var managed = (choice.nodes || []).filter(function (node) { return node.managed && node.compatible })[0]
        return h('div', { style: column, 'data-rea-node-choice': true },
          h('p', { style: muted }, t('选择运行这个 REA 的 Node：') + choice.reaVersion + ' · ' + choice.range),
          (choice.nodes || []).map(function (node) {
            return h('label', { key: node.nodePath, style: row },
              h('input', {
                type: 'radio', name: 'rea-node', checked: pick === node.nodePath,
                onChange: function () { setPick(node.nodePath) },
                'data-rea-node': node.nodePath,
              }),
              h('span', null, describeNode(node) + (node.compatible ? '' : ' · ' + t('不满足要求'))),
            )
          }),
          selected && !selected.compatible
            ? h('div', { style: column, 'data-rea-node-incompatible': true },
              h('p', { role: 'alert', style: alertStyle }, t('需要 Node {range}，当前 {version}。').replace('{range}', choice.range).replace('{version}', selected.nodeVersion)),
              managed
                ? h('button', { type: 'button', disabled: busy || !props.configurationWritable, onClick: function () { adopt(managed.nodePath) }, 'data-rea-upgrade-node': true }, t('一键升级到插件托管 Node（{version}）').replace('{version}', managed.nodeVersion))
                : h('p', { style: muted }, t('插件托管 Node 也不满足该 REA 的要求，请先在“运行时版本”里检查更新。')),
            )
            : null,
          h('div', { style: row },
            h('button', { type: 'button', disabled: busy || !props.configurationWritable || !selected || !selected.compatible, onClick: function () { adopt(pick) }, 'data-rea-adopt': (selected && selected.nodePath) || '' }, t('用这个 Node 接入')),
            h('button', { type: 'button', disabled: busy, onClick: function () { setChoice(null); setPick('') }, 'data-rea-cancel-node': true }, t('取消')),
          ),
        )
      }

      var current = report && report.current ? report.current : null
      var manual = current && current.manual ? current : null
      var candidates = report ? report.candidates || [] : []
      var promptChoice = props.choice && props.choice.length ? props.choice : null
      // Only meaningful while the user's own environment is in use; deleting the
      // runtime that is currently running REA is refused by the host.
      var installers = props.installers && props.installers.length ? props.installers : null
      var installCard = installers
        ? h('div', { style: column, 'data-rea-install-choice': true },
          h('p', null, t('本机没有可用的 Node 与 REA，请选择安装位置：')),
          h('button', { type: 'button', disabled: busy || !props.configurationWritable, onClick: function () { run(function () { return props.rpc('preferManaged').then(function () { props.onChanged && props.onChanged() }) }) }, 'data-rea-install-managed': true }, t('安装到插件环境（不碰系统 Node）')),
          h('p', { style: muted }, t('或安装到本机，然后回来重新检测：')),
          installers.map(function (installer) {
            return h('div', { key: installer.id, style: card },
              h('strong', null, installer.title),
              h('pre', { style: pathStyle, 'data-rea-install-command': installer.id }, installer.command),
              h('p', { style: muted }, installer.note),
              h('button', { type: 'button', disabled: busy, onClick: function () { copyText(installer.command) }, 'data-rea-copy-command': installer.id }, t('复制命令')),
            )
          }),
          h('button', { type: 'button', disabled: busy, onClick: detect, 'data-rea-redetect': true }, t('我已安装，重新检测')),
        )
        : null
      var blocked = environment && environment.blockedBy && environment.blockedBy.length ? environment.blockedBy : null
      var envCard = manual && environment && environment.nodeBytes && !environment.kept
        ? h('div', { style: card, 'data-rea-managed-env': true },
          h('p', { style: muted }, t('插件下载的 Node 仍占用 {size}；已安装的 REA 会保留，切回只需重新下载 Node，也可以保留。').replace('{size}', formatBytes(environment.nodeBytes))),
          blocked ? h('p', { role: 'alert', style: alertStyle }, t('其他 profile 仍在使用共享运行时，暂不能删除：') + blocked.map(function (item) { return item.profile }).join('、')) : null,
          h('div', { style: row },
            h('button', { type: 'button', disabled: busy || !props.configurationWritable || Boolean(blocked), onClick: removeEnvironment, 'data-rea-remove-env': true }, t('删除 Node 并释放空间')),
            h('button', { type: 'button', disabled: busy || !props.configurationWritable, onClick: keepEnvironment, 'data-rea-keep-env': true }, t('保留')),
          ),
        )
        : null
      return h('section', { style: box, 'data-rea-existing': true },
        installCard,
        promptChoice
          ? h('div', { style: column, 'data-rea-choose': true },
            h('p', null, t('检测到本机已有可用的 REA，可直接使用，无需下载插件运行时。')),
            promptChoice.map(function (item) {
              return h('div', { key: item.reaEntry, style: card },
                h('strong', null, 'REA ' + item.reaVersion + ' · Node ' + item.nodeVersion),
                h('div', { style: pathStyle }, item.reaEntry),
                h('button', { type: 'button', disabled: busy || !props.configurationWritable, onClick: function () { adoptExisting(item) }, 'data-rea-use-own': item.reaEntry }, t('使用本机已有的 REA')),
              )
            }),
            h('button', { type: 'button', disabled: busy || !props.configurationWritable, onClick: function () { run(function () { return props.rpc('preferManaged').then(function () { props.onChanged && props.onChanged() }) }) }, 'data-rea-prefer-managed': true }, t('改用插件托管环境')),
          )
          : null,
        h('h4', null, t('已有 REA 安装')),
        h('p', null, t('如果本机已经装过 REA，可以让插件直接使用它，而不是再准备一份托管运行时。')),
        manual
          ? h('p', { style: muted }, t('正在使用已有安装：') + manual.reaEntry)
          : h('p', { style: muted }, t('当前使用插件托管的运行时')),
        h('div', { style: row },
          h('button', { type: 'button', disabled: busy || !props.configurationWritable, onClick: detect, 'data-rea-detect': true }, busy ? t('检测中…') : t('检测已安装的 REA')),
          manual ? h('button', { type: 'button', disabled: busy || !props.configurationWritable, onClick: back, 'data-rea-use-managed': true }, t('切回托管运行时')) : null,
        ),
        error ? h('p', { role: 'alert', style: alertStyle }, error) : null,
        notice ? h('p', { style: muted, 'data-rea-notice': true }, notice) : null,
        envCard,
        report && !candidates.length ? h('p', { style: muted }, t('未找到可用的全局 REA 安装（已扫描 {n} 个位置）。').replace('{n}', String(report.scanned))) : null,
        report
          ? h('div', { style: column, 'data-rea-candidates': true },
            candidates.map(function (candidate) {
              return h('div', { key: candidate.root, style: card },
                h('div', { style: row },
                  h('strong', null, 'REA ' + candidate.reaVersion),
                  h('span', { style: muted }, candidate.usable ? t('可与兼容 Node 配合使用') : t('不可用：') + candidate.reason),
                ),
                h('div', { style: pathStyle }, candidate.entry),
                h('button', { type: 'button', disabled: busy || !props.configurationWritable, onClick: function () { choose(candidate) }, 'data-rea-choose-node': candidate.entry }, t('选择 Node 并接入')),
              )
            }),
          )
          : null,
        renderChoice(),
      )
    }

    function Panel(props) {
      var t = makeT(props.t)
      var viewState = React.useState(null), view = viewState[0], setView = viewState[1]
      var errorState = React.useState(''), error = errorState[0], setError = errorState[1]
      var noticeState = React.useState(''), notice = noticeState[0], setNotice = noticeState[1]
      var busyState = React.useState(false), busy = busyState[0], setBusy = busyState[1]
      var promptOpenState = React.useState(false), promptOpen = promptOpenState[0], setPromptOpen = promptOpenState[1]
      var readErrorState = React.useState(''), readError = readErrorState[0], setReadError = readErrorState[1]
      var optionalOpenState = React.useState(false), optionalOpen = optionalOpenState[0], setOptionalOpen = optionalOpenState[1]
      var lifetime = React.useRef(null), pending = React.useRef(false)

      function rpc(method, args) {
        return props.rpc(method, args || {}, lifetime.current && lifetime.current.signal)
      }
      function readStatus(attempt) {
        return rpc('status').catch(function (failure) {
          var signal = lifetime.current && lifetime.current.signal
          var transient = /gateway\/(service-unavailable|invocation-unavailable|definition-unavailable|binding-invalid)/.test(failure.code || '')
          if (!signal || signal.aborted || !transient || attempt >= 12) throw failure
          // Re-read only lightweight status across HMR; never replay writes.
          return new Promise(function (resolve) { setTimeout(resolve, 500) }).then(function () {
            if (!lifetime.current || signal.aborted) throw failure
            return readStatus(attempt + 1)
          })
        })
      }
      function reload() {
        return readStatus(0).then(function (snapshot) {
          setReadError(''); setView(Object.assign({}, snapshot, { available: true }))
        }).catch(function () {})
      }
      React.useEffect(function () {
        var controller = new AbortController()
        lifetime.current = controller
        var sync = createStatusSync(function () {
          return readStatus(0).catch(function (failure) {
            if (!controller.signal.aborted) {
              setReadError(t('REA 状态暂不可用：') + String(failure.message || failure))
              setView(function (current) { return current ? Object.assign({}, current, { available: false }) : current })
            }
            throw failure
          })
        }, function (snapshot) { setReadError(''); setView(Object.assign({}, snapshot, { available: true })) })
        return function () { sync.dispose(); controller.abort(); lifetime.current = null }
      }, [])

      function action(work) {
        if (pending.current) return
        pending.current = true; setBusy(true); setError(''); setNotice('')
        Promise.resolve().then(function () {
          if (!lifetime.current || lifetime.current.signal.aborted) return
          return work()
        }).catch(function (failure) {
          if (lifetime.current && !lifetime.current.signal.aborted) setError(String(failure.message || failure))
        }).finally(function () { pending.current = false; if (lifetime.current) setBusy(false) })
      }
      function copyPrompt() {
        action(function () {
          if (typeof navigator === 'undefined' || !navigator.clipboard || !navigator.clipboard.writeText) {
            setOptionalOpen(true); setPromptOpen(true)
            throw new Error(t('无法访问剪贴板，请在下方展开的指令中手动复制。'))
          }
          return navigator.clipboard.writeText(optionalToolsPrompt(t)).then(function () {
            if (lifetime.current) setNotice(t('已复制可选工具配置指令；仅针对本次缺失项检查，确认后再补齐依赖。'))
          }).catch(function (failure) {
            if (lifetime.current) { setOptionalOpen(true); setPromptOpen(true) }
            throw new Error(t('复制失败，请在下方展开的指令中手动复制。') + String(failure.message || failure))
          })
        })
      }
      var disabled = busy || !view || view.available === false || !view.configurationWritable
      var inflight = Number(view && view.activity && view.activity.inflight) || 0
      var callBlocked = !!(view && view.enabled !== false && inflight > 0)
      var missingDependency = !!(view && view.available !== false && view.enabled === true && view.runtime.phase === 'ready' && view.optionalTools && view.optionalTools.missingDependency === true)
      return h('div', { style: { maxWidth: '780px', overflowWrap: 'anywhere', fontSize: '13px', lineHeight: '1.55' }, 'data-rea-settings': true },
        h('style', { 'data-rea-panel-style': true }, panelCss),
        h('div', { className: 'rea-setting-header' },
          h('div', null, h('h3', null, t('REA 设置')), h('p', { className: 'rea-muted' }, t('工具接入、模型调用与按需配置'))),
          h('span', { className: 'rea-state' }, !view ? t('读取中') : view.available === false ? t('状态暂不可用') : t(phases[view.runtime.phase] || view.runtime.phase))
        ),
        readError ? h('p', { role: 'alert' }, readError) : null,
        error ? h('p', { role: 'alert', style: { whiteSpace: 'pre-wrap' } }, error) : null,
        notice ? h('p', { role: 'status' }, notice) : null,
        !view ? h('p', null, t('正在读取 REA 状态…')) : h(React.Fragment, null,
          h('section', { style: box, 'data-rea-global-switch': true },
            h('div', { className: 'rea-setting-header' },
              h('h4', null, t('REA 工具总开关')),
              h('button', {
                type: 'button', role: 'switch', className: 'rea-switch', 'aria-label': t('REA 工具总开关'), 'aria-checked': view.enabled, 'aria-disabled': callBlocked ? true : undefined, disabled: disabled,
                title: callBlocked ? t('REA 正在处理工具调用，完成后再关闭') : (view.enabled ? t('关闭全局 REA 工具') : t('开启全局 REA 工具')),
                onClick: function () {
                  if (disabled) return
                  if (callBlocked) { setError(t('REA 正在处理工具调用，完成后再关闭；现在关闭会中断正在执行的分析')); return }
                  action(function () {
                    // The accepted shared state is the receipt. Do not leave a
                    // stale "disabled" notice after another window re-enables REA.
                    return rpc('setEnabled', { enabled: !view.enabled }).finally(notifyConfigurationChanged)
                  })
                }
              }, busy ? t('切换中…') : view.enabled ? t('已开启') : t('已关闭'))
            ),
            h('p', { className: 'rea-muted' }, t('与输入框中的 REA 按钮共用同一全局开关，状态保持同步。')),
            callBlocked ? h('p', { role: 'status', className: 'rea-muted', 'data-rea-call-lock': true }, t('REA 正在处理 ') + inflight + t(' 个工具调用，完成前无法关闭；关闭会中断正在执行的分析。')) : null,
            h('div', { className: 'rea-impact-grid', 'data-rea-toggle-impact': true },
              h('div', { className: 'rea-impact-cell' }, h('h4', null, t('开启时')), h('p', null, t('向模型提供完整 REA 工具定义，允许调用逆向分析能力。')), h('p', { className: 'rea-muted' }, t('工具数量、参数 Schema 体积和工具上下文占用会增加。'))),
              h('div', { className: 'rea-impact-cell' }, h('h4', null, t('关闭时')), h('p', null, t('从后续模型请求中移除 REA 工具定义，模型不能再直接调用 REA。')), h('p', { className: 'rea-muted' }, t('已安装环境保留，再次开启可以复用，不会卸载软件。')))
            ),
            h('p', { className: 'rea-muted' }, t('关闭会结束临时分析会话，请先导出未保存证据。工具定义变化仅作用于后续请求，不会回溯删除既有对话。')),
            view.runtime.nodeVersion || view.runtime.reaVersion ? h('p', { className: 'rea-muted' }, (view.runtime.nodeVersion ? 'Node ' + view.runtime.nodeVersion : '') + (view.runtime.reaVersion ? ' · REA ' + view.runtime.reaVersion : '')) : null,
            view.runtime.phase === 'error' ? h('p', { role: 'alert', style: textStyle }, view.runtime.message) : null
          ),
          h(RuntimeVersions, { versions: view.runtimeVersions, runtime: view.runtime, busy: busy, configurationWritable: view.configurationWritable, action: action, rpc: rpc, t: t }),
          h(ExistingRuntime, { rpc: rpc, t: t, configurationWritable: view.configurationWritable, installers: view.runtime && view.runtime.installers, onChanged: reload }),
          h('section', { style: box, 'data-rea-model-impact': true },
            h('h4', null, t('模型调用提示')),
            h('p', null, t('当模型因工具参数 Schema 超过允许大小而调用失败时，可考虑临时关闭 REA 后重试；需要使用 REA 时再开启。')),
            h('p', { className: 'rea-muted' }, t('以下为常见接口/模式示例，不表示这些模型一定失败；具体限制以所选提供方、接口版本和错误消息为准。')),
            h('ul', { style: { paddingLeft: '18px', margin: '8px 0' } },
              h('li', null, t('Kimi / Moonshot：留意完整工具集合过大触发的 Schema 尺寸限制。')),
              h('li', null, t('DeepSeek（strict 模式）：服务端会严格校验指定的 JSON Schema 子集。 '), h('a', { href: 'https://api-docs.deepseek.com/guides/tool_calls/', target: '_blank', rel: 'noopener noreferrer' }, t('官方说明'))),
              h('li', null, t('GPT 系列（OpenAI strict 工具模式）：仅支持 JSON Schema 子集，其他接口模式的规则可能不同。 '), h('a', { href: 'https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create', target: '_blank', rel: 'noopener noreferrer' }, t('官方说明')))
            ),
            h('p', { className: 'rea-muted' }, t('这类模型接口错误不是缺少分析器依赖；不会自动关闭 REA，也不会自动裁剪工具。'))
          ),
          view.settingsEntryId && props.configForms ? h(ComposerPreference, { form: props.configForms.get(view.settingsEntryId), t: t }) : null
        ),
        missingDependency ? h('p', { role: 'status', className: 'rea-note', 'data-rea-dependency-hint': true }, t('本次使用的功能缺少已配置的可选工具依赖，可展开下方“可选工具配置”按需处理。')) : null,
        h('details', { className: 'rea-optional', 'data-rea-optional-tools': true, open: optionalOpen, onToggle: function (event) { setOptionalOpen(event.currentTarget.open) } },
          h('summary', null, h('span', { 'aria-hidden': true }, optionalOpen ? '▾' : '▸'), h('span', null, t('可选工具配置')), h('span', { className: 'rea-muted', style: { marginLeft: 'auto', fontWeight: 400 } }, t('非必需'))),
          h('div', { className: 'rea-optional-body' },
            h('p', { className: 'rea-muted' }, t('基础 Node / REA 由插件管理，通常无需额外安装。仅在所用功能确实缺少外部依赖时配置，不扫描全部可选组件。')),
            h('button', { type: 'button', className: 'rea-config-button', disabled: busy, onClick: copyPrompt }, t('复制配置指令')),
            h('details', { 'data-rea-config-instructions': true, open: promptOpen, onToggle: function (event) { setPromptOpen(event.currentTarget.open) } },
              h('summary', { style: { cursor: 'pointer', marginTop: '8px' } }, t('查看或手动复制指令')),
              h('pre', { style: textStyle }, optionalToolsPrompt(t))
            )
          )
        )
      )
    }

    function apply(ctx) {
      ensureIndicatorStyles()
      var locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
      if (locale && typeof locale.register === 'function' && typeof ctx.effect === 'function') {
        ctx.effect(function () { return locale.register(LOCALE_NS, { zh: ZH, en: EN }) }, 'dsh-reakit: dictionaries')
      }
      function rpc(method, args, signal) {
        return ctx.connection.rpc.call('/api', 'reaComponents/' + method, { args: args || {} }, signal).then(function (result) {
          if (!result.ok) {
            var failure = new Error(result.error && result.error.message || t('REA 组件请求失败'))
            failure.code = result.error && result.error.code
            throw failure
          }
          return result.value
        })
      }
      function Detail(props) {
        props = props || {}
        if (!props.subject || props.subject.kind !== 'bundle' || props.subject.pkg.name !== 'dsh-reakit') return null
        return h(Panel, { rpc: rpc, configForms: ctx.configForms, t: props.t })
      }
      function Settings(props) { props = props || {}; return h(Panel, { rpc: rpc, configForms: ctx.configForms, t: props.t }) }
      function ComposerToggle(props) { props = props || {}; return h(QuickToggle, { rpc: rpc, configForms: ctx.configForms, t: props.t }) }
      ctx.slots.inject('plugins.detail.section', function () {
        return ctx.slots.register({ name: 'plugins.detail.section', id: 'dsh-reakit.components', order: 40, locale: LOCALE_NS }, Detail)
      })
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({ name: 'settings.section', id: 'dsh-reakit', order: 65, locale: LOCALE_NS, label: function () { return 'REA' } }, Settings)
      })
      // Register independently in the native tools area. Other entries (such as
      // GenUI) may be absent; never locate their DOM, borrow their classes, or
      // replace them. Native slot order keeps REA beside any existing controls.
      ctx.slots.inject('conversation.input.left', function () {
        return ctx.slots.register({ name: 'conversation.input.left', id: 'dsh-reakit.quick-toggle', order: 100, locale: LOCALE_NS }, ComposerToggle)
      })
    }
    return { inject: ['slots', 'connection', 'configForms'], apply: apply, createStatusSync: createStatusSync, __testing: { ExistingRuntime } }
  }
})
