' yt-dlp Web UI launcher (VBS, ASCII-only)
' Starts the local server silently, opens the browser automatically.
' Strategy: write a temporary .cmd launcher, then run it in a visible window
' (the console window must stay open while the service runs).
Option Explicit
Dim BASE, PORT, ws, fso, batPath, bat, cmd

BASE = Replace(WScript.ScriptFullName, WScript.ScriptName, "")
PORT = "8731"
batPath = BASE & "_run_server.cmd"

Set ws  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Check yt-dlp exists (exe or extensionless)
If Not (fso.FileExists(BASE & "yt-dlp.exe") Or fso.FileExists(BASE & "yt-dlp")) Then
    If Not InStr(ws.Environment("PROCESS")("PATH"), "yt-dlp") > 0 Then
        MsgBox "yt-dlp not found in:" & vbCrLf & BASE & vbCrLf & _
               "Download it from https://github.com/yt-dlp/yt-dlp/releases", _
               vbCritical, "Error"
        WScript.Quit 1
    End If
End If

' Build the temp .cmd file (ASCII only; avoids all codepage issues)
Set bat = fso.CreateTextFile(batPath, True)
bat.WriteLine "@echo off"
bat.WriteLine "title yt-dlp Download Service"
bat.WriteLine "echo ============================================================"
bat.WriteLine "echo   yt-dlp download UI is starting..."
bat.WriteLine "echo   Open in browser:  http://127.0.0.1:" & PORT
bat.WriteLine "echo   Save directory:   " & BASE
bat.WriteLine "echo   Keep this window OPEN. Close it to stop the service."
bat.WriteLine "echo ============================================================"
bat.WriteLine "echo."
bat.WriteLine "node """ & BASE & "server.js"""
bat.WriteLine "echo."
bat.WriteLine "echo [Service stopped] Press any key to close."
bat.WriteLine "pause >nul"
bat.Close

' Open the browser shortly after the server boots (fire-and-forget)
ws.Run "cmd.exe /c ping -n 3 127.0.0.1 >nul & start http://127.0.0.1:" & PORT, 0, False

' Launch the persistent console window running Node in foreground
cmd = "cmd.exe /k """ & batPath & """"
ws.Run cmd, 1, False

WScript.Quit 0
