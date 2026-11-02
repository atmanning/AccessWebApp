# Access Web installer for Windows 10 / 11. No admin rights and no questions.
#
#   irm https://raw.githubusercontent.com/atmanning/AccessWebApp/main/install.ps1 | iex
#
# (or double-click install.cmd). Run it again to update; your data folder is kept.
# It downloads private copies of Node.js, Java and Maven into the app folder (nothing is installed
# system-wide and Path isn't changed), builds the app, adds Desktop and Start menu shortcuts, and
# starts it.
#
# Options (parameters, or environment variables when using `irm | iex`):
#   -InstallDir path   ACCESSWEB_DIR       install folder (default %USERPROFILE%\AccessWeb)
#   -NoStart           ACCESSWEB_NO_START  don't start the app when done
#   -Source file.zip   ACCESSWEB_SOURCE    install from a downloaded .zip of the repo (offline/USB)
#   -Branch name       ACCESSWEB_BRANCH    GitHub branch to install (default main)
param(
  [string]$InstallDir = $(if ($env:ACCESSWEB_DIR) { $env:ACCESSWEB_DIR } else { Join-Path $HOME 'AccessWeb' }),
  [string]$Branch = $(if ($env:ACCESSWEB_BRANCH) { $env:ACCESSWEB_BRANCH } else { 'main' }),
  [string]$Source = $env:ACCESSWEB_SOURCE,
  [switch]$NoStart = [bool]$env:ACCESSWEB_NO_START
)

