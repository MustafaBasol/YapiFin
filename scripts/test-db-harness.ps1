# YF-514 - Windows PowerShell icin ince sarmalayici. Tum mantik
# scripts/test-db-harness.mjs icindedir (Node cross-platform orkestrasyon) --
# bu betik yalnizca `docker`/`docker.exe` PATH'te olan bir Windows
# gelistiricisinin `.\scripts\test-db-harness.ps1 run -- npx vitest run`
# seklinde, `npm run` dolayli katmani olmadan cagirabilmesini saglar.
#
# Ornekler:
#   .\scripts\test-db-harness.ps1 up
#   .\scripts\test-db-harness.ps1 status
#   .\scripts\test-db-harness.ps1 run -- npx vitest run tests/account.test.ts
#   .\scripts\test-db-harness.ps1 down --run-id <id>

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$HarnessArgs
)

$ErrorActionPreference = "Stop"
$scriptPath = Join-Path $PSScriptRoot "test-db-harness.mjs"

node $scriptPath @HarnessArgs
exit $LASTEXITCODE
