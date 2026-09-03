[CmdletBinding()]
param(
  [ValidateSet("zcode", "cursor", "codex", "claude", "vscode", "print")]
  [string]$Client = "zcode",
  [string]$ConfigPath
)

$ErrorActionPreference = "Stop"
$packageSpec = "@luckychen1993/pm-mcp@0.1.1"
$serverName = "pm-mcp"

function Assert-NodeVersion {
  $node = Get-Command node -ErrorAction SilentlyContinue
  $npx = Get-Command npx -ErrorAction SilentlyContinue
  if (-not $node -or -not $npx) {
    throw "Node.js and npx are required. Install Node.js 22.18 or newer first."
  }
  $raw = (& node --version).TrimStart("v")
  $version = [version]$raw
  if ($version -lt [version]"22.18.0") {
    throw "Node.js 22.18 or newer is required; found $raw."
  }
}

function Add-PropertyIfMissing {
  param([object]$Object, [string]$Name, [object]$Value)
  if (-not $Object.PSObject.Properties[$Name]) {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
  }
  return $Object.$Name
}

function Set-JsonServer {
  param([string]$Path, [ValidateSet("zcode", "standard")][string]$Shape)

  $fullPath = [IO.Path]::GetFullPath($Path)
  $directory = Split-Path -Parent $fullPath
  [IO.Directory]::CreateDirectory($directory) | Out-Null

  if (Test-Path -LiteralPath $fullPath) {
    $raw = [IO.File]::ReadAllText($fullPath)
    try { $config = $raw | ConvertFrom-Json } catch { throw "Invalid JSON in $fullPath; no changes were made." }
    $backupId = "$(Get-Date -Format 'yyyyMMddHHmmssfff')-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    $backup = "$fullPath.backup-$backupId"
    Copy-Item -LiteralPath $fullPath -Destination $backup
    Write-Host "Backup: $backup"
  } else {
    $config = [pscustomobject]@{}
  }

  if ($Shape -eq "zcode") {
    $mcp = Add-PropertyIfMissing $config "mcp" ([pscustomobject]@{})
    $servers = Add-PropertyIfMissing $mcp "servers" ([pscustomobject]@{})
  } else {
    $servers = Add-PropertyIfMissing $config "mcpServers" ([pscustomobject]@{})
  }

  $definition = [pscustomobject]@{
    command = "npx"
    args = @("-y", $packageSpec)
    env = [pscustomobject]@{}
  }
  if ($servers.PSObject.Properties[$serverName]) {
    $servers.$serverName = $definition
  } else {
    $servers | Add-Member -NotePropertyName $serverName -NotePropertyValue $definition
  }

  $json = $config | ConvertTo-Json -Depth 32
  $temporary = "$fullPath.tmp-$PID"
  [IO.File]::WriteAllText($temporary, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $fullPath -Force
  Write-Host "Configured $serverName in $fullPath"
}

function Assert-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name was not found in PATH."
  }
}

Assert-NodeVersion

switch ($Client) {
  "zcode" {
    if (-not $ConfigPath) {
      $zcodeRoot = if ($env:ZCODE_HOME) { $env:ZCODE_HOME } else { Join-Path $HOME ".zcode" }
      $ConfigPath = Join-Path $zcodeRoot "cli/config.json"
    }
    Set-JsonServer $ConfigPath "zcode"
  }
  "cursor" {
    if (-not $ConfigPath) { $ConfigPath = Join-Path $HOME ".cursor/mcp.json" }
    Set-JsonServer $ConfigPath "standard"
  }
  "codex" {
    Assert-Command "codex"
    & codex mcp get $serverName *> $null
    if ($LASTEXITCODE -eq 0) {
      Write-Host "$serverName is already configured in Codex; no existing configuration was replaced."
    } else {
      & codex mcp add $serverName -- npx -y $packageSpec
      if ($LASTEXITCODE -ne 0) { throw "codex mcp add failed with exit code $LASTEXITCODE." }
    }
  }
  "claude" {
    Assert-Command "claude"
    & claude mcp get $serverName *> $null
    if ($LASTEXITCODE -eq 0) {
      Write-Host "$serverName is already configured in Claude Code; no existing configuration was replaced."
    } else {
      & claude mcp add $serverName --scope user -- npx -y $packageSpec
      if ($LASTEXITCODE -ne 0) { throw "claude mcp add failed with exit code $LASTEXITCODE." }
    }
  }
  "vscode" {
    Assert-Command "code"
    $definition = @{ name = $serverName; command = "npx"; args = @("-y", $packageSpec) } | ConvertTo-Json -Compress
    & code --add-mcp $definition
    if ($LASTEXITCODE -ne 0) { throw "code --add-mcp failed with exit code $LASTEXITCODE." }
  }
  "print" {
    @{ mcpServers = @{ $serverName = @{ command = "npx"; args = @("-y", $packageSpec); env = @{} } } } |
      ConvertTo-Json -Depth 8
  }
}

Write-Host "Done. Restart the AI coding client, then ask it to call pm-mcp get_status."