# Everything runs inside this script block so that, when piped into `iex`, the settings below stay
# out of the caller's PowerShell session and an error never closes their window.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is many times slower with a progress bar
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $Repo = 'atmanning/AccessWebApp'
  $NodeMajor = 22
  $JavaMajor = 21
  $MavenVersion = '3.9.11'

  function Say($m)  { Write-Host "==> $m" -ForegroundColor Cyan }
  function Warn($m) { Write-Host "Note: $m" -ForegroundColor Yellow }
  function Download($url, $out) { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out }
  function Verify($file, $algo, $expected) {
    if ((Get-FileHash -Algorithm $algo $file).Hash -ne $expected.Trim()) { throw "Checksum mismatch for $(Split-Path $file -Leaf). Try again." }
  }
  # Unpack an archive and return the single top-level folder inside it.
  function Expand($archive, $dest) {
    New-Item -ItemType Directory -Force $dest | Out-Null
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (Test-Path $tar) { & $tar -xf $archive -C $dest; if ($LASTEXITCODE) { throw "Couldn't unpack $archive" } }
    else { Expand-Archive $archive -DestinationPath $dest -Force }
    $top = @(Get-ChildItem $dest)
    if ($top.Count -eq 1 -and $top[0].PSIsContainer) { return $top[0].FullName } else { return $dest }
  }
  function Run($exe, [string[]]$argList) {
    & $exe @argList
    if ($LASTEXITCODE) { throw "'$(Split-Path $exe -Leaf) $($argList -join ' ')' failed (exit code $LASTEXITCODE)." }
  }
  function ReadText($p) { if (Test-Path $p) { (Get-Content $p -Raw).Trim() } else { '' } }

  try {
    # ------------------------------------------------------------ checks
    $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    switch ($arch) {
      'AMD64' { $nodeArch = 'x64';   $jdkArch = 'x64' }
      'ARM64' { $nodeArch = 'arm64'; $jdkArch = 'aarch64' }
      default { throw "Unsupported processor: $arch (Access Web needs 64-bit Windows)." }
    }

    $InstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
    $marker = Join-Path $InstallDir '.accessweb-install'
    $rt = Join-Path $InstallDir '.runtime'
    if ((Test-Path $InstallDir) -and (Get-ChildItem -Force $InstallDir) -and -not (Test-Path $marker)) {
      throw "$InstallDir already exists and wasn't made by this installer. Choose another folder with -InstallDir (or ACCESSWEB_DIR)."
    }
    New-Item -ItemType Directory -Force $rt, (Join-Path $InstallDir 'data') | Out-Null
    Set-Content $marker 'Folder managed by the Access Web installer.'
    # Scratch space inside the install folder: Move-Item can't move folders between drives.
    $tmp = Join-Path $InstallDir '.tmp'
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    New-Item -ItemType Directory $tmp | Out-Null

    Say "Installing Access Web into $InstallDir"

    # Stop a running copy (it uses the node.exe in .runtime) so its files can be replaced.
    $running = @(Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($InstallDir, 'OrdinalIgnoreCase') })
    if ($running) { $running | Stop-Process -Force; Start-Sleep 1; Say 'Stopped the running copy' }

    # ------------------------------------------------------------ runtimes
    # Each runtime is skipped when already current, and kept as-is when the download site can't be
    # reached (so updates work offline once the runtimes are there).
    $nodeExe = Join-Path $rt 'node\node.exe'
    try { $sums = Invoke-RestMethod "https://nodejs.org/dist/latest-v$NodeMajor.x/SHASUMS256.txt" } catch { $sums = '' }
    if (-not $sums) {
      if (Test-Path $nodeExe) { Warn "Couldn't check for a newer Node.js; keeping the current one." }
      else { throw "Couldn't reach nodejs.org to download Node.js." }
    } else {
      $pattern = "^([0-9a-f]{64})\s+(node-v[\d.]+-win-$nodeArch\.zip)\s*$"
      $line = ($sums -split "`n") | Where-Object { $_ -match $pattern } | Select-Object -First 1
      if (-not ($line -match $pattern)) { throw "No Node.js $NodeMajor build for win-$nodeArch." }
      $nodeSha = $Matches[1]; $file = $Matches[2]
      if ((ReadText "$rt\node.version") -eq $file) { Say 'Node.js is up to date' } else {
        Say "Downloading Node.js ($file)"
        Download "https://nodejs.org/dist/latest-v$NodeMajor.x/$file" "$tmp\node.zip"
        Verify "$tmp\node.zip" SHA256 $nodeSha
        $dir = Expand "$tmp\node.zip" "$tmp\node"
        Remove-Item -Recurse -Force "$rt\node" -ErrorAction SilentlyContinue
        Move-Item $dir "$rt\node"
        Set-Content "$rt\node.version" $file
      }
    }

    $javaExe = Join-Path $rt 'java\bin\java.exe'
    try { $assets = Invoke-RestMethod "https://api.adoptium.net/v3/assets/latest/$JavaMajor/hotspot?os=windows&architecture=$jdkArch&image_type=jdk&vendor=eclipse" } catch { $assets = $null }
    if (-not $assets) {
      if (Test-Path $javaExe) { Warn "Couldn't check for a newer Java; keeping the current one." }
      else { throw "Couldn't reach api.adoptium.net to download Java." }
    } else {
      $pkg = @($assets)[0].binary.package
      if ((ReadText "$rt\java.version") -eq $pkg.name) { Say 'Java is up to date' } else {
        Say "Downloading Java $JavaMajor ($($pkg.name))"
        Download $pkg.link "$tmp\jdk.zip"
        Verify "$tmp\jdk.zip" SHA256 $pkg.checksum
        $dir = Expand "$tmp\jdk.zip" "$tmp\jdk"
        Remove-Item -Recurse -Force "$rt\java" -ErrorAction SilentlyContinue
        Move-Item $dir "$rt\java"
        Set-Content "$rt\java.version" $pkg.name
      }
    }

    if ((ReadText "$rt\maven.version") -ne $MavenVersion) {
      $url = "https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/$MavenVersion/apache-maven-$MavenVersion-bin.zip"
      Say "Downloading Maven $MavenVersion"
      Download $url "$tmp\maven.zip"
      Verify "$tmp\maven.zip" SHA512 ((Invoke-RestMethod "$url.sha512") -split '\s+')[0]
      $dir = Expand "$tmp\maven.zip" "$tmp\maven"
      Remove-Item -Recurse -Force "$rt\maven" -ErrorAction SilentlyContinue
      Move-Item $dir "$rt\maven"
      Set-Content "$rt\maven.version" $MavenVersion
    }

    # Only this script sees these; the system Path and JAVA_HOME are left alone.
    $env:Path = "$rt\node;$rt\java\bin;$rt\maven\bin;$env:Path"
    $env:JAVA_HOME = "$rt\java"

    # ------------------------------------------------------------ app
    if ($Source) {
      Say "Using app files from $Source"
      $src = Expand $Source "$tmp\src"
    } else {
      Say "Downloading the latest Access Web ($Branch)"
      Download "https://github.com/$Repo/archive/refs/heads/$Branch.zip" "$tmp\app.zip"
      $src = Expand "$tmp\app.zip" "$tmp\src"
    }
    if (-not (Test-Path "$src\package.json") -or -not (Test-Path "$src\start-local.cmd")) { throw "The downloaded files don't look like Access Web." }

    # Swap the app files, keeping data\ and the runtimes. The previous version is kept until the new
    # one builds, and put back if the build fails.
    $keep = 'data', '.runtime', '.accessweb-install', '.previous', '.tmp'
    function MoveAppFiles($from, $to) {
      Get-ChildItem -Force $from | Where-Object { $keep -notcontains $_.Name } | Move-Item -Destination $to
    }
    $prev = Join-Path $InstallDir '.previous'
    Remove-Item -Recurse -Force $prev -ErrorAction SilentlyContinue
    New-Item -ItemType Directory $prev | Out-Null
    MoveAppFiles $InstallDir $prev
    MoveAppFiles $src $InstallDir

    Push-Location $InstallDir
    try {
      $npm = "$rt\node\npm.cmd"
      Say 'Installing packages'
      Run $npm @('ci', '--no-audit', '--no-fund', '--loglevel=error')
      Say 'Building the app'
      Run $npm @('run', 'build', '--silent')
      Say 'Building the Access (.accdb) exporter'
      & "$rt\maven\bin\mvn.cmd" -B -q -ntp -f exporter\pom.xml package -DskipTests
      if ($LASTEXITCODE) { Warn "The exporter didn't build, so .accdb import/export won't work. Everything else will; run the installer again later to retry." }
      Run $npm @('prune', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error')
    } catch {
      Pop-Location
      if (Get-ChildItem -Force $prev) {
        $failed = Join-Path $tmp 'failed'; New-Item -ItemType Directory $failed | Out-Null
        MoveAppFiles $InstallDir $failed
        MoveAppFiles $prev $InstallDir
        Remove-Item -Force $prev
        throw "The build failed, so your previous version was put back. $($_.Exception.Message)"
      }
      Remove-Item -Force $prev -ErrorAction SilentlyContinue
      throw "The build failed. $($_.Exception.Message)"
    }
    Pop-Location
    Remove-Item -Recurse -Force $prev

    # ------------------------------------------------------------ shortcuts
    $launcher = Join-Path $InstallDir 'start-local.cmd'
    $shell = New-Object -ComObject WScript.Shell
    foreach ($folder in [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) {
      $lnk = $shell.CreateShortcut((Join-Path $folder 'Access Web.lnk'))
      $lnk.TargetPath = $launcher
      $lnk.WorkingDirectory = $InstallDir
      $lnk.Description = 'Start Access Web and open it in your browser'
      $lnk.Save()
    }
    Say "Added 'Access Web' to your Desktop and Start menu"

    Write-Host ''
    Say "Access Web is installed. Your databases are kept in $InstallDir\data"
    Write-Host '    Start it any time from the Access Web shortcut.'
    Write-Host '    Update it by running this installer again.'
    Write-Host ''
    if (-not $NoStart) { Start-Process -FilePath $launcher -WorkingDirectory $InstallDir }
  } catch {
    Write-Host ''
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Nothing outside the install folder was changed. Fix the problem above and run the installer again.'
    $global:LASTEXITCODE = 1
  } finally {
    if ($tmp -and (Test-Path $tmp)) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
  }
}
