; RoyakGamesLab branded assisted installer
; Keeps electron-builder's maintained installer logic while adding a branded welcome flow.

!macro customInstallMode
  ; Keep the installer simple: Welcome -> Install Location -> Install -> Finish.
  ; This avoids the extra per-user/per-machine choice page.
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to RoyakGamesLab"
  !define MUI_WELCOMEPAGE_TEXT "Install the RoyakGamesLab game launcher on this PC.$\r$\n$\r$\nThe setup will guide you through choosing an installation folder and installing the launcher.$\r$\n$\r$\nClick Continue to begin."
  !define MUI_WELCOMEPAGE_BUTTON_TEXT "Continue"
  !insertmacro MUI_PAGE_WELCOME
!macroend

; Do not place BrandingText inside customInit. electron-builder expands customInit
; inside the NSIS .onInit function, where BrandingText is not valid.
; The installer remains branded through productName, icons, header/sidebar art,
; and the custom welcome page below.
