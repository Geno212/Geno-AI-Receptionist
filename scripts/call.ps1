Param(
  [Parameter(Mandatory=$true)]
  [string]$To,
  [int]$Port = 3001
)

$body = @{ to = $To } | ConvertTo-Json -Compress
$url = "http://localhost:$Port/call"
Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json; charset=utf-8' -Body $body | ConvertTo-Json -Depth 5 | Write-Output

