Add-Type -AssemblyName System.Drawing
$outDir = "C:\Users\Admin\AppData\Local\Temp\opencode\art"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$white = [System.Drawing.Color]::White
Get-ChildItem "C:\Users\Admin\Downloads\ron" -File -Filter *.png | ForEach-Object {
  $img = [System.Drawing.Bitmap]::FromFile($_.FullName)
  $s = 6
  $w = ($img.Width + 2) * $s
  $h = ($img.Height + 2) * $s
  $big = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($big)
  $g.Clear($white)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
  $g.DrawImage($img, $s, $s, $img.Width * $s, $img.Height * $s)
  $g.Dispose()
  $outName = $_.BaseName + "_6x.png"
  $big.Save((Join-Path $outDir $outName))
  $img.Dispose(); $big.Dispose()
}
Write-Output ("done: " + (Get-ChildItem $outDir).Count + " images")
