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
  Write-Host "[setup] Found Node v$v, but HomeMedia needs v$MinNodeMajor.$MinNodeMinor or newer."
  return $false
}

function Download($url, $dest) {
  Write-Host "  downloading $url"
  # Use TLS 1.2+, and the faster non-progress-bar path.
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
}

New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

# ---------------- Node.js ----------------
# Fetch a portable Node when none is on PATH OR the system Node is too old.
if (-not (NodeIsRecentEnough)) {
  $nodeName = "node-v$NodeVersion-win-$NodeArch"
  $nodeDir  = Join-Path $RuntimeDir $nodeName
  if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) {
    Write-Host "[setup] Node.js not found - fetching a portable copy (one time)..."
    $zip = Join-Path $RuntimeDir "$nodeName.zip"
    Download "https://nodejs.org/dist/v$NodeVersion/$nodeName.zip" $zip
    Write-Host "  extracting..."
    Expand-Archive -Path $zip -DestinationPath $RuntimeDir -Force
    Remove-Item $zip -Force
  }
  $PathAdds += $nodeDir
  $env:Path = "$nodeDir;$env:Path"
}

# ---------------- ffmpeg / ffprobe ----------------
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
    Write-Host "[setup] ffmpeg not found - fetching a portable copy (one time)..."
    $zip = Join-Path $RuntimeDir 'ffmpeg.zip'
    Download 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' $zip
    Write-Host "  extracting..."
    if (Test-Path $ffDir) { Remove-Item $ffDir -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $ffDir -Force
    Remove-Item $zip -Force
    $found = Get-ChildItem -Path $ffDir -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
    $ffBin = $found.DirectoryName
  }
  $PathAdds += $ffBin
  $env:Path = "$ffBin;$env:Path"
}

# Emit the PATH additions for the caller (.bat reads these).
foreach ($p in $PathAdds) { Write-Output "PATHADD=$p" }
