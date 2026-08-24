# ============================================================================
# Autosub Video Downloader - System Tray Mode
# Runs server.js silently in background (no console window), shows a tray
# icon: double-click to open the Web UI, right-click for menu (quit stops
# the node child process too).
# Launch via:  wscript.exe tray.vbs   (silent, recommended)
#   or:        powershell -NoProfile -ExecutionPolicy Bypass -File tray.ps1
# ============================================================================
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Base = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---- locate node: local node.exe > PATH ----
$NodeExe = $null
$localNode = Join-Path $Base 'node.exe'
if (Test-Path $localNode) { $NodeExe = $localNode }
if (-not $NodeExe) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $NodeExe = $cmd.Source }
}
if (-not $NodeExe) {
    [System.Windows.Forms.MessageBox]::Show(
        'node.exe not found.' + [Environment]::NewLine +
        'Put node.exe in the project folder, or install Node.js and retry.',
        'Autosub Downloader', 'OK', 'Error') | Out-Null
    exit 1
}

$Port = 8731
$UiUrl = "http://127.0.0.1:$Port"

# ---- if port already listening, adopt it instead of starting a second one ----
$portBusy = $false
try {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conn) { $portBusy = $true }
} catch { }

$serverProc = $null
if (-not $portBusy) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $NodeExe
    $psi.Arguments = '"' + (Join-Path $Base 'server.js') + '"'
    $psi.WorkingDirectory = $Base
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $serverProc = [System.Diagnostics.Process]::Start($psi)
    $serverProc.BeginOutputReadLine()
    $serverProc.BeginErrorReadLine()
}

# ---- tray icon ----
$iconPath = Join-Path $Base 'tray-icon32.png'
$bmp = New-Object System.Drawing.Bitmap($iconPath)
$icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $icon
$notify.Text = 'Autosub Video Downloader (click to open UI)'
$notify.Visible = $true

function Open-Ui { Start-Process $UiUrl }

# ---- autostart via HKCU Run key ----
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'AutosubVideoDownloader'
$vbsPath = Join-Path $Base 'tray.vbs'
function Get-AutoStart { (Get-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue) -ne $null }
function Set-AutoStart([bool]$on) {
    if ($on) { Set-ItemProperty -Path $runKey -Name $runName -Value ('wscript.exe "' + $vbsPath + '"') }
    else { Remove-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue }
}

# ---- context menu ----
$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miOpen = New-Object System.Windows.Forms.ToolStripMenuItem('Open Web UI')
$miOpen.add_Click({ Open-Ui })
$menu.Items.Add($miOpen) | Out-Null

$miFolder = New-Object System.Windows.Forms.ToolStripMenuItem('Open download folder')
$miFolder.add_Click({ Start-Process explorer.exe $Base })
$menu.Items.Add($miFolder) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miAuto = New-Object System.Windows.Forms.ToolStripMenuItem('Start with Windows')
$miAuto.CheckOnClick = $true
$miAuto.Checked = Get-AutoStart
$miAuto.add_Click({ Set-AutoStart $miAuto.Checked })
$menu.Items.Add($miAuto) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miExit = New-Object System.Windows.Forms.ToolStripMenuItem('Quit (stop service)')
$miExit.add_Click({
    $script:notify.Visible = $false
    if ($script:serverProc -and -not $script:serverProc.HasExited) {
        Stop-Process -Id $script:serverProc.Id -Force -ErrorAction SilentlyContinue
    }
    [System.Windows.Forms.Application]::Exit()
})
$menu.Items.Add($miExit) | Out-Null

$notify.ContextMenuStrip = $menu
$notify.add_DoubleClick({ Open-Ui })
$notify.add_Click({ Open-Ui })

$notify.ShowBalloonTip(2000, 'Autosub Video Downloader', "Running in background - UI: $UiUrl", 'Info')

# ---- message loop ----
[System.Windows.Forms.Application]::Run($notify)

# cleanup
$bmp.Dispose(); $icon.Dispose(); $notify.Dispose()
