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
!include "FileFunc.nsh"

; URL for the Microsoft Visual C++ x64 Redistributable. This "aka.ms" permalink
; always resolves to the latest 14.x (VS 2015-2022) redist, whose runtime is
; backward compatible.
!define VCREDIST_URL "https://aka.ms/vs/17/release/vc_redist.x64.exe"

; Append a timestamped line to $INSTDIR\install.log.
;
; In-place updates run this installer with /S, where DetailPrint goes nowhere
; and a failed step leaves no trace at all: an upgrade that silently did not
; happen looked identical to one that did. This gives every install a record on
; disk regardless of how it was started, timestamped so it lines up with
; ~/.checkpoint/logs/daemon.log and tray.log.
;
; $3-$9 hold the GetTime output and $R9 the file handle, none of which the
; callers below use ($0-$2 and $R0-$R2).
!macro cpLog TEXT
    ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
    ClearErrors
    FileOpen $R9 "$INSTDIR\install.log" a
    ${IfNot} ${Errors}
        FileSeek $R9 0 END
        FileWrite $R9 "$5-$4-$3 $7:$8:$9  ${TEXT}$\r$\n"
        FileClose $R9
    ${EndIf}
!macroend

; Stop every Checkpoint process and wait until the daemon is really gone.
;
; Without this, in-place upgrades fail with "file in use" because the running
; binaries hold locks on the files we are replacing. The tray goes first and the
; daemon kill is retried, because the tray supervises the daemon and starts it
; again when it disappears: a single pass loses that race, and a daemon that
; comes back before the File commands run holds checkpoint-daemon.exe open,
; which fails the extraction with no visible error under /S.
;
; taskkill answers 0 when it killed something and 128 when there was nothing
; left to kill, so "nothing to kill" is the exit condition. UID makes the labels
; unique so the macro can be used from both install and uninstall.
!macro cpStopCheckpoint UID
    nsExec::ExecToLog 'taskkill /f /im Checkpoint.exe'
    Pop $R2
    nsExec::ExecToLog 'taskkill /f /im checkpoint-tray.exe'
    Pop $R2
    !insertmacro cpLog "stopped Checkpoint.exe / checkpoint-tray.exe"

    StrCpy $R0 0
    cp_kill_loop_${UID}:
        nsExec::ExecToLog 'taskkill /f /im checkpoint-daemon.exe'
        Pop $R1
        ${If} $R1 != 0
            !insertmacro cpLog "checkpoint-daemon.exe gone after $R0 kill pass(es)"
            Goto cp_kill_done_${UID}
        ${EndIf}
        IntOp $R0 $R0 + 1
        Sleep 1000
        ${If} $R0 < 10
            Goto cp_kill_loop_${UID}
        ${EndIf}
        !insertmacro cpLog "WARNING: checkpoint-daemon.exe still running after $R0 kill passes; file operations may fail"
    cp_kill_done_${UID}:
    Sleep 1000
!macroend

