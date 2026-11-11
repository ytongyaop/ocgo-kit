#Requires -Version 5.1
<#
  维护者工具：需要在 Windows PowerShell 5.1+ 运行；最终用户不需要它，装配置请用 install.mjs 或 PROMPT.md。

  sync.ps1 —— ocgo-kit 与现场 opencode 配置的防漂移校验 / 同步。

  用法：
    .\sync.ps1 -Check     只校验，不写入任何文件。三条判据全过才输出 DRIFT=0、退出码 0。
    .\sync.ps1 -Apply     真正同步：把现场 workflows\*.md 复制进 kit，途中做令牌化。

  不带参数执行只会打印用法并以退出码 2 结束——写入必须显式给 -Apply，避免手滑。

  判据（-Check）：
    1. 文件集   kit\config\workflows\*.md 的文件名集合 == 现场 workflows\*.md 的文件名集合
    2. 四键     每个流程 md 的头部都含 触发: / 不触发: / 前置产物: / 产出物: 四个键
    3. 私有信息 kit 内不含未令牌化的用户名、用户目录绝对路径、工作目录绝对路径

  -Apply 只动 config\workflows\。AGENTS.md / docs / README / PROMPT 属于策展内容，
  需要人工同步；脚本每次跑完都会把这些提醒打出来。
#>
[CmdletBinding()]
param(
  [switch]$Check,
  [switch]$Apply,
  [string]$LiveRoot = '',
  [string]$KitRoot = ''
)

$ErrorActionPreference = 'Stop'

if (-not $KitRoot) { $KitRoot = Split-Path -Parent $PSScriptRoot }
if (-not $LiveRoot) { $LiveRoot = Join-Path $env:USERPROFILE '.config\opencode' }

$KitWorkflows = Join-Path $KitRoot 'config\workflows'
$LiveWorkflows = Join-Path $LiveRoot 'workflows'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Usage {
  Write-Host 'sync.ps1 —— ocgo-kit 防漂移校验 / 同步'
  Write-Host ''
  Write-Host '  .\sync.ps1 -Check    只校验，不写入；DRIFT=0 时退出码 0，否则 1'
  Write-Host '  .\sync.ps1 -Apply    把现场 workflows\*.md 复制进 kit 并令牌化'
  Write-Host ''
  Write-Host '可选参数：'
  Write-Host '  -LiveRoot <目录>   现场配置目录，默认 %USERPROFILE%\.config\opencode'
  Write-Host '  -KitRoot  <目录>   kit 根目录，默认本脚本所在目录的上一级'
}

if ($Check -and $Apply) { Write-Usage; exit 2 }
if (-not $Check -and -not $Apply) { Write-Usage; exit 2 }

# ---------------------------------------------------------------- 令牌化

# 规则顺序敏感：先长前缀，再短前缀；否则短前缀会把长前缀切碎。
# 这里只用正则形态描述"用户目录 / 工作目录"，不写任何真实绝对路径，
# 这样脚本本身不会成为私有信息的载体（判据 3 会扫到它自己）。
function Convert-ToKitText {
  param([string]$Text)

  $rules = @(
    @{ p = '[A-Za-z]:[\\/]Users[\\/][^\\/\s"'']+[\\/]\.config[\\/]opencode'; r = '{{CFG_ROOT}}' }
    @{ p = '[A-Za-z]:[\\/]workspace[\\/]work[\\/]opencode'; r = '{{WORK_ROOT}}' }
    @{ p = '[A-Za-z]:[\\/]workspace[\\/]work[\\/]knowledge'; r = '{{KNOWLEDGE_ROOT}}' }
    @{ p = '[A-Za-z]:[\\/]workspace[\\/]work'; r = '{{WORKSPACE_ROOT}}' }
  )

  foreach ($rule in $rules) {
    $Text = [regex]::Replace($Text, $rule.p, $rule.r, 'IgnoreCase')
  }
  if ($env:USERNAME) { $Text = $Text.Replace($env:USERNAME, '{{USER}}') }
  return $Text
}

# ---------------------------------------------------------------- 判据

$script:Drift = 0

function Report-Ok([string]$item, [string]$detail) {
  Write-Host ("OK {0}  {1}" -f $item, $detail)
}

function Report-Drift([string]$item, [string]$detail) {
  $script:Drift++
  Write-Host ("DRIFT {0}  {1}" -f $item, $detail)
}

function Get-WorkflowNames([string]$dir) {
  if (-not (Test-Path -LiteralPath $dir)) { return @() }
  return @(Get-ChildItem -LiteralPath $dir -File -Filter '*.md' | ForEach-Object { $_.Name })
}

# 判据 1：文件名集合
function Test-WorkflowFileSet {
  if (-not (Test-Path -LiteralPath $LiveWorkflows)) {
    Report-Drift '文件集' "现场 workflows 目录不存在：$LiveWorkflows（-LiveRoot 传对了吗）"
    return
  }
  $kitNames = Get-WorkflowNames $KitWorkflows
  $liveNames = Get-WorkflowNames $LiveWorkflows

  $missing = @($liveNames | Where-Object { $kitNames -notcontains $_ })
  $extra = @($kitNames | Where-Object { $liveNames -notcontains $_ })

  if ($missing.Count -eq 0 -and $extra.Count -eq 0) {
    Report-Ok '文件集' ("两边都是 {0} 个：{1}" -f $liveNames.Count, ($liveNames -join '、'))
  }
  else {
    $bits = @()
    if ($missing.Count) { $bits += "kit 缺 $($missing.Count) 个：$($missing -join '、')" }
    if ($extra.Count) { $bits += "kit 多 $($extra.Count) 个：$($extra -join '、')" }
    Report-Drift '文件集' ("kit {0} 个 / 现场 {1} 个；{2}" -f $kitNames.Count, $liveNames.Count, ($bits -join '；'))
  }
}

