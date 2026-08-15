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

function Resolve-Deck([string]$SourcePath) {
  $sourceFull = (Resolve-Path -LiteralPath $SourcePath).Path
  $extension = [IO.Path]::GetExtension($sourceFull).ToLowerInvariant()

  if ($extension -ne '.zip') {
    if ($sourceFull -notmatch '(?i)\.html$') { throw "ZIPまたはHTMLを指定してください: $sourceFull" }
    return [pscustomobject]@{ Deck = $sourceFull; Temp = $null }
  }

  $temp = Join-Path $tempRoot ('renderer2-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -LiteralPath $temp | Out-Null
  Expand-Archive -LiteralPath $sourceFull -DestinationPath $temp

  $deck = $null
  $manifestPath = Join-Path $temp 'manifest.json'
  if (Test-Path -LiteralPath $manifestPath) {
    try {
      $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
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

  return [pscustomobject]@{ Deck = $deck; Temp = $temp }
}

function Remove-SafeTemp([string]$TempPath) {
  if (-not $TempPath) { return }
  $full = [IO.Path]::GetFullPath($TempPath)
  if ((Test-PathInside $tempRoot $full) -and ([IO.Path]::GetFileName($full) -like 'renderer2-*')) {
    Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Get-RenderMode([string]$DeckPath) {
  $html = Get-Content -LiteralPath $DeckPath -Raw -Encoding UTF8
  $explicit = [regex]::Match($html, '(?i)data-render-mode\s*=\s*["''](css|vt)["'']')
  if ($explicit.Success) { return $explicit.Groups[1].Value.ToLowerInvariant() }
  if ($html -match '(?i)<canvas|getContext|webgl|offscreencanvas|requestAnimationFrame|setInterval') { return 'vt' }
  return 'css'
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

      $mode = Get-RenderMode $resolved.Deck
      $env:VT = if ($mode -eq 'vt') { '1' } else { '' }
      $env:CONC = '4'
      $env:FORMAT = 'jpeg'
      $env:PRESET = 'veryfast'
      $env:OUT = $output

      Write-Host "RENDERER2: $sourceFull"
      Write-Host "mode=$mode  output=$output"
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
