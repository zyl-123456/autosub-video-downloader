' Autosub Downloader - tray launcher (silent, no window)
' Runs tray.ps1 hidden via wscript so NO console window ever appears.
Option Explicit
Dim Base, ws, cmd
Base = Replace(WScript.ScriptFullName, WScript.ScriptName, "")
Set ws = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & Base & "tray.ps1"""
ws.Run cmd, 0, False
