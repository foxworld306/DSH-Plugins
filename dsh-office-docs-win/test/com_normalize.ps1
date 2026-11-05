# Round-trip through the real applications: open what our toolkit produced, export a PDF, and
# report what the app itself thinks of the file. Opening is the strong signal - a package that is
# subtly broken fails here, not on a colleague's PC.
#
# Deliberately NOT used: SaveAs back to docx/xlsx/pptx. Unattended, Office can sit on the
# format-conversion dialog forever, and the shipped renderer never does it either (it exports PDF).
#
# Requirements: interactive desktop session, not run from inside the DSH sandbox.
# Progress is appended to a log so a hang is diagnosable instead of silent.
$ErrorActionPreference = 'Stop'
$ws = Join-Path $env:USERPROFILE 'OneDrive - SUEZ\Documents\Vibe_Coding\DeepSeek harness'
$src = Join-Path $ws '.office-docs-render\roundtrip-src'
$out = Join-Path $ws '.office-docs-render\comsuite'
$work = Join-Path $env:TEMP ('comnorm_' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $out, $work -Force | Out-Null
$log = Join-Path $out 'com_normalize.log'
function Say($m) { Add-Content -LiteralPath $log -Value ((Get-Date).ToString('HH:mm:ss') + '  ' + $m) -Encoding UTF8 }
Set-Content -LiteralPath $log -Value 'com_normalize start' -Encoding UTF8

# 1. A stale instance from an interrupted run holds Normal.dotm and makes every later COM call
#    HANG (not fail). Always start from a clean slate.
Get-Process -Name WINWORD, EXCEL, POWERPNT -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 600
Say 'zombies cleared'

# 2. Sources under OneDrive block the export even when the destination is %TEMP%. Stage a local copy.
foreach ($f in 'demo.docx', 'demo.xlsx', 'demo.pptx') {
  $from = Join-Path $src $f
  if (Test-Path $from) { Copy-Item $from (Join-Path $work $f) -Force }
}
Say ('staged: ' + (@(Get-ChildItem $work -File).Name -join ', '))

$fail = 0
function Fail($m) { $script:fail++; Say ('FAIL ' + $m); Write-Output ('  FAIL  ' + $m) }
function Ok($m) { Say ('ok   ' + $m); Write-Output ('  ok    ' + $m) }

# ------------------------------------------------------------------ Word
$word = $null; $doc = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $doc = $word.Documents.Open((Join-Path $work 'demo.docx'), $false, $true)
  $paras = $doc.Paragraphs.Count
  $tables = $doc.Tables.Count
  if ($paras -lt 1) { Fail 'word: opened but reports no paragraphs' }
  else { Ok ("word: opened paragraphs=$paras tables=$tables words=" + $doc.ComputeStatistics(0)) }
  # By-value SaveAs2 HANGS under PowerShell COM; [ref] is mandatory (qa_render.ps1 relies on this).
  [string]$pdfW = Join-Path $work 'word.pdf'
  $doc.SaveAs([ref]$pdfW, [ref]17)    # 17 = wdFormatPDF
  Ok ('word: exported pdf, pages=' + $doc.ComputeStatistics(2))
  $doc.Close(0); $doc = $null
} catch { Fail ('word: ' + $_.Exception.Message) }
finally { if ($doc) { try { $doc.Close(0) } catch {} }; if ($word) { try { $word.Quit() } catch {} } }

# ----------------------------------------------------------------- Excel
$excel = $null; $wb = $null
try {
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $wb = $excel.Workbooks.Open((Join-Path $work 'demo.xlsx'), 0, $true)
  $sheet = $wb.Worksheets.Item(1)
  $b5 = $sheet.Range('B5').Text
  if ($sheet.Name.Length -lt 1) { Fail 'excel: sheet has no name' }
  else { Ok ("excel: opened sheets=" + $wb.Worksheets.Count + ' name=' + $sheet.Name + ' used=' + $sheet.UsedRange.Address() + ' B5=' + $b5) }
  $sheet.ExportAsFixedFormat(0, (Join-Path $work 'excel.pdf'))    # 0 = xlTypePDF
  Ok 'excel: exported pdf'
  $wb.Close($false); $wb = $null
} catch { Fail ('excel: ' + $_.Exception.Message) }
finally { if ($wb) { try { $wb.Close($false) } catch {} }; if ($excel) { try { $excel.Quit() } catch {} } }

# ------------------------------------------------------------ PowerPoint
$ppt = $null; $pres = $null
try {
  $ppt = New-Object -ComObject PowerPoint.Application
  $pres = $ppt.Presentations.Open((Join-Path $work 'demo.pptx'), $true, $false, $false)
  $slides = $pres.Slides.Count
  $shapes = $pres.Slides.Item(1).Shapes.Count
  if ($slides -lt 1 -or $shapes -lt 1) { Fail ("ppt: opened but slides=$slides shapes=$shapes") }
  else { Ok ("ppt: opened slides=$slides shapes1=$shapes widthIn=" + [math]::Round($pres.PageSetup.SlideWidth / 72, 2)) }
  [string]$pdfP = Join-Path $work 'ppt.pdf'
  $pres.SaveAs([ref]$pdfP, [ref]32)     # 32 = ppSaveAsPDF
  Ok 'ppt: exported pdf'
  $pres.Close(); $pres = $null
} catch { Fail ('ppt: ' + $_.Exception.Message) }
finally { if ($pres) { try { $pres.Close() } catch {} }; if ($ppt) { try { $ppt.Quit() } catch {} } }

Get-Process -Name WINWORD, EXCEL, POWERPNT -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# Every export must be a real PDF, not just a file with a plausible name.
foreach ($name in 'word.pdf', 'excel.pdf', 'ppt.pdf') {
  $f = Join-Path $work $name
  if (-not (Test-Path $f)) { Fail ("missing export: $name"); continue }
  $bytes = [IO.File]::ReadAllBytes($f)
  $head = if ($bytes.Length -ge 5) { [Text.Encoding]::ASCII.GetString($bytes, 0, 5) } else { '' }
  if ($head -ne '%PDF-') { Fail ("{0}: header '{1}' is not a PDF" -f $name, $head) }
  else { Ok ("{0}: {1:N0} bytes, real PDF" -f $name, $bytes.Length) }
  Copy-Item $f (Join-Path $out $name) -Force
}

Say ('done, failures=' + $fail)
Write-Output ('com_normalize: ' + $(if ($fail -eq 0) { 'ALL GREEN' } else { "$fail FAILED" }))
