# qa_render.ps1 <file> <page> <out> [-NoWindow] [-TimeoutSec N]
# pptx -> PNG (PowerPoint COM). docx -> PDF (Word COM). xlsx -> PDF (Excel COM).
# The source is copied into %TEMP% first (COM cannot open sync-locked OneDrive paths).
#
# 2026-10-29 fixes:
#   - temp copy keeps the ORIGINAL extension (GetRandomFileName() is 8.3 form and
#     produced qa_xxxxxxxx.yyy -> PowerPoint "could not open" / flaky format sniffing)
#   - headless zombie Office processes (no main window) are killed BEFORE the first
#     attempt and again after a failure: they are the #1 cause of RPC 0x800706BE,
#     Shapes.AddPicture E_FAIL and "could not open"
#   - pptx: windowed-open fallback (WithWindow=$true) when headless open fails; a
#     non-interactive session can fail to load image parts with WithWindow=$false even
#     for valid decks. Headless stays FIRST, so interactive sessions see no window
#     unless the fallback is needed. -NoWindow disables the fallback (pure CI hosts).
#     ([switch] because [bool] params cannot be bound through `powershell -File` in 5.1)
#   - absolute paths (COM ignores the caller's CWD), pptx output must be *.png,
#     destination directory auto-created, temp copy always deleted
#
# 2026-10-30: WATCHDOG. A hung Word/Excel COM call blocks forever (observed: 15+ min
#   with WINWORD alive but never finishing). The render now runs in a supervised child
#   process: on timeout the child and the headless Office leftovers are killed and a
#   precise error is raised, so callers never hang. Auto budget: pptx 180 s,
#   docx/xlsx 600 s (a 36-page CJK docx legitimately takes ~45 s).
param(
  [string]$File = $env:QA_FILE,
  [string]$Page = '1',
  [string]$Out = $env:QA_OUT,
  [switch]$NoWindow,
  [int]$TimeoutSec = -1,      # -1 auto by type, 0 = no watchdog, >0 = seconds
  [switch]$Worker             # internal: set when re-invoked as the supervised child
)
$ErrorActionPreference = 'Stop'

# the supervised child receives its paths through env vars (quoting-safe)
if ($Worker) {
  if ($env:QA_PAGE) { $Page = $env:QA_PAGE }
  if ($env:QA_NOWINDOW -eq '1') { $NoWindow = $true }
}
if (-not $File -or -not $Out) {
  throw 'usage: qa_render.ps1 <file> <page> <out> [-NoWindow] [-TimeoutSec N]'
}

# 2026-10-29: resolve to absolute paths — Office COM SaveAs/Export does NOT resolve
# relative paths against the caller's working directory (the file silently lands in
# the COM server's own CWD; the script prints "rendered:" while the file is missing
# from where you expected it).
$File = [System.IO.Path]::GetFullPath($File)
$Out = [System.IO.Path]::GetFullPath($Out)

function Kill-ZombieOffice {
  # Headless COM instances have no main window; the user's visible Office sessions do.
  Get-Process POWERPNT, WINWORD, EXCEL -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -eq 0 } |
    Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
}

