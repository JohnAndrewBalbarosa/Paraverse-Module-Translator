/**
 * Convert PPTX files to PDF using Microsoft PowerPoint via COM automation.
 *
 * Designed to be batch-friendly: opens PowerPoint once, converts many files,
 * closes once. Falls back to LibreOffice headless if PowerPoint is unavailable.
 *
 * The conversion runs in a child PowerShell process so PowerPoint's COM
 * lifecycle is contained — no chance of a stuck process leaking into Node.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Convert a list of pptx files to pdf files via PowerPoint COM.
 *
 * @param {Array<{input: string, output: string}>} jobs
 * @param {{log?: (msg: string) => void}} [opts]
 * @returns {{ok: number, failed: number, errors: string[]}}
 */
function convertWithPowerPoint(jobs, opts = {}) {
  const log = opts.log || (() => {});
  if (!jobs.length) return { ok: 0, failed: 0, errors: [] };

  // Build a PowerShell script that opens PowerPoint once, converts every
  // file, then quits cleanly. Output is one JSON-ish line per file so we
  // can parse success/failure.
  const tmpListFile = path.join(os.tmpdir(), `pptx-to-pdf-${Date.now()}.json`);
  fs.writeFileSync(tmpListFile, JSON.stringify(jobs), "utf8");

  const psScript = `
$ErrorActionPreference = 'Stop'
$jobs = Get-Content -Raw -LiteralPath '${tmpListFile.replace(/'/g, "''")}' | ConvertFrom-Json
$ppt = New-Object -ComObject PowerPoint.Application
$ppt.DisplayAlerts = 1  # ppAlertsNone
$readonly = [Microsoft.Office.Core.MsoTriState]::msoCTrue
$nottitled = [Microsoft.Office.Core.MsoTriState]::msoFalse
$nowindow = [Microsoft.Office.Core.MsoTriState]::msoFalse
foreach ($j in $jobs) {
  try {
    $pres = $ppt.Presentations.Open($j.input, $readonly, $nottitled, $nowindow)
    $pres.SaveAs($j.output, 32) | Out-Null  # 32 = ppSaveAsPDF
    $pres.Close()
    Write-Host "OK $($j.output)"
  } catch {
    Write-Host "FAIL $($j.input) :: $($_.Exception.Message)"
  }
}
try { $ppt.Quit() } catch {}
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($ppt) | Out-Null
`;

  log(`[pptxToPdf] Spawning PowerPoint COM to convert ${jobs.length} file(s)...`);
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", psScript],
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }
  );

  try { fs.unlinkSync(tmpListFile); } catch { /* ignore */ }

  const lines = (result.stdout || "").split(/\r?\n/).filter(Boolean);
  const errors = [];
  let ok = 0;
  let failed = 0;
  for (const line of lines) {
    if (line.startsWith("OK ")) {
      ok += 1;
    } else if (line.startsWith("FAIL ")) {
      failed += 1;
      errors.push(line);
    }
  }
  if (result.status !== 0 && ok === 0) {
    errors.push(`PowerShell exited ${result.status}: ${result.stderr || "(no stderr)"}`);
  }
  return { ok, failed, errors };
}

/**
 * Convert via LibreOffice headless. Used as a fallback when PowerPoint COM
 * isn't available (e.g., Linux/macOS dev environments).
 */
function convertWithLibreOffice(jobs, opts = {}) {
  const log = opts.log || (() => {});
  const candidates = [
    "soffice",
    "C:/Program Files/LibreOffice/program/soffice.exe",
    "/usr/bin/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice"
  ];
  let soffice = "";
  for (const c of candidates) {
    const probe = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) { soffice = c; break; }
  }
  if (!soffice) {
    return { ok: 0, failed: jobs.length, errors: ["LibreOffice not found"] };
  }
  let ok = 0; let failed = 0; const errors = [];
  for (const j of jobs) {
    const outDir = path.dirname(j.output);
    const result = spawnSync(soffice, [
      "--headless", "--convert-to", "pdf",
      "--outdir", outDir, j.input
    ], { encoding: "utf8" });
    if (result.status === 0 && fs.existsSync(j.output)) {
      ok += 1;
      log(`[pptxToPdf] OK ${path.basename(j.output)}`);
    } else {
      failed += 1;
      errors.push(`FAIL ${j.input}: ${result.stderr || result.stdout}`);
    }
  }
  return { ok, failed, errors };
}

function detectConverter() {
  if (process.platform === "win32") {
    // Cheap probe — try a tiny COM instantiation
    const probe = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
       "try { $p = New-Object -ComObject PowerPoint.Application; $p.Quit(); 'POWERPOINT' } catch { 'NONE' }"],
      { encoding: "utf8" }
    );
    if ((probe.stdout || "").includes("POWERPOINT")) return "powerpoint";
  }
  // LibreOffice fallback
  const candidates = ["soffice", "C:/Program Files/LibreOffice/program/soffice.exe"];
  for (const c of candidates) {
    const probe = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return "libreoffice";
  }
  return "none";
}

async function convert(jobs, opts = {}) {
  const log = opts.log || (() => {});
  const preferred = opts.converter || detectConverter();
  log(`[pptxToPdf] Using converter: ${preferred}`);
  if (preferred === "powerpoint") return convertWithPowerPoint(jobs, opts);
  if (preferred === "libreoffice") return convertWithLibreOffice(jobs, opts);
  return {
    ok: 0,
    failed: jobs.length,
    errors: ["No PPTX→PDF converter available. Install LibreOffice or Microsoft PowerPoint."]
  };
}

module.exports = { convert, detectConverter };
