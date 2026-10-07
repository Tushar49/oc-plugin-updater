# Windows convenience shim — all logic lives in bin\cli.mjs (cross-platform).
$ErrorActionPreference = 'Stop'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host 'node not found on PATH. Install Node.js >= 18 (https://nodejs.org), or run: node bin\cli.mjs' -ForegroundColor Yellow
    exit 2
}
& $node.Source (Join-Path $PSScriptRoot 'bin\cli.mjs') @args
exit $LASTEXITCODE
