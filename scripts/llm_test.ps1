Param(
  [string]$Prompt = 'اختبر الرد'
)

$body = @{ prompt = $Prompt } | ConvertTo-Json -Compress
Invoke-RestMethod -Uri 'http://localhost:3000/llm-test' -Method Post -ContentType 'application/json; charset=utf-8' -Body $body | ConvertTo-Json -Depth 5 | Write-Output


