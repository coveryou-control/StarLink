# =====================================================================================
# Phase 1 gate (a): prove the boundary law FAILS THE BUILD on a deliberate violation.
#
# Doc §18.3: without a build-time check, a modular monolith is a naming convention, and
# naming conventions decay. A rule that has never been observed to fail is not evidence.
#
# This script asserts three things:
#   1. the clean tree passes
#   2. a domain package importing an adapter implementation FAILS — including the
#      realistic case where the developer also declares the dependency so it resolves
#   3. a DECIDING module importing AI FAILS (Part IV §57 / ADR-022)
#
# Case 3 was added on 2026-08-29 with `packages/ai-assist`. A rule written and never
# observed to fail is documentation, and the AI rule is the one where that matters most:
# it protects an invariant nobody would knowingly break, which is exactly the kind that
# gets broken by a plausible-looking line in a routing branch.
# =====================================================================================
$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Set-Location $repo

$pkgPath = Join-Path $repo 'packages\conversation-domain\package.json'
$violationPath = Join-Path $repo 'packages\conversation-domain\src\__boundary_violation__.ts'
$fixturePath = Join-Path $PSScriptRoot 'domain-imports-adapter.ts.fixture'

$routingPkgPath = Join-Path $repo 'packages/routing/package.json'
$routingViolationPath = Join-Path $repo 'packages/routing/src/__boundary_violation__.ts'
$routingFixturePath = Join-Path $PSScriptRoot 'routing-imports-ai.ts.fixture'

# pnpm may be on PATH directly, or only reachable through corepack.
$pnpmOnPath = $null -ne (Get-Command pnpm -ErrorAction SilentlyContinue)
function Invoke-Pnpm {
    if ($pnpmOnPath) { & pnpm @args } else { & corepack pnpm @args }
}

function Write-NoBom([string]$path, [string]$text) {
    # PowerShell 5.1's Set-Content -Encoding utf8 emits a BOM, which makes package.json
    # unreadable to Node-based resolvers. Always write these files without one.
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

$originalPkg = [System.IO.File]::ReadAllText($pkgPath)
$originalRoutingPkg = [System.IO.File]::ReadAllText($routingPkgPath)
$failures = @()

try {
    Write-Host '[1/3] clean tree should PASS' -ForegroundColor Cyan
    Invoke-Pnpm exec depcruise --config .dependency-cruiser.cjs packages adapters | Out-Null
    if ($LASTEXITCODE -ne 0) { $failures += 'clean tree reported violations' }

    Write-Host '[2/3] declared cross-boundary import should FAIL' -ForegroundColor Cyan
    Write-NoBom $pkgPath ($originalPkg -replace
        '"@starlink/shared-contracts": "workspace:\*"',
        "`"@starlink/shared-contracts`": `"workspace:*`",`n    `"@starlink/adapter-iam`": `"workspace:*`"")
    Copy-Item $fixturePath $violationPath -Force
    Invoke-Pnpm install --silent | Out-Null
    Invoke-Pnpm exec depcruise --config .dependency-cruiser.cjs packages adapters | Out-Null
    if ($LASTEXITCODE -eq 0) { $failures += 'BOUNDARY LAW DID NOT CATCH A DELIBERATE VIOLATION' }

    # Restore case 2 before case 3, so a failure below names its own cause.
    Write-NoBom $pkgPath $originalPkg
    if (Test-Path $violationPath) { [System.IO.File]::Delete($violationPath) }

    Write-Host '[3/3] routing importing AI should FAIL (Part IV 57, ADR-022)' -ForegroundColor Cyan
    Write-NoBom $routingPkgPath ($originalRoutingPkg -replace
        '"@starlink/shared-contracts": "workspace:\*"',
        "`"@starlink/shared-contracts`": `"workspace:*`",`n    `"@starlink/ai-assist`": `"workspace:*`"")
    Copy-Item $routingFixturePath $routingViolationPath -Force
    Invoke-Pnpm install --silent | Out-Null
    Invoke-Pnpm exec depcruise --config .dependency-cruiser.cjs packages adapters | Out-Null
    if ($LASTEXITCODE -eq 0) { $failures += 'AI RULE DID NOT CATCH A DECIDING MODULE IMPORTING AI' }
}
finally {
    Write-NoBom $pkgPath $originalPkg
    Write-NoBom $routingPkgPath $originalRoutingPkg
    if (Test-Path $violationPath) { [System.IO.File]::Delete($violationPath) }
    if (Test-Path $routingViolationPath) { [System.IO.File]::Delete($routingViolationPath) }
    Invoke-Pnpm install --silent | Out-Null
}

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Host "FAIL: $_" -ForegroundColor Red }
    exit 1
}
Write-Host 'GATE (a) PASSED: boundaries are enforced, not merely documented.' -ForegroundColor Green
exit 0
