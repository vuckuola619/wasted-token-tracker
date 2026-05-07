#!/usr/bin/env pwsh
# build.ps1 — Build Wasted Token Overlay as standalone Windows .exe
# Outputs:
#   src-tauri/target/release/wasted-token-overlay.exe   (raw binary)
#   src-tauri/target/release/bundle/nsis/*.exe           (installer)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# ── 1. Generate icons (required for bundle) ────────────────────────────────────
Write-Host "`n[1/4] Generating icons..."
$iconsDir = Join-Path $PSScriptRoot "src-tauri\icons"
New-Item -ItemType Directory -Force -Path $iconsDir | Out-Null

Add-Type -AssemblyName System.Drawing
foreach ($sz in @(32, 128, 256)) {
    $bmp = New-Object System.Drawing.Bitmap($sz, $sz)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::FromArgb(255, 14, 14, 22))
    $s   = $sz / 32.0
    $pts = [System.Drawing.PointF[]] @(
        [System.Drawing.PointF]::new(18*$s, 2*$s),  [System.Drawing.PointF]::new(10*$s, 16*$s),
        [System.Drawing.PointF]::new(16*$s, 16*$s), [System.Drawing.PointF]::new(12*$s, 30*$s),
        [System.Drawing.PointF]::new(22*$s, 14*$s), [System.Drawing.PointF]::new(16*$s, 14*$s),
        [System.Drawing.PointF]::new(22*$s, 2*$s)
    )
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 240, 180, 40))
    $g.FillPolygon($brush, $pts)
    $g.Dispose(); $brush.Dispose()
    $bmp.Save((Join-Path $iconsDir "${sz}x${sz}.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}
Copy-Item (Join-Path $iconsDir "32x32.png") (Join-Path $iconsDir "icon.png") -Force
Write-Host "   icons generated."

# ── 2. Check Rust ──────────────────────────────────────────────────────────────
Write-Host "`n[2/4] Checking Rust..."
if (-not (Get-Command rustc -ErrorAction SilentlyContinue)) {
    Write-Host "   Rust not found. Install it first:"
    Write-Host "   winget install Rustlang.Rust.MSVC"
    Write-Host "   Then restart terminal and re-run this script."
    exit 1
}
Write-Host "   $(rustc --version)"

# ── 3. Install tauri-cli if needed ────────────────────────────────────────────
Write-Host "`n[3/4] Checking tauri-cli..."
if (-not (Get-Command cargo-tauri -ErrorAction SilentlyContinue)) {
    Write-Host "   Installing tauri-cli v1 (takes ~5 min first time)..."
    cargo install tauri-cli --version "^1" --locked
}
Write-Host "   $(cargo tauri --version 2>&1)"

# ── 4. Build release .exe ─────────────────────────────────────────────────────
Write-Host "`n[4/4] Building release binary..."
Write-Host "   This compiles Rust + bundles WebView2 — takes 2-5 min."
cargo tauri build

$exePath = Join-Path $PSScriptRoot "src-tauri\target\release\wasted-token-overlay.exe"
$nsiPath = Get-ChildItem (Join-Path $PSScriptRoot "src-tauri\target\release\bundle\nsis\") -Filter "*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1

Write-Host "`n Build complete!"
if (Test-Path $exePath) { Write-Host "   Binary:    $exePath" }
if ($nsiPath)           { Write-Host "   Installer: $($nsiPath.FullName)" }
Write-Host "`n   Copy wasted-token-overlay.exe anywhere and run it."
Write-Host "   Make sure wasted-token-tracker server is running (node server.js)."
