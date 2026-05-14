# ACP UI start/restart script (Native)
# Production builds the frontend first; dev mode runs backend watch mode plus Vite HMR.
# Usage: .\run.ps1        (production: backend serves built frontend)
#        .\run.ps1 dev    (dev mode: backend hot reload + Vite HMR)

param([string]$Mode = "prod")

$Mode = $Mode.ToLowerInvariant()
if ($Mode -notin @("prod", "dev")) {
    Write-Host "Mode must be 'prod' or 'dev'."
    exit 1
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir
$PidFileBE = "$env:TEMP\acpui-backend.pid"
$PidFileFE = "$env:TEMP\acpui-frontend.pid"
$LogBE = "$env:TEMP\acpui-backend.log"
$LogFE = "$env:TEMP\acpui-frontend.log"
$LogBEUsesAppLogger = $false

# Read ports from .env
$envFile = Get-Content "$RootDir\.env" -ErrorAction SilentlyContinue
$BackendPort = 3005
$FrontendPort = 5173
foreach ($line in $envFile) {
    if ($line -match '^BACKEND_PORT=(\d+)') { $BackendPort = [int]$Matches[1] }
    if ($line -match '^FRONTEND_PORT=(\d+)') { $FrontendPort = [int]$Matches[1] }
    if ($line -match '^LOG_FILE_PATH=(.+)') { 
        $LogBE = $Matches[1].Trim()
        $LogBEUsesAppLogger = $true
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

function Reset-LogFile($path) {
    if (-not $path) { return }
    $dir = Split-Path -Parent $path
    if ($dir -and -not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    if (Test-Path $path) {
        Clear-Content -Path $path -ErrorAction SilentlyContinue
    } else {
        New-Item -ItemType File -Path $path -Force | Out-Null
    }
}

function Resolve-StartProcessCommand($name) {
    $candidates = if ($env:OS -eq "Windows_NT") { @("$name.cmd", "$name.exe", $name) } else { @($name) }
    foreach ($candidate in $candidates) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) { return $command.Source }
    }
    throw "Required command '$name' was not found on PATH."
}

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
    $NpmCommand = Resolve-StartProcessCommand "npm"
    $BackendNpmScript = if ($Mode -eq "dev") { "dev" } else { "start" }
    $BackendModeLabel = if ($Mode -eq "dev") { "backend watch mode" } else { "production backend" }
    Log "  Starting $BackendModeLabel (npm run $BackendNpmScript)..."
    $BackendStdoutLog = if ($LogBEUsesAppLogger) { "$LogBE.stdout" } else { $LogBE }
    $BackendStderrLog = if ($LogBEUsesAppLogger) { "$LogBE.stderr" } else { "$LogBE.err" }
    if ($LogBEUsesAppLogger) {
        Reset-LogFile $LogBE
    }
    Reset-LogFile $BackendStdoutLog
    Reset-LogFile $BackendStderrLog
    $be = Start-Process -FilePath $NpmCommand -ArgumentList "run", $BackendNpmScript `
        -RedirectStandardOutput $BackendStdoutLog -RedirectStandardError $BackendStderrLog `
        -NoNewWindow -PassThru
    $be.Id | Out-File $PidFileBE -Encoding ascii
    if ($LogBEUsesAppLogger) {
        Log "  Backend started — PID $($be.Id), app log: $LogBE, stdout: $BackendStdoutLog"
    } else {
        Log "  Backend started — PID $($be.Id), log: $LogBE"
    }

    if ($Mode -eq "dev") {
        Set-Location "$RootDir\frontend"
        Log "  Starting Vite dev server (npm run dev, port $FrontendPort)..."
        Reset-LogFile $LogFE
        Reset-LogFile "$LogFE.err"
        $fe = Start-Process -FilePath $NpmCommand -ArgumentList "run", "dev", "--", "--port", $FrontendPort `
            -RedirectStandardOutput $LogFE -RedirectStandardError "$LogFE.err" `
            -NoNewWindow -PassThru
        $fe.Id | Out-File $PidFileFE -Encoding ascii
        Log "  Frontend dev server started — PID $($fe.Id)"
        Write-Host ""
        Write-Host "  Backend:  https://localhost:$BackendPort  (dev + watch)"
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

if ($Mode -eq "dev") {
    Log "=== DEV MODE: SKIPPING PRODUCTION FRONTEND BUILD ==="
} else {
    Build-Frontend
}
Start-App
