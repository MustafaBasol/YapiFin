$ErrorActionPreference = "Stop"

$RepoUrl = "https://github.com/MustafaBasol/YapiFin.git"
$Branch = "main"

if (-not (Test-Path ".git")) {
  git init -b $Branch
}

git remote remove origin 2>$null
if ($LASTEXITCODE -ne 0) { $global:LASTEXITCODE = 0 }
git remote add origin $RepoUrl

git add -A
git status --short
git commit -m "chore: initialize YapiFin project"
git push -u origin $Branch

Write-Host "YapiFin repository published successfully." -ForegroundColor Green
