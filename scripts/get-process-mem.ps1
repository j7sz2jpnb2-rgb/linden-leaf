param([int]$targetPid)
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, WorkingSetSize
$pids = [System.Collections.Generic.HashSet[int]]::new()
$queue = [System.Collections.Generic.Queue[int]]::new()
$null = $pids.Add($targetPid)
$queue.Enqueue($targetPid)
while ($queue.Count -gt 0) {
    $curr = $queue.Dequeue()
    $children = $all | Where-Object { $_.ParentProcessId -eq $curr }
    foreach ($c in $children) {
        if ($pids.Add($c.ProcessId)) {
            $queue.Enqueue($c.ProcessId)
        }
    }
}
$target = $all | Where-Object { $pids.Contains($_.ProcessId) }
$mainProc = $target | Where-Object { $_.ProcessId -eq $targetPid }
$subProcs = $target | Where-Object { $_.ProcessId -ne $targetPid }
$mainBytes = ($mainProc.WorkingSetSize | Measure-Object -Sum).Sum
$subBytes = ($subProcs.WorkingSetSize | Measure-Object -Sum).Sum
$totalBytes = ($target.WorkingSetSize | Measure-Object -Sum).Sum
$mainMB = [Math]::Round(($mainBytes -as [double]) / 1MB, 2)
$subMB = [Math]::Round(($subBytes -as [double]) / 1MB, 2)
$totalMB = [Math]::Round(($totalBytes -as [double]) / 1MB, 2)
$procList = @($target | ForEach-Object { "$($_.Name) (PID $($_.ProcessId)): $([Math]::Round($_.WorkingSetSize/1MB, 1))MB" })
@{ mainMB = $mainMB; webview2MB = $subMB; totalMB = $totalMB; procs = $procList } | ConvertTo-Json -Compress
