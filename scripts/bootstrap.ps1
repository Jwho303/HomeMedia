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
$NodeVersion = '20.18.1'                      # Node LTS
$NodeArch    = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
$RepoRoot    = Split-Path -Parent $PSScriptRoot
$RuntimeDir  = Join-Path $RepoRoot '.runtime'
$PathAdds    = @()

function Have($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function Download($url, $dest) {
  Write-Host "  downloading $url"
  # Use TLS 1.2+, and the faster non-progress-bar path.
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
}

New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

# ---------------- Node.js ----------------
if (-not (Have 'node')) {
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
