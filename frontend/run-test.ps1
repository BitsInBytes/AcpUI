param([string]$TestFile)
$job = Start-Job -ScriptBlock {
    param($tf)
    cmd.exe /c "npx vitest run $tf 2>&1"
} -ArgumentList $TestFile
$done = Wait-Job $job -Timeout 60
if ($done) {
    Receive-Job $job | Select-String '(Test Files|Tests )'
} else {
    Stop-Job $job
    Write-Host 'HUNG'
}
Remove-Job $job -Force
