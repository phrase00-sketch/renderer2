param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$InputPaths
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$renderer = Join-Path $repoRoot 'capture-parallel.js'
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())

function Show-Error([string]$Message) {
  [System.Windows.Forms.MessageBox]::Show(
    $Message,
    'RENDERER2',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
}

function Assert-Command([string]$Name, [string]$Help) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name が見つかりません。$Help"
  }
}

function Test-PathInside([string]$Parent, [string]$Candidate) {
  $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  $candidateFull = [IO.Path]::GetFullPath($Candidate)
  return $candidateFull.StartsWith($parentFull, [StringComparison]::OrdinalIgnoreCase)
}

function Get-DeckRoot([string]$DeckPath) {
  $start = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($DeckPath))
  if (Test-Path -LiteralPath (Join-Path $start 'support.js')) { return $start }
  $current = $start
  for ($i = 0; $i -lt 4; $i++) {
    $parent = [IO.Path]::GetDirectoryName($current)
    if (-not $parent -or $parent -eq $current) { break }
    $current = $parent
    if ((Test-Path -LiteralPath (Join-Path $current 'support.js')) -and
        (Test-Path -LiteralPath (Join-Path $current 'manifest.json'))) {
      return $current
    }
  }
  return $start
}

function Get-DeckCodeBundle([string]$DeckPath) {
  $deckFull = [IO.Path]::GetFullPath($DeckPath)
  $deckDirectory = [IO.Path]::GetDirectoryName($deckFull)
  $root = Get-DeckRoot $deckFull
  $html = Get-Content -LiteralPath $deckFull -Raw -Encoding UTF8
  $custom = @()
  $seen = @{}

  foreach ($match in [regex]::Matches($html, '(?i)<script\b[^>]*\bsrc\s*=\s*["'']([^"'']+)["'']')) {
    $source = $match.Groups[1].Value -replace '[?#].*$', ''
    if (-not $source -or $source -match '^(?i:https?:|data:|blob:|//)') { continue }
    try { $source = [Uri]::UnescapeDataString($source) } catch {}
    $name = [IO.Path]::GetFileName(($source -replace '/', '\'))
    if ($name -match '^(?i:support|image-slot)\.js$') { continue }
    try {
      $candidate = if ($source -match '^[\\/]') {
        [IO.Path]::GetFullPath((Join-Path $root ($source -replace '^[\\/]+', '')))
      } else {
        [IO.Path]::GetFullPath((Join-Path $deckDirectory $source))
      }
    } catch { continue }
    if (-not (Test-PathInside $root $candidate)) { continue }
    if ($seen.ContainsKey($candidate) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    $item = Get-Item -LiteralPath $candidate
    if ($item.Length -gt 5MB) { continue }
    $seen[$candidate] = $true
    $custom += $candidate
  }

  $blob = $html
  foreach ($script in $custom) {
    try { $blob += "`n" + (Get-Content -LiteralPath $script -Raw -Encoding UTF8) } catch {}
  }
  return [pscustomobject]@{ Html = $html; Custom = $custom; Blob = $blob; Root = $root }
}

function Resolve-Deck([string]$SourcePath) {
  $sourceFull = (Resolve-Path -LiteralPath $SourcePath).Path
  $extension = [IO.Path]::GetExtension($sourceFull).ToLowerInvariant()

  if ($extension -ne '.zip') {
    if ($sourceFull -notmatch '(?i)\.html$') { throw "ZIPまたはHTMLを指定してください: $sourceFull" }
    return [pscustomobject]@{ Deck = $sourceFull; Temp = $null; RenderMode = $null }
  }

  $temp = Join-Path $tempRoot ('renderer2-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $temp | Out-Null
  Expand-Archive -LiteralPath $sourceFull -DestinationPath $temp

  $deck = $null
  $manifestRenderMode = $null
  $manifestPath = Join-Path $temp 'manifest.json'
  if (Test-Path -LiteralPath $manifestPath) {
    try {
      $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($manifest.renderMode) {
        $candidateMode = ([string]$manifest.renderMode).ToLowerInvariant()
        if ($candidateMode -notin @('css', 'vt')) { throw 'manifest.json のrenderModeはcssまたはvtで指定してください。' }
        $manifestRenderMode = $candidateMode
      }
      if ($manifest.deck) {
        $candidate = [IO.Path]::GetFullPath((Join-Path $temp ([string]$manifest.deck)))
        if (-not (Test-PathInside $temp $candidate)) { throw 'manifest.json のdeck指定が展開先の外を指しています。' }
        if (Test-Path -LiteralPath $candidate) { $deck = $candidate }
      }
    } catch {
      throw "manifest.jsonを安全に読み取れませんでした: $($_.Exception.Message)"
    }
  }

  if (-not $deck) {
    $decks = @(Get-ChildItem -LiteralPath $temp -Recurse -File | Where-Object { $_.Name -match '(?i)\.dc\.html$' })
    if ($decks.Count -eq 0) { throw 'ZIP内に .dc.html が見つかりません。' }
    if ($decks.Count -gt 1) { throw 'ZIP内に複数の .dc.html があります。manifest.jsonでdeckを指定してください。' }
    $deck = $decks[0].FullName
  }

  return [pscustomobject]@{ Deck = $deck; Temp = $temp; RenderMode = $manifestRenderMode }
}

function Remove-SafeTemp([string]$TempPath) {
  if (-not $TempPath) { return }
  $full = [IO.Path]::GetFullPath($TempPath)
  if ((Test-PathInside $tempRoot $full) -and ([IO.Path]::GetFileName($full) -like 'renderer2-*')) {
    Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Get-RenderMode([string]$DeckPath) {
  $code = Get-DeckCodeBundle $DeckPath
  $explicit = [regex]::Match($code.Html, '(?i)data-render-mode\s*=\s*["''](css|vt)["'']')
  if ($explicit.Success) { return $explicit.Groups[1].Value.ToLowerInvariant() }
  if ($code.Blob -match '(?i)<canvas|getContext|webgl|offscreencanvas|requestAnimationFrame|setInterval') { return 'vt' }
  return 'css'
}

function Get-RenderProfile([string]$DeckPath, [string]$Mode) {
  if ($Mode -ne 'vt') {
    return [pscustomobject]@{ Name = 'standard CSS'; Concurrency = 4; ProtocolTimeout = 90000; Reason = 'CSS / WAAPI' }
  }

  $code = Get-DeckCodeBundle $DeckPath
  $hits = @()
  foreach ($rule in @(
    @{ Label = 'Three.js'; Pattern = '(?i)\bTHREE\s*\.|WebGLRenderer\s*\(|\bthree(?:\.module|\.min)?\.js\b|\bthree(?:@|/)\d' },
    @{ Label = 'WebGL'; Pattern = '(?i)getContext\s*\(\s*["'']webgl(?:2)?["'']|\bwebgl2?\b' },
    @{ Label = 'WebGL high-load settings'; Pattern = '(?i)preserveDrawingBuffer|shadowMap\s*\.|\.shadowMapSize\b' }
  )) {
    if ($code.Blob -match $rule.Pattern) { $hits += $rule.Label }
  }

  if ($hits.Count -gt 0) {
    return [pscustomobject]@{
      Name = 'heavy WebGL / 3D'
      Concurrency = 4
      ProtocolTimeout = 180000
      Reason = (($hits | Select-Object -Unique) -join ', ')
    }
  }

  return [pscustomobject]@{ Name = 'standard virtual time'; Concurrency = 4; ProtocolTimeout = 120000; Reason = 'Canvas / rAF / timers' }
}

function Get-AutoOutput([string]$SourcePath) {
  $directory = [IO.Path]::GetDirectoryName($SourcePath)
  $base = [IO.Path]::GetFileNameWithoutExtension($SourcePath) -replace '(?i)\.dc$', ''
  $candidate = Join-Path $directory ($base + '.mp4')
  $suffix = 2
  while (Test-Path -LiteralPath $candidate) {
    $candidate = Join-Path $directory ($base + '_' + $suffix + '.mp4')
    $suffix++
  }
  return $candidate
}

try {
  Assert-Command 'node' 'Node.js 22.12.0以上をインストールしてください。'
  Assert-Command 'ffmpeg' 'FFmpegをインストールし、PATHを通してください。'
  Assert-Command 'ffprobe' 'FFmpeg付属のffprobeへPATHを通してください。'
  if (-not (Test-Path -LiteralPath $renderer)) { throw "レンダラーが見つかりません: $renderer" }
  if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules\puppeteer'))) {
    throw '依存関係が未導入です。リポジトリ直下で npm ci を一度実行してください。'
  }

  $sources = @($InputPaths | Where-Object { $_ })
  if ($sources.Count -eq 0) {
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = 'RENDERER2で書き出すZIPまたはHTMLを選択'
    $dialog.Filter = 'Deck package (*.zip;*.dc.html;*.html)|*.zip;*.dc.html;*.html'
    $dialog.Multiselect = $true
    if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
    $sources = @($dialog.FileNames)
  }

  $queue = $sources.Count -gt 1
  $results = @()

  foreach ($source in $sources) {
    $resolved = $null
    try {
      $sourceFull = (Resolve-Path -LiteralPath $source).Path
      $resolved = Resolve-Deck $sourceFull
      $output = if ($queue) { Get-AutoOutput $sourceFull } else {
        $save = New-Object System.Windows.Forms.SaveFileDialog
        $save.Title = 'MP4の保存先を選択'
        $save.Filter = 'MP4 video (*.mp4)|*.mp4'
        $save.FileName = ([IO.Path]::GetFileNameWithoutExtension($sourceFull) -replace '(?i)\.dc$', '') + '.mp4'
        $save.InitialDirectory = [IO.Path]::GetDirectoryName($sourceFull)
        $save.OverwritePrompt = $true
        if ($save.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
        $save.FileName
      }

      $mode = if ($resolved.RenderMode) { $resolved.RenderMode } else { Get-RenderMode $resolved.Deck }
      $profile = Get-RenderProfile $resolved.Deck $mode
      $concurrency = $profile.Concurrency
      if (-not [string]::IsNullOrWhiteSpace($env:RENDERER2_CONC)) {
        if ($env:RENDERER2_CONC -notmatch '^\d+$' -or [int]$env:RENDERER2_CONC -lt 1 -or [int]$env:RENDERER2_CONC -gt 32) {
          throw 'RENDERER2_CONC は1〜32の整数で指定してください。'
        }
        $concurrency = [int]$env:RENDERER2_CONC
      }
      $env:VT = if ($mode -eq 'vt') { '1' } else { '' }
      $env:CONC = [string]$concurrency
      $env:PROTO_TIMEOUT = [string]$profile.ProtocolTimeout
      $env:RETRY_PROTO_TIMEOUT = [string]([Math]::Max(300000, $profile.ProtocolTimeout))
      $env:RETRY_FAILED_SHARDS = '1'
      $env:FORMAT = 'jpeg'
      $env:PRESET = 'veryfast'
      $env:OUT = $output

      Write-Host "RENDERER2: $sourceFull"
      Write-Host "mode=$mode  load=$($profile.Name) ($($profile.Reason))"
      $fallback = if ($profile.Name -eq 'heavy WebGL / 3D' -and $concurrency -gt 2) { ' -> 2 -> 1 on failure' } else { ' -> 1 on failure' }
      Write-Host "CONC=$concurrency$fallback  PROTO_TIMEOUT=$($profile.ProtocolTimeout)ms  output=$output"
      & node $renderer $resolved.Deck
      if ($LASTEXITCODE -ne 0) { throw "レンダラーがコード $LASTEXITCODE で終了しました。" }
      $results += [pscustomobject]@{ Source = $sourceFull; Output = $output; Success = $true }
    } catch {
      Write-Host "[失敗] $source : $($_.Exception.Message)"
      $results += [pscustomobject]@{ Source = $source; Output = ''; Success = $false; Error = $_.Exception.Message }
      if (-not $queue) { throw }
    } finally {
      if ($resolved) { Remove-SafeTemp $resolved.Temp }
    }
  }

  $success = @($results | Where-Object Success)
  $failed = @($results | Where-Object { -not $_.Success })
  if ($success.Count -gt 0) {
    $lastOutput = $success[-1].Output
    Start-Process explorer.exe -ArgumentList ('/select,"' + $lastOutput + '"')
  }
  if ($failed.Count -gt 0) { exit 1 }
} catch {
  Show-Error $_.Exception.Message
  Write-Host $_.Exception.Message
  exit 1
}
