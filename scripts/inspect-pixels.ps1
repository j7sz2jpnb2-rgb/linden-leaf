Add-Type -AssemblyName System.Drawing
$feedbackDir = (Get-ChildItem 'C:\Users\YONGHU\Desktop' -Directory | Where-Object { $_.Name -like '*反馈*' }).FullName
$file = (Get-ChildItem -LiteralPath $feedbackDir -Filter '*160*').FullName
Write-Host "File: $file"
$bmp = [System.Drawing.Bitmap]::FromFile($file)
Write-Host "Width: $($bmp.Width), Height: $($bmp.Height)"

Write-Host "--- Scanning X at y = 1800 ---"
for ($x = 0; $x -lt $bmp.Width; $x += 100) {
    $c = $bmp.GetPixel($x, 1800)
    Write-Host "x=${x} R=$($c.R), G=$($c.G), B=$($c.B)"
}

Write-Host "--- Scanning X at y = 2100 ---"
for ($x = 0; $x -lt $bmp.Width; $x += 100) {
    $c = $bmp.GetPixel($x, 2100)
    Write-Host "x=${x} R=$($c.R), G=$($c.G), B=$($c.B)"
}

$bmp.Dispose()
