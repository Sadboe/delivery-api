$tests = @(
  @{ address = "Москва, Тверская 1"; expected = "out_of_zone" },
  @{ address = "Ижевск, Советская, 2, 1, 3, 8"; expected = "ok" }
)

foreach ($test in $tests) {
  $json = (@{
    user_id = "test"
    address = $test.address
    phone = "+79000000000"
  } | ConvertTo-Json -Compress)

  $body = [System.Text.Encoding]::UTF8.GetBytes($json)

  Write-Host "Testing: $($test.address)"

  try {
    Invoke-RestMethod -Method Post `
      -Uri "http://localhost:3000/delivery" `
      -ContentType "application/json; charset=utf-8" `
      -Body $body
  } catch {
    Write-Host $_.Exception.Message
    if ($_.ErrorDetails.Message) {
      Write-Host $_.ErrorDetails.Message
    }
  }

  Write-Host ""
}