# 判据 2：四键
function Test-WorkflowHeaderKeys {
  $keys = @('触发', '不触发', '前置产物', '产出物')
  $files = @(Get-WorkflowNames $KitWorkflows)
  if ($files.Count -eq 0) {
    Report-Drift '四键说明' 'kit 的 workflows 目录是空的，无从校验'
    return
  }

  $bad = @()
  foreach ($name in $files) {
    $path = Join-Path $KitWorkflows $name
    $lines = @([IO.File]::ReadAllLines($path, [Text.Encoding]::UTF8) | Select-Object -First 12)
    $head = $lines -join "`n"
    $miss = @($keys | Where-Object { $head -notmatch ("(?m)^\s*" + $_ + "\s*[:：]") })
    if ($miss.Count) { $bad += ("{0} 缺 {1}" -f $name, ($miss -join '/')) }
  }

  if ($bad.Count -eq 0) {
    Report-Ok '四键说明' ("{0}/{0} 个流程都含 触发/不触发/前置产物/产出物" -f $files.Count)
  }
  else {
    Report-Drift '四键说明' ("{0}/{1} 不合规：{2}" -f $bad.Count, $files.Count, ($bad -join '；'))
  }
}

# 判据 3：私有信息
function Test-PrivateLeaks {
  $patterns = @()
  if ($env:USERNAME) {
    $patterns += @{ p = [regex]::Escape($env:USERNAME); label = '用户名' }
  }
  # 只认反斜杠形态的绝对路径；正斜杠 + YOUR_USERNAME 的模板写法属于占位符，不算泄露。
  $patterns += @{ p = '[A-Za-z]:\\Users\\'; label = '用户目录绝对路径' }
  $patterns += @{ p = '[A-Za-z]:\\workspace\\work'; label = '工作目录绝对路径' }

  $textExts = @('.md', '.ps1', '.mjs', '.js', '.json', '.example', '.txt', '.yml', '.yaml', '.toml')
  $files = @(Get-ChildItem -LiteralPath $KitRoot -Recurse -File -Force |
      Where-Object {
        $_.FullName -notlike '*\.git\*' -and
        $_.FullName -notlike '*\node_modules\*' -and
        ($textExts -contains $_.Extension.ToLower())
      })

  $hits = @()
  foreach ($f in $files) {
    $text = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8)
    foreach ($pat in $patterns) {
      $n = [regex]::Matches($text, $pat.p).Count
      if ($n -gt 0) {
        $rel = $f.FullName.Substring($KitRoot.Length).TrimStart('\', '/')
        $hits += ("{0} ×{1}（{2}）" -f $rel, $n, $pat.label)
      }
    }
  }

  if ($hits.Count -eq 0) {
    Report-Ok '私有信息' ("扫了 {0} 个文本文件，未令牌化的用户名 / 用户目录 / 工作目录 0 处" -f $files.Count)
  }
  else {
    Report-Drift '私有信息' ("{0} 处待令牌化：{1}" -f $hits.Count, ($hits -join '；'))
  }
}

# ---------------------------------------------------------------- Apply

function Invoke-Apply {
  if (-not (Test-Path -LiteralPath $LiveWorkflows)) {
    Write-Host "错误：现场 workflows 目录不存在：$LiveWorkflows"
    exit 2
  }
  if (-not (Test-Path -LiteralPath $KitWorkflows)) {
    New-Item -ItemType Directory -Force -Path $KitWorkflows | Out-Null
  }

  $names = Get-WorkflowNames $LiveWorkflows
  foreach ($name in $names) {
    $src = Join-Path $LiveWorkflows $name
    $dst = Join-Path $KitWorkflows $name
    $text = Convert-ToKitText ([IO.File]::ReadAllText($src, [Text.Encoding]::UTF8))

    if (Test-Path -LiteralPath $dst) {
      $old = [IO.File]::ReadAllText($dst, [Text.Encoding]::UTF8)
      if ($old -eq $text) {
        Write-Host ("SKIP   {0}  内容一致" -f $name)
        continue
      }
      [IO.File]::WriteAllText($dst, $text, $Utf8NoBom)
      Write-Host ("UPDATE {0}  已按令牌化重写" -f $name)
    }
    else {
      [IO.File]::WriteAllText($dst, $text, $Utf8NoBom)
      Write-Host ("NEW    {0}  新增" -f $name)
    }
  }

  $kitNames = Get-WorkflowNames $KitWorkflows
  $extra = @($kitNames | Where-Object { $names -notcontains $_ })
  if ($extra.Count) {
    Write-Host ("WARN   kit 里多出 {0} 个现场没有的文件：{1} → 确认是旧流程就挪进归档，不要留在 config\workflows" -f $extra.Count, ($extra -join '、'))
  }

  Write-Host ''
  Write-Host '提醒：-Apply 只同步 config\workflows\；以下需人工改，脚本不动：'
  Write-Host '  - config\AGENTS.md            总纲与门禁的正文'
  Write-Host '  - config\opencode.json.example 若流程文件名出现在配置里'
  Write-Host '  - README.md / PROMPT.md / docs\ 流程个数与名称的描述'
  Write-Host ''
}

# ---------------------------------------------------------------- 主流程

if ($Apply) { Invoke-Apply }

Test-WorkflowFileSet
Test-WorkflowHeaderKeys
Test-PrivateLeaks

Write-Host ''
Write-Host ("DRIFT={0}" -f $script:Drift)
if ($script:Drift -eq 0) { exit 0 } else { exit 1 }
