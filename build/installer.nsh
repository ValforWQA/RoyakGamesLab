!macro customHeader
  BrandingText "RoyakGamesLab"
!macroend

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to RoyakGamesLab"
  !define MUI_WELCOMEPAGE_TEXT "This setup will install RoyakGamesLab on your computer.$\r$\n$\r$\nChoose where you want the launcher installed, then continue to begin setup."
  !insertmacro MUI_PAGE_WELCOME
!macroend


!macro customInstall
  ; Keep native game runtimes out of normal Explorer views.
  ; These resources must remain on disk because Electron/Flash loads native binaries from file paths.
  nsExec::ExecToLog 'cmd /c attrib +h +s "$INSTDIR\resources\runtime"'
  nsExec::ExecToLog 'cmd /c attrib +h +s "$INSTDIR\resources\client"'
  nsExec::ExecToLog 'cmd /c if exist "$INSTDIR\resources\app.asar.unpacked" attrib +h +s "$INSTDIR\resources\app.asar.unpacked"'
!macroend
