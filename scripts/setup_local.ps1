# Set up rendering on this computer (Windows, NVIDIA GPU): ComfyUI in .\ComfyUI, one Python venv in .\.venv with
# ComfyUI's and the render server's packages, and the models (~70 GB). Safe to re-run (downloads resume).
#   powershell -ExecutionPolicy Bypass -File scripts\setup_local.ps1              # then: .venv\Scripts\python -m server.local
#   powershell -ExecutionPolicy Bypass -File scripts\setup_local.ps1 -SkipModels  # everything but the models
# Needs git, Python 3.10-3.12 (the py launcher, or -Python C:\path\python.exe), ~80 GB of disk, and a Hugging Face
# Read token with "Agree and Access" clicked on both LTX repos (see setup_pod.sh). Same files as setup_pod.sh and
# setup_look_models.sh: tests/test_scripts.py checks the lists match.
param(
    [string]$Python = "",
    [string]$ComfyDir = "",
    [switch]$SkipModels
)
$ErrorActionPreference = "Stop"
$Repo = Split-Path -Parent $PSScriptRoot
Set-Location $Repo
if (-not $ComfyDir) { $ComfyDir = if ($env:COMFY_DIR) { $env:COMFY_DIR } else { Join-Path $Repo "ComfyUI" } }

function Run($exe, [string[]]$argv) {
    & $exe @argv
    if ($LASTEXITCODE -ne 0) { throw "$exe $($argv -join ' ') failed (exit $LASTEXITCODE)" }
}

Write-Host "== This computer"
if (-not $Python) {
    $Python = (& py -3.12 -c "import sys; print(sys.executable)" 2>$null)
    if (-not $Python) { $Python = (& py -3 -c "import sys; print(sys.executable)" 2>$null) }
    if (-not $Python) { throw "Python not found: install 3.12 from python.org, or pass -Python C:\path\python.exe" }
}
Run $Python @("-c", "import sys; assert sys.version_info >= (3, 10), 'Python 3.10+ needed'; print('Python', sys.version.split()[0])")
Run $Python @("-c", "from server.doctor import gpus, ram_gb, hardware_checks`nfor ok, msg in hardware_checks(gpus(), ram_gb()): print(('ok   ' if ok else 'WARN ') + msg)")

Write-Host "== ComfyUI ($ComfyDir)"
if (Test-Path (Join-Path $ComfyDir "main.py")) {
    & git -C $ComfyDir pull --ff-only
    if ($LASTEXITCODE -ne 0) { Write-Host "(couldn't update ComfyUI; keeping the version there)" }
} else {
    Run git @("clone", "--depth", "1", "https://github.com/Comfy-Org/ComfyUI", $ComfyDir)
}

Write-Host "== Python packages (.venv)"
$Py = Join-Path $Repo ".venv\Scripts\python.exe"
if (-not (Test-Path $Py)) { Run $Python @("-m", "venv", ".venv") }
Run $Py @("-m", "pip", "install", "-q", "--upgrade", "pip")
Run $Py @("-m", "pip", "install", "-q", "torch", "torchvision", "torchaudio", "--index-url", "https://download.pytorch.org/whl/cu128")
Run $Py @("-m", "pip", "install", "-q", "-r", (Join-Path $ComfyDir "requirements.txt"), "-r", "server\requirements.txt", "-r", "requirements.txt")

if ($SkipModels) {
    Write-Host "-SkipModels: models skipped. Run this again without it to fetch them."
} else {
    Write-Host "== Models (~70 GB)"
    $M = Join-Path $ComfyDir "models"
    $drive = (Get-Item $ComfyDir).PSDrive
    $freeGb = [math]::Floor($drive.Free / 1GB)
    Write-Host "$freeGb GB free on $($drive.Name):"
    $token = $env:HF_TOKEN
    if (-not $token) {
        $secure = Read-Host "HF token" -AsSecureString
        $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    }
    # repo, file in repo, folder under models\, gated (needs the token)
    $files = @(
        @("Lightricks/LTX-2.5", "diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors", "diffusion_models", $true),
        @("Lightricks/LTX-2.5", "text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", "text_encoders", $true),
        @("Lightricks/LTX-2.5", "vae/ltx-2.5-video-vae-bf16.safetensors", "vae", $true),
        @("Lightricks/LTX-2.5", "vae/ltx-2.5-audio-vae-bf16.safetensors", "vae", $true),
        @("Lightricks/LTX-2.5", "latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors", "latent_upscale_models", $true),
        @("Lightricks/LTX-2.5-22b-IC-LoRA-Layout-To-Render", "ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors", "loras", $true),
        @("Comfy-Org/z_image_turbo", "split_files/diffusion_models/z_image_turbo_bf16.safetensors", "diffusion_models", $false),
        @("Comfy-Org/z_image_turbo", "split_files/text_encoders/qwen_3_4b.safetensors", "text_encoders", $false),
        @("Comfy-Org/z_image_turbo", "split_files/vae/ae.safetensors", "vae", $false),
        @("alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1", "Z-Image-Turbo-Fun-Controlnet-Union-2.1-2602-8steps.safetensors", "model_patches", $false)
    )
    $bad = 0
    foreach ($f in $files) {
        $dir = Join-Path $M $f[2]
        New-Item -ItemType Directory -Force $dir | Out-Null
        $dest = Join-Path $dir (Split-Path $f[1] -Leaf)
        if (Test-Path $dest) { Write-Host "  have $(Split-Path $dest -Leaf)"; continue }
        $url = "https://huggingface.co/$($f[0])/resolve/main/$($f[1])"
        Write-Host "  $(Split-Path $dest -Leaf)"
        # into .part (resumed on a re-run), renamed once complete, so a file that's there is a whole file
        $curlArgs = @("-L", "--fail", "-C", "-", "--retry", "5", "-o", "$dest.part", $url)
        if ($f[3]) { $curlArgs = @("-H", "Authorization: Bearer $token") + $curlArgs }
        & curl.exe @curlArgs
        if ($LASTEXITCODE -eq 0) { Move-Item -Force "$dest.part" $dest }
        else { Write-Host "!! $url failed (exit $LASTEXITCODE): repo terms accepted? token right?"; $bad++ }
    }
    if ($bad) { throw "$bad download(s) failed; fix and run this again (finished files are kept)" }
}

Write-Host ""
Write-Host "== Check"
$env:COMFY_BASE_URL = "http://127.0.0.1:8189"   # server.local's proxy
& $Py -m server.doctor --local
Write-Host ""
Write-Host "Start rendering here with:   .venv\Scripts\python -m server.local"
Write-Host "then in the app: Render... > This computer."
