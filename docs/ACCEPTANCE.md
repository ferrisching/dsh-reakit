# REA 本机真实引擎验收

## 零配置托管运行时、设置入口与总开关

2026-11-10，在同一 macOS arm64 / DSH 0.2.2-rc.1 desktop profile 验收。

**VERIFIED：不填写 Node / REA 路径即可使用完整工具目录；详情页关闭后模型可见 REA 工具为 0 项，设置页重新开启恢复为原有完整的 229 项。** 该结论不表示所有外部分析器均已安装或所有工具都已逐个执行。

### 实际证据

- 空的默认托管目录首次初始化成功：独立 Node 24.22.1 + 固定 REA 6.8.0，全部 optional 包包含在 npm 安装中，脚本仍禁用；没有依赖项目目录中的旧运行时。
- 自动初始化锁文件 SHA-256：`8dc59ed24940902f01740d61f35904562e0adac23ce970a09cf6bb59651d082f`；所有 181 个锁定依赖记录有官方 npm HTTPS 来源与 SRI。
- 独立真实 Cordis 生命周期：`{}` 配置 → 229 工具；自建 ASAR 中 2 个 JS 解析成功、0 错误；关闭 → 0 工具；离线重新开启 → 229 工具；初始化器网络调用为 0，卸载后也为 0 工具。
- 当前真实 GUI：插件详情显示组件与配置面板；全局账号菜单 → 设置 → REA 提供真实独立设置入口，两处都可控制总开关。
- 当前真实宿主：详情页点击关闭后持久配置 `enabled=false`、实际 REA schema 数量 0；设置页点击开启后 `enabled=true`、schema 数量恢复 229，所有工具名称与开启基线完全一致。
- 当前真实设置页：展开 Java 显示只读检测到的完整 JDK、白名单字段和完整 AI 配置提示词；点击一键配置，将现有的 Temurin JDK 17 路径仅写入本插件 `env.JAVA_HOME`，未安装或升级 Java。
- 额外组件安装只验证了预览界面和模拟安装器：JADX 预览列出准确发布 URL、SHA-256 与目标，实际安装按钮在勾选计划确认前禁用；本轮没有安装 Ghidra、Java、JADX、WABT 或商业分析器。
- PTY 原生模块在托管运行时加载成功；Frida npm 包已安装但原生绑定缺失，详情页如实显示手动修复/AI 指引，不执行其含 shell/make 的安装脚本。

### 回归覆盖与限制

单元与集成测试覆盖：固定 Node 下载与摘要拒绝、隔离 npm/tar 环境、离线复用、互斥初始化、失败与取消不发布、根目录和文件篡改拒绝、首次初始化期间关闭、握手期间关闭子 fiber、断线工具撤销后重连、完整工具保留、owner-only 配置接口、共享依赖计划漂移拒绝、下载 JAR 摘要不符拒绝、组件状态与设置双入口。

自动安装器不改系统 / DSH 内置 Node，不改用户 npmrc/PATH。安装期间不会主动分析目标。其他操作依旧服从 REA 的平台、依赖、许可证和用户授权要求；不声称用户权限进程获得沙箱。Windows / Linux 尚未做真实机器集成验收。

### 本机文件（不进入生产插件包）

- `.local/zero-config-20261110/installation.json`：空目录自动准备结果。
- `.local/zero-config-20261110/lifecycle/report.json`：真实独立生命周期与离线测试。
- `.local/zero-config-20261110/host-migration.json`：仅本插件从旧项目路径迁移到托管默认值，含迁移前配置。
- `.local/zero-config-20261110/live-baseline.json`：开启时完整工具名称基线。
- `.local/zero-config-20261110/live-disabled.json`、`gui-disabled.json`：点击详情开关后实际 0 工具与 GUI 状态。
- `.local/zero-config-20261110/live-reenabled-and-configured.json`：设置页开启及一键 Java 配置后的完整目录核对。
- `.local/zero-config-20261110/gui-install-preview.json`：未执行安装的计划确认界面。

当前配置不再依赖项目内 `.runtime/`。不需要清理旧文件；如果移动项目，已安装插件及托管运行时不受旧项目路径影响。不要手动删除正在使用的 DSH 托管运行时；先从 REA 设置中关闭。

## 历史记录：手工运行时模式

以下保留初始验收的历史事实，不是当前默认安装方式。

验收日期：2026-11-10（Asia/Shanghai）。平台：macOS / arm64；宿主：当前 DeepSeek Harness desktop profile，DSH 0.2.2-rc.1；兼容性修复：输出 schema 默认改为 `off`。

## 结论与范围

**基础 MCP 集成及 JavaScript / ASAR 静态分析通过。** 使用真实 `rea-agents@6.8.0`，不是协议模拟器；当前 DSH 中的实际 agent 已成功调用 REA 工具。未调用模型 API 代替工具测试、未运行样本代码、未分析用户其他应用、未发布代码。

这不是“所有 229 个工具 / 所有分析器均通过”的结论。商业反编译器、原生代码反编译、动态目标运行及其他平台未验收。

## 独立运行时与完整性

