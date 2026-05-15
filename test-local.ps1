$baseUrl = "http://localhost:3000/delivery"

$tests = @(
  @{ address = "Ижевск, Советская, 2, 1, 3, 8"; title = "Ижевск, Советская 2" },
  @{ address = "Ягул, Солнечная, 4"; title = "Ягул, Солнечная 4" },
  @{ address = "Удмуртская Республика, Завьяловский район, Ягул, Солнечная, 4"; title = "Ягул полный адрес" },
  @{ address = "Удмуртская Республика, Завьяловский район, Первомайский, Полевая, 10Б"; title = "Первомайский, Полевая 10Б" },
  @{ address = "Москва, Тверская 1"; title = "Москва вне зоны" }
)

foreach ($test in $tests) {
  Write-Host "`n=== $($test.title) ===" -ForegroundColor Cyan
  $json = (@{
    user_id = "test"
    address = $test.address
    phone = "+79000000000"
  } | ConvertTo-Json -Compress)

  $body = [System.Text.Encoding]::UTF8.GetBytes($json)

  try {
    Invoke-RestMethod -Method Post `
      -Uri $baseUrl `
      -ContentType "application/json; charset=utf-8" `
      -Body $body | Format-List
  } catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
  }
}
