#!/usr/bin/env pwsh
# setup.ps1 — One-shot setup + launch for Wasted Token Overlay
# Run: cd tauri-overlay; .\setup.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# ── 1. Generate icons ─────────────────────────────────────────────────────────
Write-Host "`n[1/4] Generating icons..."
$iconsDir = Join-Path $PSScriptRoot "src-tauri\icons"
New-Item -ItemType Directory -Force -Path $iconsDir | Out-Null

Add-Type -AssemblyName System.Drawing
$sizes = @(32, 128, 256)
foreach ($sz in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($sz, $sz)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode  = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    # Background: dark navy
    $g.Clear([System.Drawing.Color]::FromArgb(255, 14, 14, 22))
    # Lightning bolt polygon (scaled to icon size)
    $s = $sz / 32.0
    $pts = [System.Drawing.PointF[]] @(
        [System.Drawing.PointF]::new(18*$s,  2*$s),
        [System.Drawing.PointF]::new(10*$s, 16*$s),
        [System.Drawing.PointF]::new(16*$s, 16*$s),
        [System.Drawing.PointF]::new(12*$s, 30*$s),
        [System.Drawing.PointF]::new(22*$s, 14*$s),
        [System.Drawing.PointF]::new(16*$s, 14*$s),
        [System.Drawing.PointF]::new(22*$s,  2*$s)
    )
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 240, 180, 40))
    $g.FillPolygon($brush, $pts)
    $g.Dispose(); $brush.Dispose()

    $outPath = Join-Path $iconsDir "${sz}x${sz}.png"
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "   icon ${sz}x${sz} -> $outPath"
}
Copy-Item (Join-Path $iconsDir "32x32.png") (Join-Path $iconsDir "icon.png") -Force
Write-Host "   done."

# ── 2. Check / install Rust ───────────────────────────────────────────────────
Write-Host "`n[2/4] Checking Rust..."
$rustc = Get-Command rustc -ErrorAction SilentlyContinue
if (-not $rustc) {
    Write-Host "   Rust not found — installing via winget (MSVC toolchain)..."
    winget install --id Rustlang.Rust.MSVC -e --silent --accept-source-agreements
    # Refresh PATH
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("PATH","User")
    $cargoPath = "$env:USERPROFILE\.cargo\bin"
    if (Test-Path $cargoPath) { $env:PATH += ";$cargoPath" }
}
$rustVer = rustc --version 2>&1
Write-Host "   $rustVer"

# ── 3. Install tauri-cli v1 ───────────────────────────────────────────────────
Write-Host "`n[3/4] Installing tauri-cli (v1)..."
$tauriCli = Get-Command "cargo-tauri" -ErrorAction SilentlyContinue
if (-not $tauriCli) {
    Write-Host "   Running: cargo install tauri-cli --version ^1 --locked"
    Write-Host "   (this takes 3-5 minutes on first run — compiling from source)"
    cargo install tauri-cli --version "^1" --locked
} else {
    Write-Host "   already installed: $(cargo tauri --version 2>&1)"
}

# ── 4. Dev launch ─────────────────────────────────────────────────────────────
Write-Host "`n[4/4] Launching overlay (dev mode)..."
Write-Host "   Make sure wasted-token-tracker server is running at http://127.0.0.1:3777"
Write-Host "   Press Ctrl+C to stop.`n"
cargo tauri dev
