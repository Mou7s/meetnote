$ErrorActionPreference = 'Stop'
$runtime = Join-Path $env:LOCALAPPDATA 'MeetingCompanion\WhisperRuntime'
$python = Join-Path $runtime 'Scripts\python.exe'
# uv installs a compatible Python without changing the system's default Python.
uv venv --python 3.12 $runtime
if ($LASTEXITCODE -ne 0) { throw 'Unable to prepare Python 3.12. Install uv first.' }
uv pip install --python $python 'faster-whisper==1.2.1' 'av==16.1.0'
if ($LASTEXITCODE -ne 0) { throw 'Unable to install Whisper dependencies.' }
$env:PYTHONUTF8 = '1'
$modelRoot = Join-Path $env:LOCALAPPDATA 'MeetingCompanion\Models\whisper'
& $python -c 'import sys; from faster_whisper.utils import download_model; print(download_model("turbo", cache_dir=sys.argv[1]))' $modelRoot
if ($LASTEXITCODE -ne 0) { throw 'Unable to download Whisper model.' }
Write-Output 'Whisper large-v3-turbo is installed locally. Select it in MeetNote settings.'
