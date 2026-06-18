# ============================================================
#  HomeMedia bootstrap (Windows).
#  Ensures Node.js and ffmpeg are available. If either is
#  missing from PATH, downloads a portable copy into .runtime\
#  (no admin rights, nothing installed system-wide) and adds it
#  to PATH for this session only.
#
#  Called by start-homemedia.bat. Prints the PATH additions on
#  stdout (one per line) so the .bat can pick them up.
# ============================================================

$ErrorActionPreference = 'Stop'

# Progress/status messages must go to STDERR, because the calling .bat captures
# this script's STDOUT with `for /f` to read the "PATHADD=" lines. Anything on
# stdout that isn't a PATHADD line would be swallowed and never shown, making a
# long download look like a frozen window. Stderr passes straight through.
function Status($msg) { [Console]::Error.WriteLine($msg) }

# Pinned versions. Bump these to update the portable runtimes.
$NodeVersion = '22.23.0'                      # Node 22 LTS (undici 8 needs >=22.19)
$MinNodeMajor = 22                            # minimum acceptable system Node
$MinNodeMinor = 19
$NodeArch    = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
$RepoRoot    = Split-Path -Parent $PSScriptRoot
$RuntimeDir  = Join-Path $RepoRoot '.runtime'
$PathAdds    = @()

function Have($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# Is the Node currently on PATH new enough? A too-old Node (e.g. 20.x) will
# crash at startup because undici 8 uses APIs added in Node 22.19, so we treat
# an outdated system Node the same as a missing one and fetch the portable copy.
function NodeIsRecentEnough {
  if (-not (Have 'node')) { return $false }
  try { $v = (& node --version) -replace '^v','' } catch { return $false }
  $parts = $v.Split('.')
  if ($parts.Count -lt 2) { return $false }
  $maj = [int]$parts[0]; $min = [int]$parts[1]
  if ($maj -gt $MinNodeMajor) { return $true }
  if ($maj -eq $MinNodeMajor -and $min -ge $MinNodeMinor) { return $true }
  Status "[setup] Found Node v$v, but HomeMedia needs v$MinNodeMajor.$MinNodeMinor or newer."
  return $false
}

# Write a status line that overwrites itself in place (carriage return, no
# newline) so the download percentage animates on one line instead of
# scrolling. Goes to stderr like everything else here.
function StatusInline($msg) { [Console]::Error.Write("`r$msg") }

# Download a file while showing a live percentage / size on one line. We stream
# the bytes ourselves (rather than Invoke-WebRequest) so we can print real
# progress to stderr — this is the visible reassurance that nothing is frozen.
function Download($url, $dest, $label) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Status "  downloading $label ..."
  Status "  $url"

  $req  = [Net.HttpWebRequest]::Create($url)
  $req.UserAgent = 'HomeMedia-setup'
  $resp = $req.GetResponse()
  $total = [int64]$resp.ContentLength          # -1 if the server won't say
  $totalMB = if ($total -gt 0) { [math]::Round($total / 1MB, 1) } else { 0 }

  $in  = $resp.GetResponseStream()
  $out = [IO.File]::Create($dest)
  try {
    $buffer = New-Object byte[] 1048576         # 1 MB chunks
    $read = 0; $sum = 0; $lastShown = -1
    while (($read = $in.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $out.Write($buffer, 0, $read)
      $sum += $read
      $mb = [math]::Round($sum / 1MB, 1)
      if ($total -gt 0) {
        $pct = [int](($sum * 100) / $total)
        if ($pct -ne $lastShown) {              # only redraw when it changes
          $bars = [int]($pct / 5)
          $bar  = ('#' * $bars).PadRight(20, '.')
          StatusInline ("  [{0}] {1,3}%  ({2} / {3} MB)   " -f $bar, $pct, $mb, $totalMB)
          $lastShown = $pct
        }
      } else {
        StatusInline ("  {0} MB downloaded   " -f $mb)
      }
    }
  } finally {
    $out.Close(); $in.Close(); $resp.Close()
  }
  [Console]::Error.WriteLine('')                # finish the in-place line
  Status "  download complete."
}

New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

# ---------------- Node.js ----------------
# Fetch a portable Node when none is on PATH OR the system Node is too old.
Status ''
Status '--- Step 1 of 2: Node.js ---'
if (-not (NodeIsRecentEnough)) {
  $nodeName = "node-v$NodeVersion-win-$NodeArch"
  $nodeDir  = Join-Path $RuntimeDir $nodeName
  if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) {
    Status "  not on this PC - fetching a portable copy (one time)..."
    $zip = Join-Path $RuntimeDir "$nodeName.zip"
    Download "https://nodejs.org/dist/v$NodeVersion/$nodeName.zip" $zip "Node.js $NodeVersion"
    Status "  extracting..."
    Expand-Archive -Path $zip -DestinationPath $RuntimeDir -Force
    Remove-Item $zip -Force
    Status "  Node.js ready."
  } else {
    Status "  using the copy already downloaded in .runtime\."
  }
  $PathAdds += $nodeDir
  $env:Path = "$nodeDir;$env:Path"
} else {
  Status "  already installed - good to go."
}

# ---------------- ffmpeg / ffprobe ----------------
Status ''
Status '--- Step 2 of 2: ffmpeg (for video playback) ---'
if (-not (Have 'ffmpeg') -or -not (Have 'ffprobe')) {
  # gyan.dev publishes a maintained Windows static build. The "essentials"
  # zip contains ffmpeg.exe + ffprobe.exe under <root>\bin\.
  $ffDir = Join-Path $RuntimeDir 'ffmpeg'
  $ffBin = $null
  if (Test-Path $ffDir) {
    $found = Get-ChildItem -Path $ffDir -Recurse -Filter 'ffmpeg.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $ffBin = $found.DirectoryName }
  }
  if (-not $ffBin) {
    Status "  not on this PC - fetching a portable copy (one time)..."
    $zip = Join-Path $RuntimeDir 'ffmpeg.zip'
    Download 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' $zip 'ffmpeg'
    Status "  extracting..."
    if (Test-Path $ffDir) { Remove-Item $ffDir -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $ffDir -Force
    Remove-Item $zip -Force
    $found = Get-ChildItem -Path $ffDir -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
    $ffBin = $found.DirectoryName
    Status "  ffmpeg ready."
  } else {
    Status "  using the copy already downloaded in .runtime\."
  }
  $PathAdds += $ffBin
  $env:Path = "$ffBin;$env:Path"
} else {
  Status "  already installed - good to go."
}

Status ''
Status 'Requirements ready.'

# Emit the PATH additions for the caller (.bat reads these).
foreach ($p in $PathAdds) { Write-Output "PATHADD=$p" }
