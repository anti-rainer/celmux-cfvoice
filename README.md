# celmux-cfvoice

这是 Celmux Cloudflare 语音系统的独立部署仓库。它只需要部署一个
Cloudflare Worker：同一个 Worker 同时承载 Agent、Durable Object、Realtime
SFU 媒体桥和 Workers AI，不需要再创建第二个 Worker。

## 一键部署

如果你已经登录 Cloudflare，打开下面的链接即可 Fork 并部署：

[使用 Cloudflare 部署 celmux-cfvoice](https://deploy.workers.cloudflare.com/?url=https://github.com/anti-rainer/celmux-cfvoice)

部署完成后，在 Cloudflare 控制台打开 Worker 的 **Settings → Variables and
Secrets**，添加以下变量（建议全部使用加密 Secret）：

| 变量 | 填写内容 |
| --- | --- |
| `CELMUX_AGENT_TOKEN` | 自己生成的随机字符串，稍后填写到 Celmux |
| `CELMUX_ALLOWED_ORIGIN` | Celmux 网页地址，例如 `https://vo2.example.com` |
| `CLOUDFLARE_REALTIME_APP_ID` | Cloudflare RealtimeKit 应用 ID |
| `CLOUDFLARE_REALTIME_API_TOKEN` | RealtimeKit API Token |

Workers AI 使用绑定，不需要额外填写模型 API Key。部署完成后复制 Worker 的
HTTPS 地址，例如 `https://celmux-cfvoice.<account>.workers.dev`。

## Celmux 中的配置

进入 **系统设置 → 语音接入 → 语音系统**：

1. 选择「Cloudflare 语音系统」。
2. 将 Worker HTTPS 地址填入「Agent 地址」。
3. 将 `CELMUX_AGENT_TOKEN` 填入「Agent Token」。
4. 根据需要打开转文字、文字翻译和上行语音翻译。
5. 转写模式可选择：
   - **Realtime 流式**：延迟最低，使用 Cloudflare Realtime STT。
   - **Whisper large-v3-turbo 分片**：每秒提交短音频片段，节省 Realtime 转写额度。
6. 点击「保存语音配置」，下一通电话生效。

## 命令行部署

```bash
npm install
npx wrangler login
npx wrangler secret put CELMUX_AGENT_TOKEN
npx wrangler secret put CELMUX_ALLOWED_ORIGIN
npx wrangler secret put CLOUDFLARE_REALTIME_APP_ID
npx wrangler secret put CLOUDFLARE_REALTIME_API_TOKEN
npm run deploy
```

也可以运行 `./scripts/setup.sh`，脚本会检查 Wrangler 登录状态并逐项提示配置
Secret；不会把 Token 写入仓库。

## 工作原理

```text
Celmux ──HTTPS/PCM──> celmux-cfvoice Worker
                         ├─ Agent / Durable Object（每通电话一个实例）
                         ├─ Realtime SFU（浏览器媒体）
                         └─ Workers AI
                            ├─ Flux Realtime STT
                            └─ Whisper large-v3-turbo 分片 STT
```

Celmux 与 Worker 之间固定传输 16 kHz、单声道、PCM16、20 ms 音频帧。下行始终
播放对方原音；只有开启「上行语音翻译」时，翻译后的 TTS 音频才会替换我方上行。

## 常见问题

- **需要两个 Worker 吗？** 不需要。一个 Worker 即可完成 Agent、SFU 和 AI 推理。
- **为什么部署后拨号失败？** 先确认 Agent 地址是 HTTPS、Celmux 与 Worker 的
  `CELMUX_AGENT_TOKEN` 完全一致，并确认 RealtimeKit 的 App ID/Token 已填写。
- **浏览器跨域错误？** 将 Celmux 实际访问地址（含协议）填写到
  `CELMUX_ALLOWED_ORIGIN`，多个地址用逗号分隔。
- **如何更新？** 在仓库执行 `git pull && npm install && npm run deploy`，Durable
  Object 会保留已有通话记录。

## 安全提示

不要把任何 Token 写入 `wrangler.jsonc`、README 或提交到 Git。推荐使用
`wrangler secret put`，并定期轮换 `CELMUX_AGENT_TOKEN` 与 RealtimeKit Token。