- Node：官方 `node-v24.22.1-darwin-arm64` 便携包，位于项目 `.runtime/` 内。
- 官方下载地址：<https://nodejs.org/dist/v24.22.1/node-v24.22.1-darwin-arm64.tar.gz>。
- 官方校验清单：<https://nodejs.org/dist/v24.22.1/SHASUMS256.txt>。
- 已验证 SHA-256：`89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7`。
- REA：npm 官方源 `rea-agents@6.8.0`，独立安装到 `.runtime/rea/`，禁用生命周期脚本、未安装可选 Frida。
- npm 锁定的 SRI：`sha512-9QDeRnGqEDzABZyr04eLnBXBv/c6I9/TWu/6M0MD4pEfkySI/BIgwTODIbAReX3C1x6hjw9+Jlx4A2yUSPZ9ww==`，与该版本官方 registry 元数据一致；这不等同于逐文件签名审计。
- Homebrew 预览会升级 10 个共享依赖，因此未执行 Homebrew 安装。系统 Node 仍为 v26.11.0，未替换 DSH 内置 Node。

## 验收项目

| 项目 | 实测结果 |
| --- | --- |
| 安装预检 | 包名、版本、engine、入口及真实 Node v24.22.1 均通过 |
| 真实 MCP 握手与发现 | 发现 229 个上游工具；官方 DSH MCP 客户端成功适配 |
| 自建 ASAR 分析 | 3 个相关文件；2 个 JavaScript 文件解析成功；0 个解析失败 |
| 结构化结果 | 保留完整 Evidence 与分析摘要；输入不执行 |
| 负向验证 | 不存在的输入路径返回 `invalid_request`，未伪装成功 |
| 独立测试实例清理 | 实例卸载后注册工具数为 0 |
| 当前宿主集成 | `include:rea` 激活，实际 agent 工具可见且可直接调用 |
| 当前 GUI | 原有 URL 的插件管理页面显示 dsh-reakit；没有启动替代服务器 |

样本由本项目测试源码打包为 ASAR，没有从用户其他应用获取内容。样本 SHA-256：`6834f50859f7c1ddc2d0335686916a866d6d36453ce802f6bcdaa45d0563c6b5`。

当前宿主已实际调用：

1. `binary_session`：`expected_package_version=6.8.0` 与准确入口路径校验通过；`server_identity.alignment.state=aligned`；协议协商为 `2026-07-28`；`open=false`、`cleanup_pending=false`。
2. `analyze_javascript_application`：对同一样本执行 `detail=summary`，返回父 Evidence `ev_5497714d79788a11a6d27f49933d56dd13bad8bb085d1d41156b27a2a0416306`。
3. 摘要 Evidence：`ev_057976c8cb54f65658d5aabe49b4095c6f84b9d7907bf5dc574b7343b47b600d`。
4. `export_evidence_bundle`：在本机保存 2 条记录，157733 字节。

静态分析仍有 20 个 semantic unknowns，语义覆盖为 unknown / 部分关系覆盖；不能将“两个文件解析成功”表述为行为完全恢复、运行时正确性证明或完整源代码复原。

## 发现并修复的问题

初次真实启动失败：发布版报 `REA_MCP_OUTPUT_SCHEMA_PROFILE` 只接受 `full` / `off`。上游 `main` 文档中的 `compact` 功能不在此次 npm 6.8.0 发布物内。

修复内容：输出 schema 默认改为 `off`，配置校验拒绝 `compact`，增加回归测试。此设置只省略客户端广告的 outputSchema，保留 REA 服务端 canonical 校验和完整 `structuredContent`。输入 schema 仍为受支持的 `compact`。

初次失败记录保留，没有删除或覆盖；修复后的独立测试结果保存在新目录中。

## 本机证据与回退

以下为仓库中的本机文件，不进入生产插件包：

- `.local/acceptance-20261110/engine/report.json`：初次失败。
- `.local/acceptance-20261110/engine-fixed/report.json`：修复后真实引擎、官方桥接、负向用例和清理结果。
- `.local/acceptance-20261110/host/before.json`：启用前本插件配置（`enabled:false`）与原有插件 ID 清单。
- `.local/acceptance-20261110/host/activated.json`：激活后配置与 229 个实时工具 schemas。
- `.local/acceptance-20261110/host/evidence-bundle.json`：真实宿主分析的完整 REA Evidence。
- `.local/rea.config.json`：本机独立 Node / REA 路径与启用配置。

所有配置变更均经用户当前任务授权，通过官方插件管理及 `configEditor.edit` 仅修改本插件；未替换整个 profile，也未替换全局 Skill。必要时在 DSH 插件管理中停用 dsh-reakit，可关闭该实例；需要恢复配置时通过同一配置编辑接口恢复 `before.json` 中本插件的 config，勿用历史整文件覆盖当前 profile。

不要删除 `.runtime/`：当前启用配置依赖其中的可执行文件。卸载、清理运行时或移走项目目录前，应先停用插件并修改路径。

## 未覆盖事项

- 宿主返回 Hopper 启动器缺失、Ghidra 未配置、IDA 未配置，因此未进行原生反编译；没有因此自动安装商业软件、Java 或其他分析器。
- 没有对真实第三方应用、浏览器目标、设备、网络或进程运行执行动态分析。
- 没有验证 Windows / Linux，也没有声称所有模型服务能够容纳完整工具清单。229 个 schema 会增加上下文开销。

基础接入和静态样本验收没有必需后续。若要进行原生反编译，下一步应明确授权目标，并选择和配置合法分析器；若需大规模日常使用，可另行设计按需工具曝光，不能照搬未发布版的 hot/cold 设置。
