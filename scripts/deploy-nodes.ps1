# deploy-nodes.ps1 — 批量部署节点 Pages 项目
# 用法：
#   $env:NT_TOKEN_v1n3 = "cfxxx..."   # 各节点账号 token
#   $env:NT_TOKEN_v1n4 = "cfxxx..."
#   ...
#   .\scripts\deploy-nodes.ps1
#
# 也可以一次性设好所有 token 再跑：
#   & { $env:NT_TOKEN_v1n3="..."; $env:NT_TOKEN_v1n4="..."; .\scripts\deploy-nodes.ps1 }
#
# 跳过节点：在 token 环境变量留空即跳过该节点，无需修改脚本。
# v2n1 已从列表中移除，永不部署。
#
# 前置条件：
#   - 已运行 npm run build（dist/_worker.node.js 存在）
#   - 安装了 wrangler（npx wrangler 或全局）

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

# ---- 节点列表（v2n1 已排除） ----
$NODES = @(
    [PSCustomObject]@{ id='v1n3';  accountId='b60f836c410dbc16fd7d64f80a956f07'; project='syfegiwe';    host='v1n3.11676767.xyz' }
    [PSCustomObject]@{ id='v1n4';  accountId='0af4ccf46198f908bc76828bb67db895'; project='djawukfe';    host='v1n4.11676767.xyz' }
    [PSCustomObject]@{ id='v1n6';  accountId='def9791efede1767103bec5cc422d461'; project='gsavdsg';     host='v1n6.11676767.xyz' }
    [PSCustomObject]@{ id='v2n2';  accountId='77eb544e53db57bbd1e94136cea37273'; project='checkyourcpu'; host='v2n2.11676767.xyz' }
    [PSCustomObject]@{ id='v2n4';  accountId='6e10be1d5ad37b750df3b1ed86286e1a'; project='ahkbew';      host='v2n4.11676767.xyz' }
    [PSCustomObject]@{ id='v2n5';  accountId='109673a1ddfa9e3f9b635190dd902437'; project='h8ouhug';     host='v2n5.11676767.xyz' }
    [PSCustomObject]@{ id='v2n6';  accountId='7387e8ac14918b4b65e056b442c8c287'; project='jhbsvhkwvk';  host='v2n6.11676767.xyz' }
)

# ---- 检查构建产物 ----
$WORKER_JS = Join-Path $PSScriptRoot '..\dist\_worker.node.js'
$WORKER_JS = [System.IO.Path]::GetFullPath($WORKER_JS)
if (-not (Test-Path $WORKER_JS)) {
    Write-Error "找不到构建产物：$WORKER_JS`n请先运行 npm run build"
    exit 1
}
Write-Host "构建产物：$WORKER_JS" -ForegroundColor Cyan

# ---- 准备临时部署目录 ----
$DEPLOY_DIR = Join-Path $env:TEMP 'nt-node-deploy'
if (Test-Path $DEPLOY_DIR) { Remove-Item $DEPLOY_DIR -Recurse -Force }
New-Item -ItemType Directory -Path $DEPLOY_DIR | Out-Null
Copy-Item $WORKER_JS (Join-Path $DEPLOY_DIR '_worker.js')
Write-Host "部署目录：$DEPLOY_DIR`n" -ForegroundColor Cyan

# ---- 统计 ----
$ok = 0; $skipped = 0; $failed = 0

foreach ($node in $NODES) {
    $tokenVar = "NT_TOKEN_$($node.id)"
    $token = [System.Environment]::GetEnvironmentVariable($tokenVar)

    if ([string]::IsNullOrWhiteSpace($token)) {
        Write-Host "[$($node.id)]  跳过（未设置 `$$tokenVar）" -ForegroundColor Yellow
        $skipped++
        continue
    }

    Write-Host "[$($node.id)]  → $($node.project) ($($node.host))" -ForegroundColor Cyan

    $env:CLOUDFLARE_API_TOKEN = $token
    $env:CLOUDFLARE_ACCOUNT_ID = $node.accountId

    $result = npx wrangler pages deploy $DEPLOY_DIR `
        --project-name $node.project `
        --branch production `
        2>&1

    # 清理敏感环境变量
    Remove-Item Env:\CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:\CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue

    if ($LASTEXITCODE -eq 0) {
        Write-Host "[$($node.id)]  ✓ 部署成功" -ForegroundColor Green
        $ok++
    } else {
        Write-Host "[$($node.id)]  ✗ 部署失败（exit $LASTEXITCODE）" -ForegroundColor Red
        Write-Host ($result | Out-String) -ForegroundColor DarkRed
        $failed++
    }
    Write-Host ''
}

# ---- 清理临时目录 ----
Remove-Item $DEPLOY_DIR -Recurse -Force -ErrorAction SilentlyContinue

# ---- 汇总 ----
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "部署完成：成功 $ok / 跳过 $skipped / 失败 $failed" -ForegroundColor $(if ($failed -gt 0) { 'Red' } elseif ($ok -gt 0) { 'Green' } else { 'Yellow' })
if ($failed -gt 0) { exit 1 }
