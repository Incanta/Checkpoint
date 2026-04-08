; installer.nsh — NSIS custom script for Checkpoint installer
; Handles daemon service registration, CLI PATH setup, and cleanup
;
; NOTE: This file is included by electron-builder BEFORE the main template,
; so we must explicitly include LogicLib for ${If}/${EndIf} macros.
; MUI2.nsh and nsDialogs.nsh are NOT needed here (loaded by the template).

!include "LogicLib.nsh"

; ============================================================
; Installation Sections (only for installer pass)
; ============================================================

!ifndef BUILD_UNINSTALLER

; Custom variables
Var DAEMON_EXE

Section "Daemon Service" SEC_DAEMON
    ; Copy daemon files
    SetOutPath "$INSTDIR\daemon"
    File /r "${BUILD_RESOURCES_DIR}\daemon\*.*"

    StrCpy $DAEMON_EXE "$INSTDIR\daemon\checkpoint-daemon.exe"

    ; Stop existing service if running
    nsExec::ExecToLog 'sc.exe stop CheckpointDaemon'
    Sleep 2000
    nsExec::ExecToLog 'sc.exe delete CheckpointDaemon'
    Sleep 1000

    ; Install as Windows Service running as current user
    nsExec::ExecToLog 'sc.exe create CheckpointDaemon binPath= "$DAEMON_EXE" DisplayName= "Checkpoint VCS Daemon" start= auto'
    nsExec::ExecToLog 'sc.exe description CheckpointDaemon "Checkpoint version control system daemon"'
    nsExec::ExecToLog 'sc.exe failure CheckpointDaemon reset= 86400 actions= restart/5000/restart/10000/restart/30000'

    ; Start the service
    nsExec::ExecToLog 'sc.exe start CheckpointDaemon'
SectionEnd

Section "Tray Application" SEC_TRAY
    ; Copy tray binary
    SetOutPath "$INSTDIR\tray"
    File "${BUILD_RESOURCES_DIR}\tray\checkpoint-tray.exe"

    ; Register tray auto-start on login
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" \
        "CheckpointTray" '"$INSTDIR\tray\checkpoint-tray.exe"'

    ; Launch tray now
    Exec '"$INSTDIR\tray\checkpoint-tray.exe"'
SectionEnd

Section "CLI Tools" SEC_CLI
    ; Copy CLI binaries
    SetOutPath "$INSTDIR\cli"
    File "${BUILD_RESOURCES_DIR}\cli\checkpoint.exe"
    File "${BUILD_RESOURCES_DIR}\cli\chk.exe"

    ; Add CLI directory to user PATH
    EnVar::AddValue "PATH" "$INSTDIR\cli"
    Pop $0
    ${If} $0 != 0
        DetailPrint "Warning: Could not add CLI to PATH (error: $0)"
    ${EndIf}
SectionEnd

!endif ; BUILD_UNINSTALLER

; ============================================================
; Uninstallation Sections (only for uninstaller build pass)
; ============================================================

!ifdef BUILD_UNINSTALLER

Section "un.Daemon Service"
    ; Stop and remove the Windows service
    nsExec::ExecToLog 'sc.exe stop CheckpointDaemon'
    Sleep 2000
    nsExec::ExecToLog 'sc.exe delete CheckpointDaemon'

    ; Remove daemon files
    RMDir /r "$INSTDIR\daemon"
SectionEnd

Section "un.Tray Application"
    ; Kill running tray process
    nsExec::ExecToLog 'taskkill /f /im checkpoint-tray.exe'
    Sleep 500

    ; Remove auto-start registry entry
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CheckpointTray"

    ; Remove tray files
    Delete "$INSTDIR\tray\checkpoint-tray.exe"
    RMDir "$INSTDIR\tray"
SectionEnd

Section "un.CLI Tools"
    ; Remove CLI directory from PATH
    EnVar::DeleteValue "PATH" "$INSTDIR\cli"

    ; Remove CLI files
    Delete "$INSTDIR\cli\checkpoint.exe"
    Delete "$INSTDIR\cli\chk.exe"
    RMDir "$INSTDIR\cli"
SectionEnd

!endif ; BUILD_UNINSTALLER
