# MeetNote · 实时会议助手

原生 WinUI 3 Windows 会议助手：左侧实时录音与转写，右侧由 DeepSeek 持续分析。支持在线识别、本地识别、分析历史和重点标记。

## 当前功能

- 麦克风选择、真实输入音量波形、录音计时、暂停/恢复、结束保存和退出确认。
- 默认在线模型 `qwen-audio-3.1-asr-flash-streaming`，使用远场会议 VAD；可切换 `fun-asr-realtime` 或 `paraformer-realtime-v2`。
- 在线识别在后台发送音频，按固定音频时间轴控制发送节奏，显示已发送时长和待发送秒数。暂停时结束云端任务，恢复后建立新任务，时间戳沿本地录音时间轴累计。
- Qwen 3.1 支持会议背景和专业词提示。厂家、人名、工艺及型号应使用确认过的写法；提示不保证识别正确，也不直接替换已生成文字。
- 可选 Whisper large-v3-turbo 本地分段识别，以及 sherpa-onnx Paraformer 本地流式识别。
- DeepSeek 默认自动分析：有新增确认转写时最快每 5 秒开始一轮，上轮未完成时不并发请求；生成内容流式显示，无新增内容时不请求。
- AI 分析按时间段追加，旧记录保留；生成失败保留之前的完整记录。自动分析开启时，会议结束另生成整场总结。
- 右侧默认“锁定最新”，生成及追加时跟随底部；取消勾选可回看，点击“查看最新”重新锁定。
- 录音、转写、重点标记、分段分析和识别错误信息保存到本地。转写断开时原始录音继续保存，并提示转写不完整。
- DPI 感知窗口与自适应导航。历史页目前通过资源管理器打开会议目录。

尚未实现：说话人区分、应用内历史回放与全文检索、托盘及快捷键。

## 在线转写设置

1. 在[百炼 API Key 页面](https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key)创建华北2（北京）地域的密钥。这里指服务地域，用户不需要位于北京。
2. 在 MeetNote 设置中选择“在线转写 · 阿里云百炼”，填写百炼 API Key。
3. 将创建密钥时提供的 **API Host** 填入对应字段，仅填写主机名。业务空间密钥应使用对应的 `ws-<workspace>.cn-beijing.maas.aliyuncs.com`；旧域名 `dashscope.aliyuncs.com` 也可配置。程序仅接受这两类北京地域百炼地址。
4. 选择 Qwen-Audio 3.1 实时会议模型，保存后开始录音。目标 ASR 模型需在业务空间开通调用权限。
5. 可填写会议背景（最多400个字符）及专业词（每行一个、最多50个，去重后按普通权重发送）。保存后在下一次录音生效。

在线模式会上传麦克风音频至阿里云，原始音频同时保存在本地；暂停期间不采集、不上传。免费额度、有效期及超额费用请查看[百炼控制台](https://bailian.console.aliyun.com/cn-beijing/costing-balance/free-quota)，不在文档中固定承诺价格。

接口说明：[Qwen Streaming 客户端事件](https://help.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-client-events)、[服务端事件](https://help.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-server-events)。

## AI 分析

设置中填写 **DeepSeek 独立的 API Key**，默认模型代号为 `deepseek-flash`，调用 DeepSeek 官方接口。百炼充值余额不能用于 DeepSeek。

分析面板中的“实时 AI 分析”开关立即生效并保存；“立即分析”用于手动分析新增转写。“重新总结”会仅依据左侧当前全部确认转写生成整体总结，成功后替换右侧分析及保存的分析记录，失败时保留原内容。生成过程中继续到达的转写，会由后续自动分析补充。结束录音时，程序等待剩余转写和当前分析完成，再按自动分析设置生成最终总结。

DeepSeek 接收会议主题、已有分析背景和确认转写文本，不接收音频；调用会产生 DeepSeek API 费用。百炼与 DeepSeek 密钥分别保存在 Windows 凭据管理器，不写入设置 JSON、会议文件或 Git。

分析是对转写文字的辅助整理。人名、术语、数字、负责人和日期都应结合原始录音确认，不能把公开样本通过当作现场准确率保证。

## 本地识别（可选）

### Whisper large-v3-turbo

安装 [uv](https://docs.astral.sh/uv/)，然后运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/Install-Whisper.ps1
```

脚本准备 Python 3.12、faster-whisper 和约 1.6 GB 模型。环境位于 `%LOCALAPPDATA%\MeetingCompanion\WhisperRuntime`；设置中模型目录应包含 `model.bin`、`config.json` 和 `tokenizer.json`。

Whisper 通过独立后台进程运行，CPU int8 推理，在停顿后分段出字，连续发言时约每15秒处理一段。开始录音后加载模型，加载期间的音频排队等待识别。运行阶段只使用本地模型文件，结束时等待剩余片段完成。速度和准确度取决于电脑与收音条件。

Python 环境和 Whisper 模型不包含在原生发布目录中，换电脑后需要重新安装。

### Paraformer

```powershell
powershell -ExecutionPolicy Bypass -File scripts/Install-Model.ps1
```

安装 sherpa-onnx 中英流式 Paraformer 模型，随后在设置中切换到轻量模型。模型目录需包含 `encoder.int8.onnx`、`decoder.int8.onnx`、`tokens.txt`。发布时会复制本机已安装的 Paraformer 模型；不含模型的发布包需要另行安装。

本地转写不需要云端识别密钥；如开启 DeepSeek 分析，转写文字仍会发送至 DeepSeek。

## 数据存储

每场会议保存在 `%LOCALAPPDATA%\MeetingCompanion\Meetings` 的独立目录：

- `recording.wav`：16 kHz、16 bit、单声道 PCM 原始音频。
- `meeting.json`：主题、时长、录音状态、转写方式、云端模型、转写错误、标记、确认转写、分析文本和 `analysisUpdates` 分段记录。

暂停时间不计入录音文件时长。转写时间戳为录音时间轴上的近似位置。分析历史从新版开始保存，旧版本已覆盖的摘要不会自动恢复；原始转写仍在会议文件中。

## 开发与检查

需要 Windows 10 1809 或更高版本、.NET 8 SDK，目标为 Windows x64。

```powershell
dotnet run --project MeetNote.csproj -c Release
```

不访问外部 API、不读取会议录音的协议检查：

```powershell
dotnet run --project tests/MeetNote.Checks.csproj -c Release -- --cloud-protocol
dotnet run --project tests/MeetNote.Checks.csproj -c Release -- --analysis-stream
```

默认检查命令还会使用已安装 Paraformer 模型的官方测试 WAV，检查本地识别、结束刷新及模型查找；DeepSeek 使用模拟响应：

```powershell
dotnet run --project tests/MeetNote.Checks.csproj -c Release
```

发布程序检查选项：

| 参数 | 内容 | 外部调用 |
|---|---|---|
| `--check-cloud-ui` | 创建窗口，检查 XAML 和设置加载后退出 | 无 |
| `--check-whisper` | 加载 Whisper 模型并退出，不送入音频 | 无 |
| `--check-transcriber` | 用官方 WAV 检查本地 Paraformer | 无 |
| `--check-cloud-service [wav路径]` | 用已保存密钥启动当前云端模型；可选 WAV 必须为16kHz单声道PCM16 | 会调用百炼，指定 WAV 时上传该文件 |

检查报告写入当前用户的 `MeetingCompanion` 本地数据目录。`--configure-cloud` 是凭据配置辅助入口，从标准输入接收配置、保存凭据并检查连接；不要将密钥写入命令行、脚本或仓库。验证结果与限制见 [VALIDATION.md](VALIDATION.md)。

## 发布

```powershell
dotnet publish MeetNote.csproj -c Release -r win-x64 --self-contained true -o ../meetnote-windows
```

运行完整目录中的 `MeetNote.exe`，不能单独复制 exe。发布前关闭该目录中运行的程序；也可发布到另一个目录后结束旧录音再切换。

Windows App SDK 与 sherpa-onnx 都提供 `onnxruntime.dll`。项目明确复制 sherpa 配套的 1.28.2 运行库，避免 ABI 冲突。升级 sherpa 时需同步修改复制路径，并重新检查实际发布进程。Whisper 的 Python/ONNX 依赖运行在独立进程中。

## 源码结构

| 文件 | 职责 |
|---|---|
| `MainWindow.xaml` / `.xaml.cs` | 录音工作台、设置、分析历史和滚动跟随 |
| `Recorder.cs` | 麦克风采集与 WAV 保存 |
| `ILocalTranscriber.cs` | 转写事件及输入接口，在线与本地实现共用 |
| `CloudTranscriber.cs` / `AsrHints.cs` | 百炼 WebSocket、发送时钟、结果解析与识别提示 |
| `LocalTranscriber.cs` / `ModelLocator.cs` | sherpa 流式识别和模型查找 |
| `WhisperTranscriber.cs` / `scripts/whisper_worker.py` | 本地 Whisper 进程和分段识别 |
| `DeepSeekAnalyzer.cs` / `AnalysisUpdate.cs` | 流式 AI 分析与分段记录 |
| `AssistantSettings.cs` | 用户设置和 Windows 凭据存储 |
| `App.xaml.cs` | 应用入口与发布程序检查 |

编译产物、录音、模型、Python 环境和密钥不应提交到源码仓库。
