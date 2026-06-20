; installer.nsh: NSIS custom script for Checkpoint installer.
; Handles daemon service registration, CLI PATH setup, tray autostart, and
; cleanup.
;
; IMPORTANT: this logic MUST live in the customInstall / customUnInstall macros,
; not in standalone Section blocks. electron-builder includes this file before
; its own main install Section, so any Section we declare here runs BEFORE
; electron-builder removes the previously installed version. On a reinstall or
; upgrade that means the old uninstaller runs *after* our setup and clobbers it
; (deletes the service, kills the tray, removes the autostart key). The macros
; are invoked by electron-builder at the right point: customInstall after the
; old version is removed and new files are extracted, customUnInstall during
; uninstall.

!include "LogicLib.nsh"

!macro customInstall
    ; Kill any running Electron desktop + tray processes first. Without this,
    ; in-place upgrades fail with "file in use" because the running .exe holds
    ; file locks on its own image and on the bundled binaries we're replacing.
    nsExec::ExecToLog 'taskkill /f /im Checkpoint.exe'
    nsExec::ExecToLog 'taskkill /f /im checkpoint-tray.exe'
    Sleep 1000

    ; ---- Daemon service ----
    SetOutPath "$INSTDIR\daemon"
    File /r "${BUILD_RESOURCES_DIR}\daemon\*.*"

    ; Replace any existing service (also self-heals if the old uninstaller did
    ; not run for some reason).
    nsExec::ExecToLog 'sc.exe stop CheckpointDaemon'
    Sleep 2000
    nsExec::ExecToLog 'sc.exe delete CheckpointDaemon'
    Sleep 1000

    nsExec::ExecToLog 'sc.exe create CheckpointDaemon binPath= "$INSTDIR\daemon\checkpoint-daemon.exe" DisplayName= "Checkpoint VCS Daemon" start= auto'
    nsExec::ExecToLog 'sc.exe description CheckpointDaemon "Checkpoint version control system daemon"'
    nsExec::ExecToLog 'sc.exe failure CheckpointDaemon reset= 86400 actions= restart/5000/restart/10000/restart/30000'
    nsExec::ExecToLog 'sc.exe start CheckpointDaemon'

    ; ---- Tray application ----
    SetOutPath "$INSTDIR\tray"
    File "${BUILD_RESOURCES_DIR}\tray\checkpoint-tray.exe"

    ; Register tray auto-start on login.
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" \
        "CheckpointTray" '"$INSTDIR\tray\checkpoint-tray.exe"'

    ; Launch tray now.
    Exec '"$INSTDIR\tray\checkpoint-tray.exe"'

    ; ---- CLI tools ----
    SetOutPath "$INSTDIR\cli"
    File "${BUILD_RESOURCES_DIR}\cli\checkpoint.exe"
    File "${BUILD_RESOURCES_DIR}\cli\chk.exe"

    ; Add CLI directory to user PATH.
    EnVar::AddValue "PATH" "$INSTDIR\cli"
    Pop $0
    ${If} $0 != 0
        DetailPrint "Warning: Could not add CLI to PATH (error: $0)"
    ${EndIf}
!macroend

!macro customUnInstall
    ; ---- Daemon service ----
    nsExec::ExecToLog 'sc.exe stop CheckpointDaemon'
    Sleep 2000
    nsExec::ExecToLog 'sc.exe delete CheckpointDaemon'
    RMDir /r "$INSTDIR\daemon"

    ; ---- Tray application ----
    nsExec::ExecToLog 'taskkill /f /im checkpoint-tray.exe'
    Sleep 500
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CheckpointTray"
    Delete "$INSTDIR\tray\checkpoint-tray.exe"
    RMDir "$INSTDIR\tray"

    ; ---- CLI tools ----
    EnVar::DeleteValue "PATH" "$INSTDIR\cli"
    Delete "$INSTDIR\cli\checkpoint.exe"
    Delete "$INSTDIR\cli\chk.exe"
    RMDir "$INSTDIR\cli"
!macroend
