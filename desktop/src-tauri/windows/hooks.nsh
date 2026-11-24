!macro NSIS_HOOK_PREINSTALL
  Push $0
  Push $1
  Push $2
  Push $3

  ReadRegStr $0 HKCU "${UNINSTKEY}" "InstallLocation"
  ReadRegStr $1 HKCU "${UNINSTKEY}" "UninstallString"

  ; 去掉舊安裝程式寫入的外層雙引號。
  StrCpy $2 $0 1
  StrCpy $3 $0 1 -1
  ${If} $2 == '"'
  ${AndIf} $3 == '"'
    StrLen $2 $0
    IntOp $2 $2 - 2
    StrCpy $0 $0 $2 1
  ${EndIf}
  StrCpy $2 $1 1
  StrCpy $3 $1 1 -1
  ${If} $2 == '"'
  ${AndIf} $3 == '"'
    StrLen $2 $1
    IntOp $2 $2 - 2
    StrCpy $1 $1 $2 1
  ${EndIf}

  ${If} $0 != ""
  ${AndIf} $0 != $INSTDIR
    ${If} ${FileExists} "$1"
      ClearErrors
      ExecWait '"$1" /S _?=$0' $3
      ${If} ${Errors}
        DetailPrint "Could not run the previous per-user uninstaller: $1"
      ${ElseIf} $3 != 0
        DetailPrint "Previous per-user uninstaller exited with code $3; continuing installation."
      ${Else}
        ; 原地執行解除安裝後,刪除留下的解除安裝程式與空目錄。
        Delete "$0\uninstall.exe"
        RMDir "$0"
      ${EndIf}
    ${Else}
      DetailPrint "Previous per-user uninstaller not found: $1; continuing installation."
    ${EndIf}
  ${EndIf}

  ClearErrors
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend
