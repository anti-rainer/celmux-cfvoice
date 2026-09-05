# celmux-cfvoice

这是 Celmux Cloudflare 语音系统的独立部署仓库。Worker 同时承载 Agent、
Durable Object、Realtime SFU 媒体桥和 Workers AI。

## 部署前准备

请先完成以下准备工作，再点击一键部署：

1. 注册并登录 Cloudflare 账号。
2. 在 Cloudflare 账号中完成付款方式/银行卡验证。RealtimeKit 和部分
   Workers AI 能力需要账号具备有效的计费资格；具体免费额度和价格以控制台
   当前显示为准。
3. 在 Cloudflare 控制台启用 **RealtimeKit**，创建一个应用。
4. 保存该应用的 **App ID** 和 **App Token**。它们只在部署时写入 Worker
   Secret，不能填入 Celmux 前端或提交到 Git。

## 一键部署

如果你已经登录 Cloudflare，打开下面的链接即可 Fork 并部署：

[使用 Cloudflare 部署 celmux-cfvoice](https://deploy.workers.cloudflare.com/?url=https://github.com/anti-rainer/celmux-cfvoice)

部署完成后，在 Cloudflare 控制台打开 Worker 的 **Settings → Variables and
Secrets**，添加以下变量（建议全部使用加密 Secret）：

| 变量 | 填写内容 |
| --- | --- |
| `CELMUX_AGENT_TOKEN` | 自己生成的随机字符串，稍后填写到 Celmux |
| `CLOUDFLARE_REALTIME_APP_ID` | Cloudflare RealtimeKit 应用 ID |
| `CLOUDFLARE_REALTIME_API_TOKEN` | RealtimeKit API Token |

Workers AI 使用绑定，不需要额外填写模型 API Key。

## 填写 Secret 并绑定自定义域名

部署 Worker 后：

1. 打开 Worker 的 **Settings → Variables and Secrets**。
2. 新增 `CELMUX_AGENT_TOKEN`、`CLOUDFLARE_REALTIME_APP_ID`、
   `CLOUDFLARE_REALTIME_API_TOKEN` 三个加密 Secret。
3. 打开 Worker 的 **Settings → Domains & Routes → Custom Domains**，绑定你
   自己的域名（例如 `voice.example.com`）。请不要把 `workers.dev` 地址作为
   对外服务地址，部分网络环境会污染或拦截该域名。
4. 复制自定义域名的 HTTPS 地址，稍后填入 Celmux 的「Agent 地址」。

Worker 会根据请求的来源自动返回 CORS 头，因此 Celmux 使用局域网 IP 或公网域名
都可以访问，不需要额外配置回源地址。接口仍然必须携带 `CELMUX_AGENT_TOKEN`，不要将
Worker 地址和 Token 误认为可以单独作为认证。

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

- **为什么部署后拨号失败？** 先确认 Agent 地址是 HTTPS、Celmux 与 Worker 的
  `CELMUX_AGENT_TOKEN` 完全一致，并确认 RealtimeKit 的 App ID/Token 已填写。
- **浏览器跨域错误？** 确认浏览器访问 Celmux 的地址可以访问 Worker，并检查
  Worker 请求中携带了正确的 Bearer Token。Worker 不需要配置回源域名。
- **如何更新？** 在仓库执行 `git pull && npm install && npm run deploy`，Durable
  Object 会保留已有通话记录。

## 安全提示

不要把任何 Token 写入 `wrangler.jsonc`、README 或提交到 Git。推荐使用
`wrangler secret put`，并定期轮换 `CELMUX_AGENT_TOKEN` 与 RealtimeKit Token。
