; Steps electron-builder's Windows installer runs beside its own.

; The pragma: link scheme leaves with the app that registered it. The app
; writes the key at each launch as `"<exe>" -- "%1"`, so the key is this
; install's only while its command starts with this install's quoted exe.
; An update keeps it: the new copy registers it again at its next launch.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ReadRegStr $0 HKCU "Software\Classes\pragma\shell\open\command" ""
    StrCpy $1 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
    StrLen $2 $1
    StrCpy $3 $0 $2
    ${if} $3 == $1
      DeleteRegKey HKCU "Software\Classes\pragma"
    ${endIf}
  ${endIf}
!macroend