$ext = [System.IO.Path]::GetExtension($File).ToLower()
if ($ext -notin @('.pptx', '.docx', '.xlsx')) { throw "unsupported extension: $ext" }
# 2026-10-29: for pptx the output is a PNG — a .pdf (or any other) name would silently
# receive PNG bytes. Fail fast with a clear message instead.
if ($ext -eq '.pptx' -and $Out.ToLower().TrimEnd('\') -notlike '*.png') {
  throw "pptx output must end in .png (got '$Out'); pptx renders to PNG, only docx/xlsx render to PDF"
}
# 2026-10-30: [string] cast is REQUIRED for COM [ref] arguments. A variable holding a
# PSObject-wrapped string makes Word fail with 'Cannot convert the "..." value of type
# "psobject" to type "Object"' (reproduced 2026-10-30 in PS 5.1 via -File). Casting is
# free and makes the call deterministic. By-value SaveAs2 is NOT a fallback: it hangs.
[string]$dest = if ($ext -eq '.pptx') { $Out } else { (($Out -replace '\.[^.]+$', '') + '.pdf') }
# 2026-10-29: COM SaveAs/Export fail with an opaque error when the destination
# directory does not exist — create it up front.
$destDir = Split-Path -Parent $dest
if ($destDir -and -not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }

# 2026-10-30: the temp copy is staged HERE (not in the worker) so the supervisor also
# knows its name — a timed-out worker is killed before it can clean up after itself,
# which used to leave one qa_*.docx behind per timeout. The worker reuses the path the
# supervisor passes in (QA_TMP) instead of staging a second copy.
$hasStaged = $Worker -and $env:QA_TMP -and (Test-Path $env:QA_TMP)
$tmp = if ($hasStaged) { $env:QA_TMP } else { Join-Path $env:TEMP ('qa_' + [System.Guid]::NewGuid().ToString('N') + $ext) }
if (-not $hasStaged) { Copy-Item $File $tmp -Force }

# ---------------------------------------------------------------------------
# 2026-10-30 watchdog: supervise a child process so a hung COM call cannot hang us.
# Parameters travel through env vars — passing paths with spaces/commas through
# Start-Process -ArgumentList is a quoting minefield.
# ---------------------------------------------------------------------------
if (-not $Worker) {
  $budget = $TimeoutSec
  if ($budget -lt 0) { $budget = if ($ext -eq '.pptx') { 180 } else { 600 } }
  if ($budget -gt 0) {
    $env:QA_FILE = $File
    $env:QA_PAGE = $Page
    $env:QA_OUT = $Out
    $env:QA_TMP = $tmp
    $env:QA_NOWINDOW = if ($NoWindow) { '1' } else { '0' }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Worker'
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit($budget * 1000)) {
      try { $proc.Kill() } catch {}
      Kill-ZombieOffice
      Remove-Item $tmp -Force -ErrorAction SilentlyContinue
      throw ("render timed out after {0}s ({1}). The COM call was hung, not the file: " -f $budget, $ext) +
            "headless Office leftovers have been killed. Retry once; a 36-page CJK docx legitimately needs ~45s. " +
            "Do not conclude the file is corrupt. If it repeats, pass a bigger -TimeoutSec or render from an interactive desktop session."
    }
    $wout = $outTask.Result
    $werr = $errTask.Result
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    if ($wout) { Write-Output $wout.TrimEnd() }
    if ($werr) { Write-Warning $werr.TrimEnd() }
    exit $proc.ExitCode
  }
}

# ---------------------------------------------------------------------------
# worker body (also runs directly when the watchdog is disabled with -TimeoutSec 0)
# ---------------------------------------------------------------------------
$NoWindow = if ($env:QA_NOWINDOW -eq '1') { $true } else { $NoWindow }

# 2026-10-29: clean headless Office leftovers BEFORE the first attempt too. They used to
# be killed only after a failure, which guaranteed a wasted first attempt (and a scary
# warning) on any machine that had crashed a COM job earlier. Visible windows untouched.
Kill-ZombieOffice

