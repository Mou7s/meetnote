# MeetNote Web

Nuxt 4 + Nuxt UI 4 + TypeScript，Bun 安装与构建，部署 Cloudflare Workers。

## 使用

打开 https://meetnote.mou7s.workers.dev/ 即可使用，**不注册、不登录、不创建账号**。

首次进入填写自己的百炼 API Key、北京地域 API Host 和 DeepSeek API Key，保存后进入会议工作台。模型调用费用计入填写的服务商账号，也可以跳过密钥，仅录音。

会议和密钥通过当前浏览器的 HttpOnly、SameSite=Strict Cookie 独立标识隔离，线上 Cookie 使用 Secure。标识最长有效一年，换浏览器、清除 Cookie 或标识过期后无法找回原工作空间；当前没有跨设备同步。旧版已有有效会话的浏览器会自动接续原有数据。旧账号数据保留，登录、注册、初始化和账号管理接口已关闭。

密钥以 AES-256-GCM 加密保存在 D1，使用工作空间内部 ID 作为附加认证数据，保存后不回显。请求经本站服务端转发，调用时服务端会解密使用，属于服务端转发模式，不是端到端加密。Workers Secrets 仅需站点加密主密钥 USER_KEYS_ENCRYPTION_KEY，不保存共享模型密钥。

## 架构

- Nuxt 静态客户端由 Workers Static Assets 提供，同域 /api/* 由 Worker 处理。
- D1 保存浏览器工作空间映射、加密设置、访问标识与会议索引。历史 users/sessions 表为内部兼容存储，不再要求用户输入账号或密码。
- 每场会议一个 SQLite Durable Object，管理会议状态、转写、分析、音频顺序与去重、百炼连接。
- 私有 R2 保存约 1 MB 一段的 PCM；未归档音频先持久化到 Durable Object SQLite。回放组合 WAV 并支持 HTTP Range。

## 本地开发

需要 Bun 1.4.4 和 Wrangler 支持的 Node.js。Wrangler 当前不能直接由 Bun 运行，仅 Wrangler 使用 Node；依赖安装、Nuxt 构建和测试继续使用 Bun。

```powershell
cd web
bun install --frozen-lockfile
Copy-Item .dev.vars.example .dev.vars
# 在 .dev.vars 设置 USER_KEYS_ENCRYPTION_KEY，为 64 位十六进制随机值。
bun run build
bun run db:migrate
bun run dev
```

访问 http://127.0.0.1:3468。Wrangler 本地模拟 Workers、D1、R2 和 Durable Objects。填写真实模型密钥后仍会调用真实服务商。

## 部署

本次账号中的 D1 meetnote-db、R2 meetnote-recordings 和 Durable Object 已创建并绑定。换账号部署时需要新建资源并替换 wrangler.jsonc 的 D1 ID。

新站点首次部署时生成 USER_KEYS_ENCRYPTION_KEY，通过 wrangler deploy --secrets-file 安全提交包含该项的本地 JSON 文件，文件放在忽略的 .data/ 内。**已有站点不能重新生成主密钥**，否则已保存的模型密钥无法解密，应妥善备份。不要将主密钥写入 Git、日志或命令行参数。

已有部署更新：

```powershell
bun run typecheck
bun run build
bun test
bun x wrangler d1 migrations apply meetnote-db --remote
bun run deploy
```

R2 不应开启公开读取，所有会议、录音和密钥访问均按浏览器工作空间隔离。当前配置兼容 Workers Free，不声明自定义 CPU 限额；按真实用量监测站点与存储费用。

## 功能与检查

支持麦克风选择、音量、16 kHz PCM16 采集、暂停恢复、分块上传重试、在线转写、手动触发的流式全文总结、重点标记、历史回放下载和 JSON 导出。

8 项 workerd 集成检查、78 个断言覆盖无账号初始化、来源校验、工作空间与密钥隔离、加密不回显、旧账号接口关闭、音频顺序去重、WAV 和 Range、R2 归档边界、重启持久性与伪造标识拦截。测试不调用模型服务。

线上已验证无登录打开、个人密钥保存/不回显/移除、不同工作空间隔离、旧登录注册接口关闭。真实麦克风、云端模型效果和长时间录音尚未完成验证。

## 边界

- 浏览器需保持页面打开，未上传内存队列会在刷新/关闭时丢失。积压约 20 秒停止采集并提示重试；服务器已确认的分块已持久化。
- 单场录音最多两小时，列表暂显示最近 200 场。
- 点击“立即分析”总结截至点击时的全部已确认转写；录音中也可使用，不自动触发分析。
- 尚无全文检索、共享、删除、桌面历史导入、本地 Whisper/sherpa 或说话人区分。
- 活跃的百炼出站 WebSocket 需要常驻 Durable Object，不能依靠休眠免去该时段计算费用。

桌面版源码保留在仓库根目录，仍可独立运行。
