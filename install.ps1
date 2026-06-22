param(
  [switch]$NoStart,
  [switch]$CliSetup,
  [switch]$WebFirst,
  [switch]$SkipBrowserOpen,
  [switch]$NonInteractive,
  [switch]$Json,
  [string]$Dir = "",
  [string]$Branch = "main",
  [string]$Repo = "",
  [string]$SourceZip = "",
  [ValidateSet("all", "node", "repository", "dependencies", "configure", "start")]
  [string]$Stage = "all"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$modernInstaller = Join-Path $PSScriptRoot "scripts\install-windows.ps1"
if (Test-Path $modernInstaller) {
  if (-not $Dir) { $Dir = $PSScriptRoot }
  & $modernInstaller `
    -Dir $Dir `
    -Branch $Branch `
    -Repo $Repo `
    -SourceZip $SourceZip `
    -NoStart:$NoStart `
    -SkipBrowserOpen:$SkipBrowserOpen `
    -NonInteractive:$NonInteractive `
    -Json:$Json `
    -Stage $Stage
  exit $LASTEXITCODE
}

$argsList = @()
if ($NoStart) { $argsList += "--no-start" }
if ($CliSetup) { $argsList += "--cli-setup" }
if ($WebFirst) { $argsList += "--web-first" }

node .\install.js @argsList