$failed = $true
$abort = $false      # non-retryable (bad page number) -> skip the retry, report precisely
$fatal = ''
for ($attempt = 1; $attempt -le 2 -and $failed; $attempt++) {
  $failed = $false
$lastError = ""
$pages = 0
  switch ($ext) {
    '.pptx' {
      $app = New-Object -ComObject PowerPoint.Application
      try {
        try {
          $pres = $app.Presentations.Open($tmp, $true, $false, $false)   # headless first (ReadOnly, no window)
        } catch {
          if ($NoWindow) { throw }
          Write-Warning "headless open failed (non-interactive session + image parts?); retrying with window: $($_.Exception.Message)"
          $pres = $app.Presentations.Open($tmp, $true, $false, $true)   # fallback: WithWindow=$true
        }
        # 2026-10-29: a bad page number is not a transient COM failure — retrying it
        # twice produced a misleading "Office installed? file corrupt?" message.
        $count = $pres.Slides.Count
        if ([int]$Page -lt 1 -or [int]$Page -gt $count) {
          $pres.Close()
          $abort = $true
          throw ("page {0} out of range: this deck has {1} slide(s)" -f $Page, $count)
        }
        $slideInfo = "slide {0} of {1}" -f $Page, $count
        try { $pres.Slides.Item([int]$Page).Export($dest, 'PNG', 1600, 900) }
        finally { $pres.Close() }
      } catch {
        $failed = $true
        if ($abort) { $fatal = $_.Exception.Message } else {
          $lastError = $_.Exception.Message
        Write-Warning ("attempt {0} failed: {1}" -f $attempt, $lastError)
        }
      } finally {
        try { $app.Quit() } catch {}
        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null
      }
    }
    '.docx' {
      $app = New-Object -ComObject Word.Application
      try {
        $app.Visible = $false
        $doc = $app.Documents.Open($tmp, $false, $true)                # ReadOnly
        # 2026-11-04: report the page count while the document is open. Counting "/Type /Page" in
        # the PDF is only a heuristic; Word knows the real number.
        try { $doc.SaveAs([ref]$dest, [ref]17); $pages = [int]$doc.ComputeStatistics(2) }
        finally { $doc.Close($false) }   # 17 = wdFormatPDF, 2 = wdStatisticPages
      } catch {
        $failed = $true
        $lastError = $_.Exception.Message
        Write-Warning ("attempt {0} failed: {1}" -f $attempt, $lastError)
      } finally {
        try { $app.Quit() } catch {}
        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null
      }
    }
    '.xlsx' {
      $app = New-Object -ComObject Excel.Application
      try {
        $app.Visible = $false
        $app.DisplayAlerts = $false
        $wb = $app.Workbooks.Open($tmp)
        # 2026-11-04: SaveAs($dest, 52) was WRONG - 52 is xlOpenXMLWorkbookMacroEnabled, so the
        # "PDF" was really an .xlsm zip renamed .pdf. ExportAsFixedFormat(0 = xlTypePDF) is the
        # documented export path and cannot fall back to a workbook format.
        try {
          $wb.ExportAsFixedFormat(0, $dest)
          # print layout page count; needs a printer driver, so never let it fail the render
          try { foreach ($sh in $wb.Worksheets) { $pages += [int]$sh.PageSetup.Pages.Count } } catch { $pages = 0 }
        } finally { $wb.Close($false) }
      } catch {
        $failed = $true
        $lastError = $_.Exception.Message
        Write-Warning ("attempt {0} failed: {1}" -f $attempt, $lastError)
      } finally {
        try { $app.Quit() } catch {}
        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null
      }
    }
  }
  if ($failed -and -not $abort) { Kill-ZombieOffice }
  if ($abort) { break }
}
# 2026-10-29: the temp copy was only removed on success — failed runs leaked one per
# attempt into %TEMP%. Always clean it up, then report.
Remove-Item $tmp -Force -ErrorAction SilentlyContinue
if ($abort) { throw $fatal }
if ($failed) {
  $detail = if ($lastError) { ": " + $lastError } else { "" }
  throw ("render failed after 2 attempts{0}. Check: Office installed? file corrupt or invalid (run office_docs_check)? runs from an interactive desktop session?" -f $detail)
}
# 2026-11-04: never report success on the strength of the file's existence alone. Check the magic
# bytes: a mislabelled or truncated export must fail loudly here, not in the user's email.
if (-not (Test-Path -LiteralPath $dest)) { throw "renderer produced no file: $dest" }
$bytes = [System.IO.File]::ReadAllBytes($dest)
$head = ''
if ($bytes.Length -ge 5) { $head = [System.Text.Encoding]::ASCII.GetString($bytes, 0, 5) }
if ($ext -eq '.pptx') {
  $isPng = ($bytes.Length -ge 8 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47)
  if (-not $isPng) { throw ("renderer produced a non-PNG file ($dest, first bytes '{0}')" -f $head) }
  if ($bytes.Length -lt 2048) { throw ("renderer produced a suspiciously small PNG ({0} bytes): $dest" -f $bytes.Length) }
} else {
  if ($head -ne '%PDF-') { throw ("renderer produced a non-PDF file: $dest starts with '{0}' (expected '%PDF-')" -f $head) }
  if ($bytes.Length -lt 512) { throw ("renderer produced a suspiciously small PDF ({0} bytes): $dest" -f $bytes.Length) }
}
$pageNote = if ($slideInfo) { ", $slideInfo" } elseif ($pages -gt 0) { ", pages $pages" } else { "" }
Write-Output ("rendered: {0} ({1} bytes{2}, magic ok)" -f $dest, $bytes.Length, $pageNote)
