# Celmux Cloudflare voice stack

这是 Celmux 的完整 Cloudflare 语音系统，不是本地 WebRTC/SIP 的插件，
也不是失败后的备用路径。

```text
Browser (Realtime SFU) / SIP RTP bridge / automatic answer
        ↕                    ↕                    ↕
CelmuxCallAgent (one Agent / Durable Object per call)
  ├─ bounded 48 kHz stereo ↔ 16 kHz mono PCM routing
  ├─ Workers AI continuous STT or Whisper large-v3-turbo chunked STT and translation
  ├─ Aura-1 / Aura-2 raw 16 kHz PCM streaming TTS
  ├─ durable caption records
  └─ role-scoped WebSocket tickets and SFU cleanup
        ↕ carrier role            ↕ access role
Celmux IMS boundary       Celmux SIP/automatic access boundary
        ↕
IMS AMR-WB / PCMA RTP
```

本地语音系统独立负责 LAN/TURN WebRTC、SIP、自动接听、自定义模型和本地
记录。配置选中 Cloudflare 后，一通电话的媒体生命周期只属于 Cloudflare 栈，
不会尝试本地 ICE、TURN 或本地模型回退。

## 前期准备：开通 Serverless SFU

本项目使用的是 **Cloudflare Serverless SFU（官方文档中的 Realtime SFU）**，
不是 RealtimeKit。两者关系是：RealtimeKit 是带会议、参与者、Preset 和 UI
组件的上层产品；Serverless SFU 只提供会话、轨道和媒体转发 API，正好适合
Celmux 自己管理 IMS、SIP、票据和界面。

请先完成以下准备：

1. 登录 Cloudflare Dashboard，进入 **Realtime → SFU / Serverless SFU**，创建一个
   SFU 应用并开通服务。若账号尚未启用 Realtime，按控制台提示完成计费/付款方式
   设置。
2. 保存该 SFU 应用的 **App ID** 与 **API 令牌**，这两个值将用于 Worker Secret。
   API 令牌应授予 **Realtime / Realtime Admin** 权限；不要填入浏览器或提交到仓库。
3. 部署 Worker 后为它设置自定义域名。`workers.dev` 开发域名在部分网络环境中可能被污染，
   Celmux 应填写可正常访问的 `https://` 自定义域名。

> 不需要创建 RealtimeKit 应用，也不需要 RealtimeKit 的 participant token、会议或
> UI Kit。Celmux 直接调用 Serverless SFU 的 HTTPS API 和 WebSocket 适配器。

## 一键部署

如果你已经登录 Cloudflare，可以使用下面的按钮创建自己的 Worker 项目。部署向导只会
创建 Worker 和 Durable Object，Serverless SFU 应用仍需按上面的步骤提前创建。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/anti-rainer/celmux-cfvoice)

## 部署配置

推荐使用脚本完成首次部署。脚本会安装依赖、检查 Wrangler 登录、运行类型检查与
dry-run、只为缺失项设置 Secret，最后部署：

```sh
npm run setup
```

手动部署：

```sh
npm ci
npm run check
npx wrangler secret put CELMUX_AGENT_TOKEN
npx wrangler secret put CLOUDFLARE_SFU_API_TOKEN
npx wrangler secret put CLOUDFLARE_SFU_APP_ID
npm run deploy
```

`npm run check` 等价于 `tsc --noEmit` 加 `wrangler deploy --dry-run`，用于在
真正的部署前发现类型或 Worker 配置问题。部署后的 Worker 在 Cloudflare
Workers Logs 中保留结构化日志（`observability.head_sampling_rate: 1`）。

- `CELMUX_AGENT_TOKEN`：只供 Celmux 后端调用 Worker 管理 API。
- `CLOUDFLARE_SFU_APP_ID`：SFU 应用的 App ID，用于 Worker 连接 Serverless SFU。
- `CLOUDFLARE_SFU_API_TOKEN`：SFU 应用的 API 令牌，用于 Worker 调用 Serverless SFU API。
  以上两个值都配置为 Worker Secret，绝不返回浏览器。
- 每通电话生成 `carrier`、`access`、SFU 上行、SFU 下行、控制通道五张不同票据。
- `browser`、`sip`、`automatic` 是三种 Agent 接入角色；只有浏览器角色创建
  Realtime SFU 会话，SIP 与自动接听通过各自的 16 kHz PCM access 通道接入。
- Celmux 与 Agent 间固定使用 16-bit little-endian、16 kHz、mono、20 ms PCM。
- 转写模式可在 Celmux「语音系统」中切换：`Realtime 流式` 使用 Workers AI Flux
  长连接；`Whisper large-v3-turbo 分片` 使用 16 kHz PCM 能量 VAD，在持续发声
  后检测到换气/语气停顿时结束片段，再提交至
  `@cf/openai/whisper-large-v3-turbo`，不再按固定秒数盲切。翻译、字幕保存及
  上行译音共用同一处理链。
