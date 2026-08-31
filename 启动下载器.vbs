' Autosub Video Downloader - desktop launcher (silent, no console)
' Double-click = start the service (tray mode) then open the Web UI.
' The tray icon stays in the system tray; right-click it for menu.
Option Explicit
Dim base, ws, ok, i

base = Replace(WScript.ScriptFullName, WScript.ScriptName, "")
Set ws = CreateObject("WScript.Shell")

' 1) start service in tray mode (hidden, server + tray icon)
ws.Run "wscript.exe """ & base & "tray.vbs""", 0, False

' 2) wait until the local UI answers (max ~10s), then open it
ok = False
For i = 1 To 20
    WScript.Sleep 500
    If HttpOk("http://127.0.0.1:8731/") Then
        ok = True
        Exit For
    End If
Next

If ok Then
    ws.Run "http://127.0.0.1:8731/", 1, False
Else
    MsgBox "The downloader did not start in time." & vbCrLf & _
           "Check node.exe / yt-dlp.exe exist in:" & vbCrLf & base, _
           vbExclamation, "Autosub Video Downloader"
End If

Function HttpOk(url)
    On Error Resume Next
    Dim x
    Set x = CreateObject("MSXML2.XMLHTTP")
    x.open "GET", url, False
    x.send
    HttpOk = (x.status = 200)
    Set x = Nothing
    On Error GoTo 0
End Function
