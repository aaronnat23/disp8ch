param(
  [string]$Dir = "",
  [string]$Branch = "main",
  [string]$Repo = "",
  [string]$SourceZip = "",
  [switch]$NoStart,
  [switch]$SkipBrowserOpen,
  [switch]$NonInteractive,
  [switch]$Json,
  [ValidateSet("all", "node", "repository", "dependencies", "configure", "start")]
  [string]$Stage = "all"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not $Dir) {
  $localAppData = ${env:LOCALAPPDATA}
  if (-not $localAppData) {
    $localAppData = Join-Path $HOME "AppData\Local"
  }
  $Dir = Join-Path $localAppData "disp8ch\app"
}

function Test-NodeVersion {
  try {
    $version = & node.exe -p "process.versions.node" 2>$null
    if (-not $version) { return $false }
    $parts = $version.Split(".") | ForEach-Object { [int]$_ }
    return ($parts[0] -gt 22) -or ($parts[0] -eq 22 -and ($parts[1] -gt 13 -or ($parts[1] -eq 13 -and $parts[2] -ge 0)))
  } catch {
    return $false
  }
}

function Install-ManagedNode {
  $nodeRoot = Join-Path $env:LOCALAPPDATA "disp8ch\runtime\node"
  New-Item -ItemType Directory -Force -Path $nodeRoot | Out-Null
  $index = Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/latest-v22.x/"
  $archive = ([regex]::Matches($index.Content, "node-v22\.\d+\.\d+-win-x64\.zip") | Select-Object -First 1).Value
  if (-not $archive) { throw "Could not resolve Node.js 22 Windows archive." }
  $url = "https://nodejs.org/dist/latest-v22.x/$archive"
  $zip = Join-Path $nodeRoot "node.zip"
  Write-Host "Installing managed Node.js from $url"
  Invoke-WebRequest -UseBasicParsing $url -OutFile $zip
  $extract = Join-Path $nodeRoot "extract"
  if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
  Expand-Archive -Path $zip -DestinationPath $extract -Force
  $nodeDir = Get-ChildItem $extract | Where-Object { $_.PSIsContainer -and $_.Name -like "node-v22*" } | Select-Object -First 1
  if (-not $nodeDir) { throw "Node archive extraction did not contain node-v22 folder." }
  $env:PATH = "$($nodeDir.FullName);$env:PATH"
}

function Invoke-Pnpm {
  param([string[]]$Arguments)
  if (Get-Command pnpm.cmd -ErrorAction SilentlyContinue) {
    & pnpm.cmd @Arguments
  } else {
    & npx.cmd -y pnpm@10.30.2 @Arguments
  }
}

function Resolve-SourceZipUrl {
  if ($SourceZip) { return $SourceZip }
  if ($env:DISP8CH_SOURCE_ZIP_URL) { return $env:DISP8CH_SOURCE_ZIP_URL }
  if ($Repo -match "^https://github\.com/([^/]+)/([^/.]+?)(?:\.git)?/?$") {
    return "https://github.com/$($Matches[1])/$($Matches[2])/archive/refs/heads/$Branch.zip"
  }
  return ""
}

function Install-SourceZip {
  param([string]$Url, [string]$Destination)
  if (-not $Url) {
    throw "Git/repo checkout is unavailable and no source archive URL was provided. Re-run with -Repo <github-url>, -SourceZip <zip-url>, or run inside a disp8ch checkout."
  }
  $parent = Split-Path $Destination -Parent
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $tmp = Join-Path $env:TEMP ("disp8ch-source-" + [guid]::NewGuid().ToString("N"))
  $zip = "$tmp.zip"
  try {
    Write-Host "Downloading disp8ch source archive from $Url"
    Invoke-WebRequest -UseBasicParsing $Url -OutFile $zip
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $root = Get-ChildItem $tmp | Where-Object { $_.PSIsContainer } | Select-Object -First 1
    if (-not $root) { throw "Source archive did not contain a top-level folder." }
    if (Test-Path $Destination) {
      $backup = "$Destination.backup-" + (Get-Date -Format "yyyyMMdd-HHmmss")
      Move-Item $Destination $backup -Force
    }
    Move-Item $root.FullName $Destination -Force
  } finally {
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if (($Stage -eq "all" -or $Stage -eq "node") -and -not (Test-NodeVersion)) {
  Install-ManagedNode
}
if (-not (Test-NodeVersion)) {
  throw "Node.js 22.13+ is required and managed Node install failed."
}

if ($Stage -eq "all" -or $Stage -eq "repository") {
  New-Item -ItemType Directory -Force -Path (Split-Path $Dir -Parent) | Out-Null
  $isGitCheckout = $false
  if ((Test-Path (Join-Path $Dir ".git")) -and (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    try {
      $inside = & git.exe -C $Dir rev-parse --is-inside-work-tree 2>$null
      $isGitCheckout = ($LASTEXITCODE -eq 0 -and "$inside".Trim() -eq "true")
    } catch {
      $isGitCheckout = $false
    }
  }
  if ($isGitCheckout) {
    & git.exe -C $Dir fetch --all --prune
    & git.exe -C $Dir checkout $Branch
    & git.exe -C $Dir pull --ff-only
  } elseif ($Repo -and (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    & git.exe clone --branch $Branch $Repo $Dir
  } elseif ((Test-Path ".\package.json") -and (Test-Path ".\install.js")) {
    $Dir = (Get-Location).Path
  } else {
    Install-SourceZip -Url (Resolve-SourceZipUrl) -Destination $Dir
  }
}

Set-Location $Dir

if ($Stage -eq "all" -or $Stage -eq "dependencies") {
  try { & corepack.cmd enable | Out-Null } catch {}
  Invoke-Pnpm @("install")
}

if ($Stage -eq "all" -or $Stage -eq "configure") {
  Invoke-Pnpm @("dpc", "init", "--ensure-env")
}

if ($NoStart -or ($Stage -ne "all" -and $Stage -ne "start")) {
  if ($Json) {
    @{ ok = $true; appDir = $Dir; started = $false } | ConvertTo-Json
  } else {
    Write-Host "disp8ch installed at $Dir"
  }
  exit 0
}

if ($SkipBrowserOpen) {
  Invoke-Pnpm @("runtime:start", "--", "--install-channel", "script", "--no-open")
} else {
  Invoke-Pnpm @("runtime:start", "--", "--install-channel", "script")
}
