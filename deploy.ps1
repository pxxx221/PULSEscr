# Deployment automation script
$root = $PSScriptRoot
$node = "C:\Users\Игорь Бугаенко\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$vite = Join-Path $root "node_modules\vite\bin\vite.js"
$dist = Join-Path $root "dist"

Write-Host "1. Building production bundle..."
& $node $vite build --configLoader runner
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "2. Adding 404 SPA fallback..."
Copy-Item (Join-Path $dist "index.html") (Join-Path $dist "404.html") -Force

Write-Host "3. Pushing source code to main..."
Set-Location $root
git add -A
git commit -m "Update screener source code" -ErrorAction SilentlyContinue
git push origin main

Write-Host "4. Deploying live build to gh-pages..."
Set-Location $dist
git add -A
git commit -m "Deploy latest build to GitHub Pages" -ErrorAction SilentlyContinue
git push origin gh-pages

Write-Host "Deployment completed successfully!"
