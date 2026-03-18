$f = "C:\aya-expo-tools\config\beleza-astral.json"
$c = Get-Content $f -Raw
$c = $c -replace '"ip": "192.168.0.30", "model": "Intelbras VIP 1130 B"', '"ip": "192.168.0.181", "model": "Intelbras iMD 3C Black"'
$c = $c -replace '"ip": "192.168.0.31", "model": "Intelbras VIP 1130 B"', '"ip": "192.168.0.31", "model": "Intelbras iMD 3C Black"'
$c = $c -replace '"ip": "192.168.0.32", "model": "Intelbras VIP 1130 B"', '"ip": "192.168.0.32", "model": "Intelbras iMD 3C Black"'
$c = $c -replace '"ip": "192.168.0.33", "model": "Intelbras VIP 1130 B"', '"ip": "192.168.0.33", "model": "Intelbras iMD 3C Black"'
Set-Content $f $c -NoNewline
Write-Host "OK: $(Select-String -Path $f -Pattern '192.168.0.181')"
