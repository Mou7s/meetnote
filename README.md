# MeetNote · 实时会议助手

Nuxt 4 + Nuxt UI 4 + TypeScript 全栈应用，使用 Bun 安装、构建与部署（Nitro `bun` preset）。

## 使用

打开部署后的 MeetNote 服务即可使用，**不注册、不登录、不创建账号**。

首次进入填写自己的百炼 API Key、北京/新加坡地域 API Host 和 DeepSeek API Key。设置页支持在保存前直接点击 **「测试连接」** 验证密钥、地域 Host 与模型可用性；保存后即可进入会议工作台，也可以跳过密钥先使用纯录音。

会议和密钥通过当前浏览器的 `HttpOnly`、`SameSite=Strict` Cookie 独立标识隔离（HTTPS 下自动带 `Secure`）。标识最长有效一年，换浏览器、清除 Cookie 或标识过期后无法找回原工作空间；当前没有跨设备同步。登录、注册、初始化和账号管理接口已关闭。

密钥以 AES-256-GCM 加密保存在本地 SQLite，使用工作空间内部 ID 作为附加认证数据，保存后不回显。请求经服务端转发，调用时服务端会解密使用，属于服务端转发模式，不是端到端加密。服务端仅需配置加密主密钥 `USER_KEYS_ENCRYPTION_KEY`，不保存共享模型密钥。

## 架构

- **前端（`app/`）**：Nuxt 4 + Nuxt UI 4（`ssr: false`），通过 `AudioWorklet` 将麦克风重采样为 16 kHz 单声道 PCM16 并按小块流式上传。
- **服务端（`server/`）**：Nuxt Nitro（`preset: 'bun'`）统一托管前端页面与 `/api/*` 接口。
- **存储（`bun:sqlite` + 本地磁盘）**：
  - `MEETNOTE_DATA_DIR/meetnote.sqlite`（默认 `.data/store/meetnote.sqlite`）以 WAL 模式保存工作空间会话、加密密钥、限流记录与会议文档。
  - `MEETNOTE_DATA_DIR/recordings/<owner>/<meetingId>.pcm` 按顺序写入原始 PCM；回放时流式拼接 44 字节 WAV 头并支持 HTTP `Range`。
- **实时转写与 AI 会议洞察**：
  - 由 Bun 原生 `WebSocket` 直连阿里云百炼实时识别服务。
  - 右侧「AI 会议洞察」采用**会中增量更新 + 会后全量终版**模式：开启「自动总结」后，录音期间结合已有纪要与新增确认转写通过 SSE 流式原地更新，结束录音时自动生成一次全量终版纪要；右侧主视图始终只展示最新一份结构化 Markdown 纪要（核心要点 / 已明确决定 / 待办事项 / 待确认问题），历史快照折叠收纳，并支持一键复制与导出 `.md`。

## 本地开发与部署

只需 **Bun 1.4.4**，无需 Node.js 或 Wrangler。

```powershell
bun install --frozen-lockfile
Copy-Item .env.example .env
# 在 .env 设置 USER_KEYS_ENCRYPTION_KEY（64 位十六进制随机值），可用下方命令快速生成：
# bun -e "import { randomBytes } from 'node:crypto'; await Bun.write('.env', 'USER_KEYS_ENCRYPTION_KEY=' + randomBytes(32).toString('hex') + '\n')"
bun run dev
```

默认开发地址为 `http://127.0.0.1:3468`。

### 构建与生产启动

```powershell
bun run typecheck
bun run build
bun test
$env:PORT = '3468'; $env:NITRO_BUN_IDLE_TIMEOUT = '120'; bun run start
```

生产构建产物位于 `.output/`，使用 `bun run .output/server/index.mjs` 直接启动（推荐把运行参数写入 `.env`）。

### 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `USER_KEYS_ENCRYPTION_KEY` | 必填，64 位十六进制 AES-256 主密钥（**切勿在已有站点上重新生成，否则已存密钥无法解密**） | 无 |
| `MEETNOTE_DATA_DIR` | 数据库与 PCM 录音保存目录 | `.data/store` |
| `PORT` / `HOST` | 服务监听端口与绑定地址 | `3000` / `0.0.0.0` |
| `NITRO_BUN_IDLE_TIMEOUT` | Bun HTTP 空闲超时（秒），建议设为 `120` 以保障长 SSE 连接 | `10` |

## 功能与检查

支持麦克风选择、音量监测、16 kHz PCM16 采集、暂停恢复、分块上传重试、在线转写、密钥/模型连通性实时测试、会中增量更新与会后终版全文总结（安全 Markdown 渲染、历史快照折叠、一键复制与导出 `.md`）、历史回放下载和 JSON 导出。

自动化测试（`bun test`）覆盖：
- **端到端集成测试**：无账号初始化、Origin 来源校验、工作空间与密钥隔离、加密不回显、旧账号接口关闭、音频顺序去重、WAV 与 Range、多块字节一致性、重启恢复中断状态、伪造标识拦截以及 `auto-analyze` / `config/test` 接口检查；
- **分析逻辑单元测试**：全量重总结、增量只发新增转写与已有纪要、DeepSeek 连通性校验及百炼 Host 自动规范化。测试不调用真实外部模型服务。

## 边界

- 浏览器需保持页面打开，未上传内存队列会在刷新/关闭时丢失。积压约 20 秒停止采集并提示重试；服务器已确认的分块已持久化。
- 单场录音最多两小时，列表暂显示最近 200 场。
- 开启「自动总结」后，会在录音期间定期针对新增确认转写增量更新纪要，并在结束录音时自动生成终版全文纪要；也可随时关闭自动开关，手动点击增量更新或全文重整。
- 尚无全文检索、共享、删除或说话人区分。
- 单实例本地 SQLite 与本地磁盘架构适用于单机/容器部署（请持久化挂载 `MEETNOTE_DATA_DIR`）。

## 目录结构

```text
app/
  app.config.ts              Nuxt UI 主题配置
  app.vue                    应用外壳与视图切换
  assets/css/main.css        全局与页面样式
  components/                启动引导、会议工作台、Markdown 渲染、历史列表、设置表单组件
  composables/               录音队列与工作空间状态逻辑
  utils/                     时长/日期格式化、错误提取与安全 Markdown 解析
server/
  api/                       /api/* REST、连通性测试、音频流与 SSE 路由
  middleware/                Origin 校验与历史接口拦截
  plugins/                   服务启停生命周期（中断恢复与资源清理）
  services/                  百炼 WebSocket 转写与 DeepSeek 流式分析
  utils/                     SQLite、加密设置、鉴权与会议房间状态管理
public/
  favicon.svg                站点图标
  worklets/pcm.js            AudioWorklet 16 kHz PCM16 重采样
shared/
  types.ts                   前后端共享类型
tests/                       Bun 单元与端到端集成测试
nuxt.config.ts               Nuxt + Nitro (Bun preset) 配置
```
