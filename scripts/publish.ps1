<#
.SYNOPSIS
    Build and publish Lorekeeper to GitHub Releases.
.DESCRIPTION
    - Checks prerequisites (node, pnpm, git)
    - Warns about uncommitted changes
    - Runs typecheck and lint
    - Cleans build artifacts
    - Builds the Electron app and publishes with --publish always
    - Forces English prompt language for the published build
.EXAMPLE
    .\scripts\publish.ps1
#>

$ErrorActionPreference = 'Stop'

# ---- Prerequisites ----
$nodeReq = '18'
$pnpmReq = '8'

try {
  $nodeVer = node --version
  $pnpmVer = pnpm --version
} catch {
  Write-Host "[ERROR] node and pnpm are required." -ForegroundColor Red
  exit 1
}

Write-Host "[INFO] node $nodeVer  |  pnpm v$pnpmVer" -ForegroundColor Cyan

# ---- Working directory ----
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Write-Host "[INFO] Working directory: $root" -ForegroundColor Cyan

# ---- Git status check ----
$status = git status --porcelain
if ($status) {
  Write-Host ""
  Write-Host "[WARN] You have uncommitted changes:" -ForegroundColor Yellow
  $status | ForEach-Object { Write-Host "       $_" -ForegroundColor Yellow }
  Write-Host ""
  $confirm = Read-Host "Continue with uncommitted changes? (y/N)"
  if ($confirm -ne 'y' -and $confirm -ne 'Y') {
    Write-Host "[ABORT] Publish cancelled." -ForegroundColor Red
    exit 1
  }
  Write-Host ""
}

# ---- Environment variable check ----
$envFile = Join-Path $root '.env.local'
if (Test-Path $envFile) {
  Write-Host "[WARN] .env.local is present and will affect local dev, but" -ForegroundColor Yellow
  Write-Host "       the published build uses PROMPT_LANG=en (forced below)." -ForegroundColor Yellow
  Write-Host ""
}

# ---- Pre-build checks ----
Write-Host "[STEP] Running typecheck..." -ForegroundColor Green
pnpm run typecheck
if ($LASTEXITCODE -ne 0) {
  Write-Host "[ERROR] Typecheck failed. Fix errors before publishing." -ForegroundColor Red
  exit 1
}
Write-Host "[OK]   Typecheck passed." -ForegroundColor Green
Write-Host ""

Write-Host "[STEP] Running lint..." -ForegroundColor Green
pnpm run lint
if ($LASTEXITCODE -ne 0) {
  Write-Host "[ERROR] Lint failed. Fix errors before publishing." -ForegroundColor Red
  exit 1
}
Write-Host "[OK]   Lint passed." -ForegroundColor Green
Write-Host ""

# ---- Build & Publish ----
Write-Host "[STEP] Cleaning previous builds..." -ForegroundColor Green
pnpm run clean
Write-Host "[OK]   Cleaned." -ForegroundColor Green
Write-Host ""

Write-Host "[BUILD] Publishing Lorekeeper (PROMPT_LANG=en)..." -ForegroundColor Magenta
Write-Host ""

& {
  $env:PROMPT_LANG = 'en'
  $env:VITE_PROMPT_LANG = 'en'
  pnpm dist -- --publish always
}

if ($LASTEXITCODE -eq 0) {
  Write-Host ""
  Write-Host "[DONE] Publish completed successfully." -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "[ERROR] Publish failed (exit code: $LASTEXITCODE)." -ForegroundColor Red
  exit 1
}
