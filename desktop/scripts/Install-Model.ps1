$ErrorActionPreference = 'Stop'
$modelRoot = Join-Path $env:LOCALAPPDATA 'MeetingCompanion\Models'
$modelName = 'sherpa-onnx-streaming-paraformer-bilingual-zh-en'
$modelFolder = Join-Path $modelRoot $modelName
$requiredFiles = @('encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt', 'test_wavs/0.wav')
if (@($requiredFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $modelFolder $_)) }).Count -eq 0) {
    Write-Output "Model already installed: $modelFolder"
    exit 0
}
New-Item -ItemType Directory -Force -Path $modelRoot | Out-Null
$archive = Join-Path $modelRoot 'paraformer.tar.bz2'
# The upstream archive includes both float and quantized models (about 1 GB).
# Extract only the quantized models needed by MeetNote (about 226 MB).
curl.exe -L --fail --retry 2 -o $archive "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$modelName.tar.bz2"
if ($LASTEXITCODE -ne 0) { throw 'Model download failed.' }
$members = $requiredFiles | ForEach-Object { "$modelName/$_" }
tar -xjf $archive -C $modelRoot @members
if ($LASTEXITCODE -ne 0) { throw 'Model extraction failed.' }
foreach ($file in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $modelFolder $file))) { throw "Missing model file: $file" }
}
Remove-Item -LiteralPath $archive
Write-Output "Model installed: $modelFolder"
