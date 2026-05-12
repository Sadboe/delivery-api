Write-Host "Installing dependencies..." -ForegroundColor Cyan
npm.cmd install

Write-Host "Starting Delivery API on http://localhost:3000" -ForegroundColor Green
npm.cmd start
