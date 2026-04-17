# ACP UI start/restart script (Native)
# Builds frontend first — if build fails, aborts to protect the running instance.
# Usage: .\run.ps1        (production: backend serves built frontend)
#        .\run.ps1 dev    (dev mode: backend + vite dev server with HMR)

param([string]$Mode = "prod")

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir
$PidFileBE = "$env:TEMP\acpui-backend.pid"
$PidFileFE = "$env:TEMP\acpui-frontend.pid"
$LogBE = "$env:TEMP\acpui-backend.log"
$LogFE = "$env:TEMP\acpui-frontend.log"

# Read ports from .env
$envFile = Get-Content "$RootDir\.env" -ErrorAction SilentlyContinue
$BackendPort = 3005
$FrontendPort = 5173
foreach ($line in $envFile) {
    if ($line -match '^BACKEND_PORT=(\d+)') { $BackendPort = [int]$Matches[1] }
    if ($line -match '^FRONTEND_PORT=(\d+)') { $FrontendPort = [int]$Matches[1] }
    if ($line -match '^LOG_FILE_PATH=(.+)') { 
        $LogBE = $Matches[1].Trim()
        # Ensure the directory for the log file exists
        $logDir = Split-Path -Parent $LogBE
        if (-not (Test-Path $logDir)) {
            New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        }
        # Create an empty placeholder file if it doesn't exist
        if (-not (Test-Path $LogBE)) {
            New-Item -ItemType File -Path $LogBE -Force | Out-Null
        }
    }
}

function Log($msg) { Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $msg" }

function Kill-Existing {
    Log "--- Killing existing processes ---"
    $killed = 0
    foreach ($pidfile in @($PidFileBE, $PidFileFE)) {
        if (Test-Path $pidfile) {
            $procId = Get-Content $pidfile
            $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
            if ($proc) {
                Log "  Killing PID $procId ($($proc.ProcessName))..."
                Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
                $killed++
            } else {
                Log "  PID $procId already dead, removing stale pidfile"
            }
            Remove-Item $pidfile -Force
        }
    }
    foreach ($port in @($BackendPort, $FrontendPort)) {
        $conns = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
        foreach ($conn in $conns) {
            if ($conn.OwningProcess -gt 0) {
                $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
                Log "  Killing process on port $port — PID $($conn.OwningProcess) ($($proc.ProcessName))"
                Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
                $killed++
            }
        }
    }
    if ($killed -eq 0) { Log "  No existing processes found" }
    Log "--- Kill phase complete ---"
}

function Build-Frontend {
    Log "=== FRONTEND BUILD START ==="
    Set-Location "$RootDir\frontend"

    # Clear caches
    if (Test-Path "node_modules\.vite") {
        Log "  Clearing Vite cache (node_modules\.vite)..."
        Remove-Item "node_modules\.vite" -Recurse -Force
    }
    if (Test-Path "dist") {
        $oldFiles = Get-ChildItem "dist\assets\index-*.js" -ErrorAction SilentlyContinue
        Log "  Clearing dist/ (old bundle: $($oldFiles.Name))..."
        Remove-Item "dist" -Recurse -Force
    } else {
        Log "  No dist/ folder found (first build)"
    }

    # TypeScript check
    Log "  Running TypeScript check (npx tsc -b)..."
    & npx tsc -b
    if ($LASTEXITCODE -ne 0) {
        Log "❌ TypeScript check FAILED (exit code $LASTEXITCODE) — aborting."
        exit 1
    }
    Log "  ✅ TypeScript check passed"

    # Vite build
    Log "  Running Vite build..."
    & npx vite build
    if ($LASTEXITCODE -ne 0) {
        Log "❌ Vite build FAILED (exit code $LASTEXITCODE) — aborting."
        exit 1
    }

    $newFiles = Get-ChildItem "dist\assets\index-*.js" -ErrorAction SilentlyContinue
    $sizeKB = [math]::Round($newFiles.Length / 1024)
    Log "  ✅ Vite build succeeded — $($newFiles.Name) (${sizeKB}KB)"
    Log "=== FRONTEND BUILD COMPLETE ==="
}

function Start-App {
    Kill-Existing

    Log "=== STARTING APP (mode: $Mode) ==="

    Set-Location "$RootDir\backend"
    Log "  Starting backend (node server.js)..."
    $be = Start-Process -FilePath "node" -ArgumentList "server.js" `
        -RedirectStandardOutput $LogBE -RedirectStandardError "$LogBE.err" `
        -NoNewWindow -PassThru
    $be.Id | Out-File $PidFileBE -Encoding ascii
    Log "  Backend started — PID $($be.Id), log: $LogBE"

    if ($Mode -eq "dev") {
        Set-Location "$RootDir\frontend"
        Log "  Starting Vite dev server..."
        $fe = Start-Process -FilePath "npx" -ArgumentList "vite", "--host" `
            -RedirectStandardOutput $LogFE -RedirectStandardError "$LogFE.err" `
            -NoNewWindow -PassThru
        $fe.Id | Out-File $PidFileFE -Encoding ascii
        Log "  Frontend dev server started — PID $($fe.Id)"
        Write-Host ""
        Write-Host "  Backend:  https://localhost:$BackendPort"
        Write-Host "  Frontend: https://localhost:$FrontendPort  (dev + HMR)"
    } else {
        Write-Host ""
        Write-Host "  App: https://localhost:$BackendPort"
    }

    Log "=== APP RUNNING ==="
    Write-Host ""
    Write-Host "Tailing backend logs (Ctrl+C to stop)..."
    Write-Host ""
    Get-Content $LogBE -Wait
}

Build-Frontend
Start-App