!macro customInstall
    CreateDirectory "$INSTDIR"
    !insertmacro cpLog "--- customInstall ${VERSION} ---"

    !insertmacro cpStopCheckpoint "install"

    ; ---- Ensure the Visual C++ x64 runtime is present ----
    ; The longtail addon (longtail_addon.node) and better-sqlite3 are MSVC-built
    ; native modules that dynamically link the Visual C++ runtime (vcruntime140.dll
    ; / msvcp140.dll). Without it the daemon crashes at startup with a cryptic
    ; "DLL not found", so check for the x64 runtime and, if missing, offer to
    ; download and install it before the tray launches the daemon.
    ;
    ; This is inlined rather than a separate Function: electron-builder's NSIS
    ; build treats warnings as errors, and a Function called only from an
    ; !insertmacro'd hook is reported as unreferenced (warning 6010), which fails
    ; the build. Returns are therefore Gotos to vcredist_done so they skip only
    ; the VC check, not the rest of customInstall.
    ;
    ; The x64 redist records itself in the 64-bit registry view; this installer is
    ; 32-bit, so switch views for the read, then switch back.
    SetRegView 64
    ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
    SetRegView 32

    ${If} $0 == 1
        DetailPrint "Visual C++ x64 Redistributable already installed."
        !insertmacro cpLog "vcredist: already installed"
        Goto vcredist_done
    ${EndIf}

    ; /SD matters here: an in-place update runs this installer with /S, and a
    ; MessageBox without a silent default is still displayed, so these prompts
    ; would hang an unattended upgrade behind a modal nobody is watching. The
    ; silent answers pick the same path an attentive user would.
    MessageBox MB_YESNO|MB_ICONQUESTION \
        "Checkpoint requires the Microsoft Visual C++ x64 Redistributable, which is not installed.$\n$\nDownload and install it now? Checkpoint will not run without it." \
        /SD IDYES \
        IDYES vcredist_download IDNO vcredist_skip

    vcredist_download:
        DetailPrint "Downloading Microsoft Visual C++ Redistributable..."
        ; Download with curl.exe, which ships in Windows 10 1803+ and Windows 11.
        ; This avoids depending on the INetC NSIS plugin, which is not part of
        ; electron-builder's bundled NSIS plugin set.
        nsExec::ExecToLog 'curl.exe -L --fail --silent --show-error -o "$PLUGINSDIR\vc_redist.x64.exe" "${VCREDIST_URL}"'
        Pop $1
        ${If} $1 != 0
            !insertmacro cpLog "WARNING: vcredist download failed (curl exit $1)"
            MessageBox MB_OK|MB_ICONEXCLAMATION \
                "Could not download the Visual C++ Redistributable (curl exit $1).$\n$\nInstall it manually from:$\n${VCREDIST_URL}$\n$\nCheckpoint will not start until it is installed." \
                /SD IDOK
            Goto vcredist_done
        ${EndIf}
        DetailPrint "Installing Microsoft Visual C++ Redistributable..."
        ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /passive /norestart' $2
        ; 0 = success; 3010 = success, reboot required; 1638 = newer already present.
        ${If} $2 != 0
        ${AndIf} $2 != 3010
        ${AndIf} $2 != 1638
            !insertmacro cpLog "WARNING: vcredist installer exited $2"
            MessageBox MB_OK|MB_ICONEXCLAMATION \
                "The Visual C++ Redistributable installer exited with code $2.$\n$\nIf Checkpoint fails to start, install it manually from:$\n${VCREDIST_URL}" \
                /SD IDOK
        ${EndIf}
        Goto vcredist_done

    vcredist_skip:
        !insertmacro cpLog "vcredist: declined by the user"
        MessageBox MB_OK|MB_ICONEXCLAMATION \
            "Skipped. Checkpoint requires the Visual C++ x64 Redistributable and will not start until it is installed.$\n$\nGet it from:$\n${VCREDIST_URL}" \
            /SD IDOK

    vcredist_done:

    ; ---- Daemon binaries (launched by the tray, not a service) ----
    !insertmacro cpLog "extracting daemon"
    SetOutPath "$INSTDIR\daemon"
    File /r "${BUILD_RESOURCES_DIR}\daemon\*.*"

    ; ---- Tray application ----
    !insertmacro cpLog "extracting tray"
    SetOutPath "$INSTDIR\tray"
    File "${BUILD_RESOURCES_DIR}\tray\checkpoint-tray.exe"

    ; Register tray auto-start on login. The tray starts the daemon.
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" \
        "CheckpointTray" '"$INSTDIR\tray\checkpoint-tray.exe"'

    ; ---- CLI tools ----
    !insertmacro cpLog "extracting cli"
    SetOutPath "$INSTDIR\cli"
    File "${BUILD_RESOURCES_DIR}\cli\checkpoint.exe"
    File "${BUILD_RESOURCES_DIR}\cli\chk.exe"

    ; Add CLI directory to user PATH.
    EnVar::AddValue "PATH" "$INSTDIR\cli"
    Pop $0
    ${If} $0 != 0
        DetailPrint "Warning: Could not add CLI to PATH (error: $0)"
        !insertmacro cpLog "WARNING: could not add the CLI to PATH (error $0)"
    ${EndIf}

    ; Launch the tray last: it starts the daemon straight away, and the daemon
    ; must not be holding files we are still extracting.
    !insertmacro cpLog "launching tray"
    Exec '"$INSTDIR\tray\checkpoint-tray.exe"'

    !insertmacro cpLog "customInstall finished"
!macroend

!macro customUnInstall
    !insertmacro cpLog "--- customUnInstall ---"

    ; Stop the tray and daemon. An in-place upgrade runs the old uninstaller
    ; before laying down the new files, so the same tray-restarts-the-daemon
    ; race that breaks extraction also breaks the RMDir below.
    !insertmacro cpStopCheckpoint "uninstall"

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
