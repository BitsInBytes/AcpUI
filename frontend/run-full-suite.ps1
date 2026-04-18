$job = Start-Job -ScriptBlock { param($d) Set-Location $d; cmd.exe /c "npx vitest run 2>&1" } -ArgumentList "."
$done = Wait-Job $job -Timeout 120
if ($done) { Receive-Job $job | Select-String '(Test Files|Tests )' } else { Stop-Job $job; Write-Host 'HUNG' }
Remove-Job $job -Force
