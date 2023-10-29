"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorToString = exports.ErrorNumber = void 0;
var ErrorNumber;
(function (ErrorNumber) {
    ErrorNumber[ErrorNumber["EPERM"] = 1] = "EPERM";
    ErrorNumber[ErrorNumber["ENOENT"] = 2] = "ENOENT";
    ErrorNumber[ErrorNumber["ESRCH"] = 3] = "ESRCH";
    ErrorNumber[ErrorNumber["EINTR"] = 4] = "EINTR";
    ErrorNumber[ErrorNumber["EIO"] = 5] = "EIO";
    ErrorNumber[ErrorNumber["ENXIO"] = 6] = "ENXIO";
    ErrorNumber[ErrorNumber["E2BIG"] = 7] = "E2BIG";
    ErrorNumber[ErrorNumber["ENOEXEC"] = 8] = "ENOEXEC";
    ErrorNumber[ErrorNumber["EBADF"] = 9] = "EBADF";
    ErrorNumber[ErrorNumber["ECHILD"] = 10] = "ECHILD";
    ErrorNumber[ErrorNumber["EAGAIN"] = 11] = "EAGAIN";
    ErrorNumber[ErrorNumber["ENOMEM"] = 12] = "ENOMEM";
    ErrorNumber[ErrorNumber["EACCES"] = 13] = "EACCES";
    ErrorNumber[ErrorNumber["EFAULT"] = 14] = "EFAULT";
    ErrorNumber[ErrorNumber["EBUSY"] = 16] = "EBUSY";
    ErrorNumber[ErrorNumber["EEXIST"] = 17] = "EEXIST";
    ErrorNumber[ErrorNumber["EXDEV"] = 18] = "EXDEV";
    ErrorNumber[ErrorNumber["ENODEV"] = 19] = "ENODEV";
    ErrorNumber[ErrorNumber["ENOTDIR"] = 20] = "ENOTDIR";
    ErrorNumber[ErrorNumber["EISDIR"] = 21] = "EISDIR";
    ErrorNumber[ErrorNumber["ENFILE"] = 23] = "ENFILE";
    ErrorNumber[ErrorNumber["EMFILE"] = 24] = "EMFILE";
    ErrorNumber[ErrorNumber["ENOTTY"] = 25] = "ENOTTY";
    ErrorNumber[ErrorNumber["EFBIG"] = 27] = "EFBIG";
    ErrorNumber[ErrorNumber["ENOSPC"] = 28] = "ENOSPC";
    ErrorNumber[ErrorNumber["ESPIPE"] = 29] = "ESPIPE";
    ErrorNumber[ErrorNumber["EROFS"] = 30] = "EROFS";
    ErrorNumber[ErrorNumber["EMLINK"] = 31] = "EMLINK";
    ErrorNumber[ErrorNumber["EPIPE"] = 32] = "EPIPE";
    ErrorNumber[ErrorNumber["EDOM"] = 33] = "EDOM";
    ErrorNumber[ErrorNumber["EDEADLK"] = 36] = "EDEADLK";
    ErrorNumber[ErrorNumber["ENAMETOOLONG"] = 38] = "ENAMETOOLONG";
    ErrorNumber[ErrorNumber["ENOLCK"] = 39] = "ENOLCK";
    ErrorNumber[ErrorNumber["ENOSYS"] = 40] = "ENOSYS";
    ErrorNumber[ErrorNumber["ENOTEMPTY"] = 41] = "ENOTEMPTY";
    ErrorNumber[ErrorNumber["EINVAL"] = 22] = "EINVAL";
    ErrorNumber[ErrorNumber["ERANGE"] = 34] = "ERANGE";
    ErrorNumber[ErrorNumber["EILSEQ"] = 42] = "EILSEQ";
    ErrorNumber[ErrorNumber["STRUNCATE"] = 80] = "STRUNCATE";
    ErrorNumber[ErrorNumber["EADDRINUSE"] = 100] = "EADDRINUSE";
    ErrorNumber[ErrorNumber["EADDRNOTAVAIL"] = 101] = "EADDRNOTAVAIL";
    ErrorNumber[ErrorNumber["EAFNOSUPPORT"] = 102] = "EAFNOSUPPORT";
    ErrorNumber[ErrorNumber["EALREADY"] = 103] = "EALREADY";
    ErrorNumber[ErrorNumber["EBADMSG"] = 104] = "EBADMSG";
    ErrorNumber[ErrorNumber["ECANCELED"] = 105] = "ECANCELED";
    ErrorNumber[ErrorNumber["ECONNABORTED"] = 106] = "ECONNABORTED";
    ErrorNumber[ErrorNumber["ECONNREFUSED"] = 107] = "ECONNREFUSED";
    ErrorNumber[ErrorNumber["ECONNRESET"] = 108] = "ECONNRESET";
    ErrorNumber[ErrorNumber["EDESTADDRREQ"] = 109] = "EDESTADDRREQ";
    ErrorNumber[ErrorNumber["EHOSTUNREACH"] = 110] = "EHOSTUNREACH";
    ErrorNumber[ErrorNumber["EIDRM"] = 111] = "EIDRM";
    ErrorNumber[ErrorNumber["EINPROGRESS"] = 112] = "EINPROGRESS";
    ErrorNumber[ErrorNumber["EISCONN"] = 113] = "EISCONN";
    ErrorNumber[ErrorNumber["ELOOP"] = 114] = "ELOOP";
    ErrorNumber[ErrorNumber["EMSGSIZE"] = 115] = "EMSGSIZE";
    ErrorNumber[ErrorNumber["ENETDOWN"] = 116] = "ENETDOWN";
    ErrorNumber[ErrorNumber["ENETRESET"] = 117] = "ENETRESET";
    ErrorNumber[ErrorNumber["ENETUNREACH"] = 118] = "ENETUNREACH";
    ErrorNumber[ErrorNumber["ENOBUFS"] = 119] = "ENOBUFS";
    ErrorNumber[ErrorNumber["ENODATA"] = 120] = "ENODATA";
    ErrorNumber[ErrorNumber["ENOLINK"] = 121] = "ENOLINK";
    ErrorNumber[ErrorNumber["ENOMSG"] = 122] = "ENOMSG";
    ErrorNumber[ErrorNumber["ENOPROTOOPT"] = 123] = "ENOPROTOOPT";
    ErrorNumber[ErrorNumber["ENOSR"] = 124] = "ENOSR";
    ErrorNumber[ErrorNumber["ENOSTR"] = 125] = "ENOSTR";
    ErrorNumber[ErrorNumber["ENOTCONN"] = 126] = "ENOTCONN";
    ErrorNumber[ErrorNumber["ENOTRECOVERABLE"] = 127] = "ENOTRECOVERABLE";
    ErrorNumber[ErrorNumber["ENOTSOCK"] = 128] = "ENOTSOCK";
    ErrorNumber[ErrorNumber["ENOTSUP"] = 129] = "ENOTSUP";
    ErrorNumber[ErrorNumber["EOPNOTSUPP"] = 130] = "EOPNOTSUPP";
    ErrorNumber[ErrorNumber["EOTHER"] = 131] = "EOTHER";
    ErrorNumber[ErrorNumber["EOVERFLOW"] = 132] = "EOVERFLOW";
    ErrorNumber[ErrorNumber["EOWNERDEAD"] = 133] = "EOWNERDEAD";
    ErrorNumber[ErrorNumber["EPROTO"] = 134] = "EPROTO";
    ErrorNumber[ErrorNumber["EPROTONOSUPPORT"] = 135] = "EPROTONOSUPPORT";
    ErrorNumber[ErrorNumber["EPROTOTYPE"] = 136] = "EPROTOTYPE";
    ErrorNumber[ErrorNumber["ETIME"] = 137] = "ETIME";
    ErrorNumber[ErrorNumber["ETIMEDOUT"] = 138] = "ETIMEDOUT";
    ErrorNumber[ErrorNumber["ETXTBSY"] = 139] = "ETXTBSY";
    ErrorNumber[ErrorNumber["EWOULDBLOCK"] = 140] = "EWOULDBLOCK";
})(ErrorNumber || (exports.ErrorNumber = ErrorNumber = {}));
exports.ErrorToString = {
    [ErrorNumber.E2BIG]: "Argument list too long.",
    [ErrorNumber.EACCES]: "Permission denied.",
    [ErrorNumber.EADDRINUSE]: "Address in use.",
    [ErrorNumber.EADDRNOTAVAIL]: "Address not available.",
    [ErrorNumber.EAFNOSUPPORT]: "Address family not supported.",
    [ErrorNumber.EAGAIN]: "Resource unavailable, try again (may be the same value as [EWOULDBLOCK]).",
    [ErrorNumber.EALREADY]: "Connection already in progress.",
    [ErrorNumber.EBADF]: "Bad file descriptor.",
    [ErrorNumber.EBADMSG]: "Bad message.",
    [ErrorNumber.EBUSY]: "Device or resource busy.",
    [ErrorNumber.ECANCELED]: "Operation canceled.",
    [ErrorNumber.ECHILD]: "No child processes.",
    [ErrorNumber.ECONNABORTED]: "Connection aborted.",
    [ErrorNumber.ECONNREFUSED]: "Connection refused.",
    [ErrorNumber.ECONNRESET]: "Connection reset.",
    [ErrorNumber.EDEADLK]: "Resource deadlock would occur.",
    [ErrorNumber.EDESTADDRREQ]: "Destination address required.",
    [ErrorNumber.EDOM]: "Mathematics argument out of domain of function.",
    [ErrorNumber.EEXIST]: "File exists.",
    [ErrorNumber.EFAULT]: "Bad address.",
    [ErrorNumber.EFBIG]: "File too large.",
    [ErrorNumber.EHOSTUNREACH]: "Host is unreachable.",
    [ErrorNumber.EIDRM]: "Identifier removed.",
    [ErrorNumber.EILSEQ]: "Illegal byte sequence.",
    [ErrorNumber.EINPROGRESS]: "Operation in progress.",
    [ErrorNumber.EINTR]: "Interrupted function.",
    [ErrorNumber.EINVAL]: "Invalid argument.",
    [ErrorNumber.EIO]: "I/O error.",
    [ErrorNumber.EISCONN]: "Socket is connected.",
    [ErrorNumber.EISDIR]: "Is a directory.",
    [ErrorNumber.ELOOP]: "Too many levels of symbolic links.",
    [ErrorNumber.EMFILE]: "Too many open files.",
    [ErrorNumber.EMLINK]: "Too many links.",
    [ErrorNumber.EMSGSIZE]: "Message too large.",
    [ErrorNumber.ENAMETOOLONG]: "Filename too long.",
    [ErrorNumber.ENETDOWN]: "Network is down.",
    [ErrorNumber.ENETRESET]: "Connection aborted by network.",
    [ErrorNumber.ENETUNREACH]: "Network unreachable.",
    [ErrorNumber.ENFILE]: "Too many files open in system.",
    [ErrorNumber.ENOBUFS]: "No buffer space available.",
    [ErrorNumber.ENODATA]: "[XSR] [Option Start] No message is available on the STREAM head read queue. [Option End]",
    [ErrorNumber.ENODEV]: "No such device.",
    [ErrorNumber.ENOENT]: "No such file or directory.",
    [ErrorNumber.ENOEXEC]: "Executable file format error.",
    [ErrorNumber.ENOLCK]: "No locks available.",
    [ErrorNumber.ENOLINK]: "Link has been severed (POSIX.1-2001).",
    [ErrorNumber.ENOMEM]: "Not enough space.",
    [ErrorNumber.ENOMSG]: "No message of the desired type.",
    [ErrorNumber.ENOPROTOOPT]: "Protocol not available.",
    [ErrorNumber.ENOSPC]: "No space left on device.",
    [ErrorNumber.ENOSR]: "[XSR] [Option Start] No STREAM resources. [Option End]",
    [ErrorNumber.ENOSTR]: "[XSR] [Option Start] Not a STREAM. [Option End]",
    [ErrorNumber.ENOSYS]: "Function not supported.",
    [ErrorNumber.ENOTCONN]: "The socket is not connected.",
    [ErrorNumber.ENOTDIR]: "Not a directory.",
    [ErrorNumber.ENOTEMPTY]: "Directory not empty.",
    [ErrorNumber.ENOTSOCK]: "Not a socket.",
    [ErrorNumber.ENOTSUP]: "Not supported.",
    [ErrorNumber.ENOTTY]: "Inappropriate I/O control operation.",
    [ErrorNumber.ENXIO]: "No such device or address.",
    [ErrorNumber.EOVERFLOW]: "Value too large to be stored in data type.",
    [ErrorNumber.EPERM]: "Operation not permitted.",
    [ErrorNumber.EPIPE]: "Broken pipe.",
    [ErrorNumber.EPROTO]: "Protocol error.",
    [ErrorNumber.EPROTONOSUPPORT]: "Protocol not supported.",
    [ErrorNumber.EPROTOTYPE]: "Protocol wrong type for socket.",
    [ErrorNumber.ERANGE]: "Result too large.",
    [ErrorNumber.EROFS]: "Read-only file system.",
    [ErrorNumber.ESPIPE]: "Invalid seek.",
    [ErrorNumber.ESRCH]: "No such process.",
    [ErrorNumber.ETIME]: "[XSR] [Option Start] Stream ioctl() timeout. [Option End]",
    [ErrorNumber.ETIMEDOUT]: "Connection timed out.",
    [ErrorNumber.ETXTBSY]: "Text file busy.",
    [ErrorNumber.EXDEV]: "Cross-device link. ",
};
//# sourceMappingURL=error.js.map