- 实时 Flux 会话按语音活动懒启动：某个方向出现人声才建立 WebSocket，连续
  20 秒数字静音后关闭，并保留 300 ms 预卷保护首音节。这样通话中的长静音、
  等待和只听不说的方向不再持续消耗流式额度。分片模式只在 VAD 检测到语句时
  调用 Whisper，本身已是低成本路径。
- 文本翻译默认使用 `@cf/zai-org/glm-4.7-flash`，失败时回退到
  `@cf/meta/llama-3.2-3b-instruct`。两者按 token 计费，电话短句的翻译成本
  远低于流式 STT（$0.0077/分钟）和 Aura TTS；免费额度主要由 Flux 和 Aura
  决定。
- 开启上行语音翻译后，Agent 停止透传我方原音，将 Flux 断句翻译到配置的
  对方语言；选择自动识别时使用英语，再请求 Aura-1 的 `linear16`、
  `container:none`、16 kHz 原始音频。
  Aura 的任意网络分片会重组为每帧 640 字节，并按 20 ms 节奏送入 IMS 媒体桥。
- 上行译音按句串行，失败的句子只报告一次且不重试；来话方向永远播放原音，
  不请求或播放译音。自动接听也不会启用上行译音，以免欢迎语被二次处理。
- 上行译音可在 Celmux 中选择 Aura-1 / Aura-2 English / Aura-2 Spanish 的
  模型专属音色（男女声分组）；该音色只影响 Cloudflare 语音系统，不会混用本地
  语音系统的 Voice ID。Aura-2 的字符计费约为 Aura-1 的 2 倍（$0.03 对
  $0.015 每 1k 字符），免费额度紧张时建议保持 Aura-1。
- Cloudflare 语音系统设置页提供转文字、文本翻译和语音输出三个效果测试，
  测试直接调用 Agent 的 `/api/test`，不会创建通话、SFU 会话或写入通话字幕。
- 队列拥塞时丢弃实时帧，不积压后重放。
- 通话结束由 Celmux 的独立关闭队列调用 `DELETE /api/calls/{session_id}`；Agent
  等待最后一个断句窗口后关闭转写、WebSocket、SFU adapters 和 tracks，再返回最终字幕。

上行语音翻译要求同时开启转文字并明确选择我的语言；对方语言为自动识别时，
上行译音默认使用英语。关闭该功能时，
浏览器和 SIP 的原始上行 PCM 直接透传给 Celmux。

也可以运行 `npm run setup` 自动安装依赖、检查 Wrangler 登录状态并逐项设置 Secret。
脚本输出的 `workers.dev` 地址只适合临时验证；正式使用前请在 Cloudflare 控制台绑定
自定义域名，再把该 HTTPS 地址填入 Celmux。

## 实现参考

本 Worker 的语音管线、SFU 适配器和部署方式与以下官方实现保持对齐：

- [Agents SDK 官方 voice-agent 示例](https://github.com/cloudflare/agents/tree/main/examples/voice-agent)：
  Realtime SFU + Workers AI Flux 的完整参考实现，本项目的 `sfu.ts`、`WorkersAIFluxSTT`
  用法参考自该示例。
- [Agents SDK voice 源码](https://github.com/cloudflare/agents/tree/main/packages/agents/src/voice)：
  `agents/voice` 的 SFU 辅助函数、音频格式转换和 provider 实现。本项目已从已废弃的
  `@cloudflare/voice` 兼容包迁移到该路径。
- [Realtime SFU WebSocket adapter](https://developers.cloudflare.com/realtime/sfu/media-transport-adapters/websocket-adapter/)：
  `buffer`（WebSocket→WebRTC，32 KB/消息）与 stream（WebRTC→WebSocket，PCM 48 kHz
  立体声 protobuf）模式的协议和生命周期说明。
- [Plivo voice agent 示例](https://github.com/cloudflare/agents/tree/main/examples/plivo-voice-agent)：
  电话接入和 `wrangler deploy` 后自动读取部署地址的脚本模式。

依赖说明：`agents` 的 voice API 仍标记为实验性，必须锁定版本升级；旧
`@cloudflare/voice` 包只是兼容转发层，不应继续出现在新代码中。翻译与 TTS 仍直接
使用 Workers AI binding，因为实时译音需要原始 16 kHz PCM，而 `WorkersAITTS`
返回的 MP3 无法在 Workers 运行时解码为 PCM。

## 维护者：从 Celmux 主仓库同步

`celmux-cfvoice` 是 Celmux 主仓库 `cloudflare/voice-interpretation-worker` 的
subtree 镜像。修改请提交到主仓库，然后在主仓库执行：

```sh
./scripts/push-cfvoice.sh
```

脚本使用 `git subtree split` 生成只包含该目录的提交，并推送到 cfvoice 仓库的
`main` 分支；推送后 Cloudflare Workers Builds 会按仓库配置自动构建部署。不要把
Secret、`.dev.vars` 或 `node_modules` 提交进任一仓库。
