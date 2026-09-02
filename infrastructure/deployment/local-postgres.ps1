# =====================================================================================
# FALLBACK local PostgreSQL 16, for machines without Docker.
#
# The committed development stack is compose (`pnpm dev:up`), and that is what CI uses.
# This script exists only because Docker Desktop needs administrator rights to install
# and this machine has neither. It runs PostgreSQL from the no-installer binaries as a
# normal user process.
#
# It is a DEVELOPMENT CONVENIENCE and carries no production meaning (doc §37.6).
# The production provider remains an infrastructure/CTO decision (T-17, N-03).
#
#   .\local-postgres.ps1 status | start | stop | psql
#
# Everything lives under the scratchpad directory, so nothing is installed system-wide
# and deleting that directory removes it completely.
# =====================================================================================
param([Parameter(Position = 0)][ValidateSet('status', 'start', 'stop', 'psql')][string]$Command = 'status')

$ErrorActionPreference = 'Stop'

$scratch = 'C:\Users\CY2110_archit\AppData\Local\Temp\claude\c--Starlink\3b4e473f-6d52-4314-a6ec-5b1d7c435b01\scratchpad'
$bin = Join-Path $scratch 'pg16\pgsql\bin'
$data = Join-Path $scratch 'pgdata'
$log = Join-Path $scratch 'pg.log'
$env:PGPASSWORD = 'starlink_dev_only'

function Test-Listening {
    (Test-NetConnection -ComputerName localhost -Port 5432 -WarningAction SilentlyContinue).TcpTestSucceeded
}

switch ($Command) {
    'status' {
        if (-not (Test-Path $bin)) {
            Write-Host 'binaries absent — this machine has no fallback PostgreSQL set up' -ForegroundColor Yellow
            exit 1
        }
        Write-Host "binaries : $bin"
        Write-Host "data     : $data"
        Write-Host "listening: $(Test-Listening)"
        if (Test-Listening) {
            & (Join-Path $bin 'psql.exe') -U starlink -h localhost -p 5432 -d starlink -X -tAc `
                "SELECT 'database=' || current_database() || ' ' || substring(version() from 'PostgreSQL [0-9.]+');"
        }
    }
    'start' {
        if (Test-Listening) { Write-Host 'already running'; exit 0 }
        & (Join-Path $bin 'pg_ctl.exe') -D $data -l $log -o '-p 5432 -c listen_addresses=localhost' -w start
    }
    'stop' {
        & (Join-Path $bin 'pg_ctl.exe') -D $data -m fast -w stop
    }
    'psql' {
        & (Join-Path $bin 'psql.exe') -U starlink -h localhost -p 5432 -d starlink
    }
}
