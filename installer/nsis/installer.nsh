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

; URL for the Microsoft Visual C++ x64 Redistributable. This "aka.ms" permalink
; always resolves to the latest 14.x (VS 2015-2022) redist, whose runtime is
; backward compatible.
!define VCREDIST_URL "https://aka.ms/vs/17/release/vc_redist.x64.exe"

; EnsureVCRedist: the longtail addon (longtail_addon.node) and better-sqlite3
; are MSVC-built native modules that dynamically link the Visual C++ runtime
; (vcruntime140.dll / msvcp140.dll). Without that runtime the daemon crashes at
; startup with a cryptic "DLL not found". This checks for the x64 runtime and,
; if missing, offers to download and install it before the tray/daemon launch.
Function EnsureVCRedist
    ; The x64 redist records itself in the 64-bit registry view; this installer
    ; is 32-bit, so switch views for the read, then switch back.
    SetRegView 64
    ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
    SetRegView 32

    ${If} $0 == 1
        DetailPrint "Visual C++ x64 Redistributable already installed."
        Return
    ${EndIf}

    MessageBox MB_YESNO|MB_ICONQUESTION \
        "Checkpoint requires the Microsoft Visual C++ x64 Redistributable, which is not installed.$\n$\nDownload and install it now? Checkpoint will not run without it." \
        IDYES vcredist_download IDNO vcredist_skip

    vcredist_download:
        DetailPrint "Downloading Microsoft Visual C++ Redistributable..."
        ; Download with curl.exe, which ships in Windows 10 1803+ and Windows 11.
        ; This avoids depending on the INetC NSIS plugin, which is not part of
        ; electron-builder's bundled NSIS plugin set (makensis aborts with
        ; "Plugin not found, cannot call INetC::get" when it is referenced).
        nsExec::ExecToLog 'curl.exe -L --fail --silent --show-error \
            -o "$PLUGINSDIR\vc_redist.x64.exe" "${VCREDIST_URL}"'
        Pop $1
        ${If} $1 != 0
            MessageBox MB_OK|MB_ICONEXCLAMATION \
                "Could not download the Visual C++ Redistributable (curl exit $1).$\n$\nInstall it manually from:$\n${VCREDIST_URL}$\n$\nCheckpoint will not start until it is installed."
            Return
        ${EndIf}
        DetailPrint "Installing Microsoft Visual C++ Redistributable..."
        ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /passive /norestart' $2
        ; 0 = success; 3010 = success, reboot required; 1638 = newer already present.
        ${If} $2 != 0
        ${AndIf} $2 != 3010
        ${AndIf} $2 != 1638
            MessageBox MB_OK|MB_ICONEXCLAMATION \
                "The Visual C++ Redistributable installer exited with code $2.$\n$\nIf Checkpoint fails to start, install it manually from:$\n${VCREDIST_URL}"
        ${EndIf}
        Return

    vcredist_skip:
        MessageBox MB_OK|MB_ICONEXCLAMATION \
            "Skipped. Checkpoint requires the Visual C++ x64 Redistributable and will not start until it is installed.$\n$\nGet it from:$\n${VCREDIST_URL}"
FunctionEnd

!macro customInstall
    ; Kill any running Checkpoint processes first. Without this, in-place
    ; upgrades fail with "file in use" because the running binaries hold locks
    ; on the files we're replacing.
    nsExec::ExecToLog 'taskkill /f /im Checkpoint.exe'
    nsExec::ExecToLog 'taskkill /f /im checkpoint-tray.exe'
    nsExec::ExecToLog 'taskkill /f /im checkpoint-daemon.exe'
    Sleep 1000

    ; Ensure the Visual C++ runtime is present before the tray launches the
    ; daemon, which loads the native longtail addon and better-sqlite3.
    Call EnsureVCRedist

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
