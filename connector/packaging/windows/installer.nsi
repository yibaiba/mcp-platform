Unicode true
!include "MUI2.nsh"
!include "x64.nsh"

Name "${APP_NAME}"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\MCP Platform Connector"
InstallDirRegKey HKCU "Software\${APP_ID}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
Icon "${APP_ICON}"
UninstallIcon "${APP_ICON}"
VIProductVersion "${APP_NUMERIC_VERSION}.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "FileDescription" "MCP Platform Connector Setup"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "MCP Platform contributors"

!define MUI_ABORTWARNING
!define MUI_ICON "${APP_ICON}"
!define MUI_UNICON "${APP_ICON}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\mcplatform-connector.exe"
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "This application requires 64-bit Windows (x64 or ARM64)."
    Abort
  ${EndIf}
  SetRegView 64
  SetShellVarContext current
  ReadRegStr $0 HKCU "Software\${APP_ID}" "InstallLocation"
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${EndIf}
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  ClearErrors
  ${If} ${IsNativeARM64}
    File /oname=mcplatform-connector.exe "${PAYLOAD_DIR}/connector-desktop-windows-arm64.exe"
  ${ElseIf} ${IsNativeAMD64}
    File /oname=mcplatform-connector.exe "${PAYLOAD_DIR}/connector-desktop-windows-amd64.exe"
  ${Else}
    MessageBox MB_ICONSTOP "Unsupported processor architecture."
    Abort
  ${EndIf}
  File /oname=connector.ico "${APP_ICON}"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  ${If} ${Errors}
    MessageBox MB_ICONSTOP "Installation failed. Close the connector, then run Setup again."
    Abort
  ${EndIf}
  CreateDirectory "$SMPROGRAMS\MCP Platform Connector"
  CreateShortcut "$SMPROGRAMS\MCP Platform Connector\MCP Platform Connector.lnk" "$INSTDIR\mcplatform-connector.exe" "" "$INSTDIR\connector.ico"
  CreateShortcut "$SMPROGRAMS\MCP Platform Connector\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\MCP Platform Connector.lnk" "$INSTDIR\mcplatform-connector.exe" "" "$INSTDIR\connector.ico"
  WriteRegStr HKCU "Software\${APP_ID}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayIcon" "$INSTDIR\connector.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "NoRepair" 1
  ${If} ${Errors}
    MessageBox MB_ICONSTOP "Files were copied, but shortcuts or registration failed. Run Setup again."
    Abort
  ${EndIf}
SectionEnd

Function un.onInit
  SetRegView 64
  SetShellVarContext current
FunctionEnd

Section "Uninstall"
  ClearErrors
  Delete "$INSTDIR\mcplatform-connector.exe"
  ${If} ${Errors}
    MessageBox MB_ICONSTOP "Close the connector before uninstalling."
    Abort
  ${EndIf}
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
  ${If} $0 == '"$INSTDIR\mcplatform-connector.exe" --mygo-opened-at-login'
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${APP_ID}"
  ${EndIf}
  Delete "$DESKTOP\MCP Platform Connector.lnk"
  Delete "$SMPROGRAMS\MCP Platform Connector\MCP Platform Connector.lnk"
  Delete "$SMPROGRAMS\MCP Platform Connector\Uninstall.lnk"
  RMDir "$SMPROGRAMS\MCP Platform Connector"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"
  DeleteRegKey HKCU "Software\${APP_ID}"
  Delete "$INSTDIR\connector.ico"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
