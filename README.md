# MeetNote · 实时会议助手

MeetNote 是原生 WinUI 3 Windows 实时会议助手，在会议进行中持续录音，将语音实时转写为文字，并通过 AI 同步分析会议内容。

## 产品目标

主界面采用左右两栏：

- **左侧：录音内容。** 展示持续更新的语音转写文字，让用户随时回看会议中说过的内容，并标记重点。
- **右侧：AI 分析。** 根据不断更新的会议内容，实时整理要点、决定和待办，辅助用户理解和跟进会议。

核心流程是“实时录音 → 实时转写 → AI 分析”。转写和分析应在会议进行中持续更新。

## 当前实现进度

已实现：

- 麦克风选择、WAV 录音、暂停/恢复、重点标记和退出保存确认。
- sherpa-onnx 本地中英流式转写：左侧显示已确认文字和正在识别的文字。时间戳为录音时间轴上的分段起始位置，属于近似值，不是逐字对齐。
- DeepSeek 分析：右侧展示要点、决定、待办和待确认事项。支持手动分析，以及每 20 秒检查新增内容并自动分析；自动模式结束会议时生成最终总结。
- 模型目录、DeepSeek 密钥和模型名称设置。密钥保存在 Windows 凭据管理器，不写入会议文件或 Git。
- 音频、转写、重点标记和最近分析一起保存到会议目录。
- 高 DPI 显示适配：默认以普通窗口居中打开，初始大小根据屏幕缩放和可用区域调整；导航栏随窗口宽度自动收起，左右内容区等宽。

尚未实现：说话人区分、应用内历史回放和全文检索、托盘、快捷键、自动标点及云端转写切换。当前历史页仍通过资源管理器打开会议目录。

## 首次使用

如果使用的是带 `Models` 目录的完整发布包，可以直接运行 `MeetNote.exe`。从源码开发或使用不带模型的发布包时，先在仓库根目录安装本地转写模型（官方压缩包约 1 GB，安装脚本仅保留约 226 MB 的量化模型）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/Install-Model.ps1
```

脚本从 [sherpa-onnx 官方模型发布](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-paraformer/paraformer-models.html) 下载中英流式 Paraformer 模型。无需部署 Python 服务或训练模型，使用 CPU 识别。模型存放在 `%LOCALAPPDATA%\MeetingCompanion\Models`，不纳入 Git。发布时若该目录已有完整模型，会自动复制到发布目录的 `Models` 子目录；带模型的完整发布包可以换电脑使用。程序会依次检查配置路径、发布目录和本地安装目录。

在应用设置页确认模型目录，填写 DeepSeek API 密钥。默认模型为 `deepseek-flash`，可修改为账号支持的模型名称。自动分析默认关闭；开启后保存设置，再开始会议。也可以保留关闭状态，在需要时点击“立即分析”。

音频始终在本机录制和识别。开启自动分析或点击“立即分析”时，会将会议主题、转写文字和已有分析发送到 DeepSeek 官方 API，并产生 API 费用。没有密钥也能录音和转写。

本地模型可能误识别人名、专业词和中英混合内容，AI 分析需对照原文确认。识别处理在后台运行；转写失败时保留本地录音，AI 请求失败时保留已有结果并允许重试。

## 开发运行

需要 Windows 10 1809 或更高版本，以及 .NET 8 SDK。

项目使用 C#、WinUI 3、NAudio 和 sherpa-onnx，当前面向 Windows x64。

```powershell
dotnet run --project MeetNote.csproj -c Release
```

录音存放于 `%LOCALAPPDATA%\MeetingCompanion\Meetings`，每场会议独立目录，包含 `recording.wav` 和 `meeting.json`。后者包含主题、时长、录音状态、标记、转写段落和 AI 分析。暂停期间不写入音频、不转写，重点标记对应实际录音时间。

## 检查

```powershell
dotnet run --project tests/MeetNote.Checks.csproj -c Release
```

使用官方测试音频检查本地流式识别、结束刷新和模型缺失处理；DeepSeek 使用模拟 HTTP 响应检查请求格式、返回解析和错误处理，不进行付费 API 调用。实际麦克风质量和真实 DeepSeek 结果需要现场验证。

安装模型后，还可以在发布程序中执行检查，验证 WinUI 与转写运行库在同一进程中正常工作：

```powershell
../meetnote-windows/MeetNote.exe --check-transcriber
```

检查结果写入 `%LOCALAPPDATA%\MeetingCompanion\transcriber-check.txt`。使用安装脚本提供的测试音频，不录制麦克风，不调用 DeepSeek。详细记录见 [VALIDATION.md](VALIDATION.md)。

## 发布

```powershell
dotnet publish MeetNote.csproj -c Release -r win-x64 --self-contained true -o ../meetnote-windows
```

使用完整发布目录运行 `MeetNote.exe`，不能单独复制 exe。

Windows App SDK 和 sherpa-onnx 都提供 `onnxruntime.dll`。项目在编译及发布后明确复制 sherpa-onnx 配套版本，避免模型加载时因运行库不兼容而崩溃。升级 sherpa-onnx 时，需同步更新项目中的运行库复制路径，并重新执行发布程序检查。

## 项目结构

```text
meetnote/                 Git 仓库，存放源码和文档
├─ App.xaml.cs            应用入口及发布程序检查
├─ MainWindow.xaml        左右两栏界面和设置页
├─ MainWindow.xaml.cs     会议流程及界面交互
├─ Recorder.cs            麦克风采集及 WAV 保存
├─ LocalTranscriber.cs    本地流式识别后台任务
├─ ModelLocator.cs        模型目录检查与自动查找
├─ DeepSeekAnalyzer.cs    DeepSeek 分析接口
├─ AssistantSettings.cs   设置与凭据存储
├─ scripts/               模型安装脚本
└─ tests/                 转写及 API 模拟检查

meetnote-windows/         与仓库并列的发布目录
```

`bin`、`obj` 为自动生成的编译产物，已由 `.gitignore` 忽略。录音、密钥、模型和发布程序不提交到源码仓库。
