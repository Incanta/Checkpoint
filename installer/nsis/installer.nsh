; installer.nsh: NSIS custom script for Checkpoint installer.
; Lays down the daemon, tray, and CLI binaries, registers tray autostart, and
; cleans up on uninstall.
;
; The daemon is NOT installed as a Windows service. It is a portable Node.js
; runtime (checkpoint-daemon.exe) running daemon-bundle.cjs, a plain console app
; that cannot satisfy the Service Control Manager, so `sc.exe` registration
; produced "error 1053: the service did not respond". Instead the
; tray (auto-started on login) launches and supervises the daemon as a per-user
; process, which also matches the daemon's per-user data model (~/.checkpoint).
;
; IMPORTANT: this logic MUST live in the customInstall / customUnInstall macros,
; not standalone Section blocks. electron-builder includes this file before its
; own main install Section, so any Section we declare here would run BEFORE
; electron-builder removes the previously installed version, and the old
; uninstaller would then clobber our setup. The macros run at the right point:
; customInstall after the old version is removed and new files are extracted,
; customUnInstall during uninstall.

!include "LogicLib.nsh"

!macro customInstall
    ; Kill any running Checkpoint processes first. Without this, in-place
    ; upgrades fail with "file in use" because the running binaries hold locks
    ; on the files we're replacing.
    nsExec::ExecToLog 'taskkill /f /im Checkpoint.exe'
    nsExec::ExecToLog 'taskkill /f /im checkpoint-tray.exe'
    nsExec::ExecToLog 'taskkill /f /im checkpoint-daemon.exe'
    Sleep 1000

    ; ---- Daemon binaries (launched by the tray, not a service) ----
    SetOutPath "$INSTDIR\daemon"
    File /r "${BUILD_RESOURCES_DIR}\daemon\*.*"

    ; ---- Tray application ----
    SetOutPath "$INSTDIR\tray"
    File "${BUILD_RESOURCES_DIR}\tray\checkpoint-tray.exe"

    ; Register tray auto-start on login. The tray starts the daemon.
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" \
        "CheckpointTray" '"$INSTDIR\tray\checkpoint-tray.exe"'

    ; Launch the tray now (it will start the daemon).
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
    ; Stop the tray and daemon processes.
    nsExec::ExecToLog 'taskkill /f /im checkpoint-tray.exe'
    nsExec::ExecToLog 'taskkill /f /im checkpoint-daemon.exe'
    Sleep 500

    ; Remove tray auto-start.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CheckpointTray"

    ; ---- Remove installed files ----
    RMDir /r "$INSTDIR\daemon"

    Delete "$INSTDIR\tray\checkpoint-tray.exe"
    RMDir "$INSTDIR\tray"

    EnVar::DeleteValue "PATH" "$INSTDIR\cli"
    Delete "$INSTDIR\cli\checkpoint.exe"
    Delete "$INSTDIR\cli\chk.exe"
    RMDir "$INSTDIR\cli"
!macroend
