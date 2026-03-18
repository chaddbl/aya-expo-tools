$f = "C:\aya-expo-tools\config\beleza-astral.json"
$c = Get-Content $f -Raw

# cam-1: adicionar senha admin
$c = $c -replace '"id": "cam-1", "name": "C[^"]*mera 1", "ip": "192\.168\.0\.181", "model": "Intelbras iMD 3C Black", "user": "admin", "password": ""', '"id": "cam-1", "name": "Camara 1", "ip": "192.168.0.181", "model": "Intelbras iMD 3C Black", "user": "admin", "password": "admin"'

# cam-2: atualizar IP para 192.168.0.108 + senha admin
$c = $c -replace '"id": "cam-2", "name": "C[^"]*mera 2", "ip": "192\.168\.0\.31", "model": "Intelbras iMD 3C Black", "user": "admin", "password": ""', '"id": "cam-2", "name": "Camara 2", "ip": "192.168.0.108", "model": "Intelbras iMD 3C Black", "user": "admin", "password": "admin"'

Set-Content $f $c -NoNewline
Write-Host "Config atualizado"
Write-Host "cam-1: $(Select-String -Path $f -Pattern '0\.181')"
Write-Host "cam-2: $(Select-String -Path $f -Pattern '0\.108')"
