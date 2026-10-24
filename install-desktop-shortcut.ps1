$link = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Ramrattan Canvas.lnk'
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($link)
$shortcut.TargetPath = Join-Path $PSScriptRoot 'launch-canvas.cmd'
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.Description = 'Start the local Ramrattan Canvas board and open it in a browser'
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,21"
$shortcut.Save()
Write-Host "Created desktop shortcut: $link"
