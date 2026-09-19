# Export Windows Root CA store (includes the corporate TCB CA injected by the
# SSL-intercepting proxy) to a PEM bundle, so Node/Prisma can verify TLS through
# the proxy WITHOUT disabling certificate checking.
$ErrorActionPreference = 'Stop'
$out = Join-Path $PSScriptRoot '..\corp-ca.pem'
if (Test-Path $out) { Remove-Item $out }
$count = 0
foreach ($store in @('Root','CA')) {
  Get-ChildItem "Cert:\LocalMachine\$store" | ForEach-Object {
    $b = [Convert]::ToBase64String($_.RawData, 'InsertLineBreaks')
    Add-Content $out '-----BEGIN CERTIFICATE-----'
    Add-Content $out $b
    Add-Content $out '-----END CERTIFICATE-----'
    $script:count++
  }
}
Write-Output "Exported $count certificates to $out"
