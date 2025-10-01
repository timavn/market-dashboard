# Simple S3 upload script using .NET AWS SDK
# This doesn't require AWS CLI to be installed

param(
    [string]$BucketName = "market-dashboard-bucket",
    [string]$Region = "us-east-1"
)

# Install AWS SDK for .NET if not already installed
if (-not (Get-Module -Name AWSPowerShell -ListAvailable)) {
    Write-Host "Installing AWS PowerShell module..."
    Install-Module -Name AWSPowerShell -Force -Scope CurrentUser
}

# Import the module
Import-Module AWSPowerShell

Write-Host "Uploading files to S3 bucket: $BucketName"

# Upload all files from build directory
$buildPath = ".\build\"
$files = Get-ChildItem -Path $buildPath -Recurse -File

foreach ($file in $files) {
    $relativePath = $file.FullName.Substring((Resolve-Path $buildPath).Path.Length + 1)
    $s3Key = $relativePath.Replace("\", "/")
    
    Write-Host "Uploading: $s3Key"
    
    try {
        Write-S3Object -BucketName $BucketName -Key $s3Key -File $file.FullName -Region $Region
    }
    catch {
        Write-Error "Failed to upload $s3Key : $($_.Exception.Message)"
    }
}

Write-Host "Upload completed!"
Write-Host "Your website URL: http://$BucketName.s3-website-$Region.amazonaws.com"

