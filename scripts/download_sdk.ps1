$url = "https://sdk.twilio.com/js/voice/releases/2.11.1/twilio.min.js"
$output = "public/twilio.min.js"
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $output -UseBasicParsing
    Write-Host "Download success"
} catch {
    Write-Error $_.Exception.Message
}
