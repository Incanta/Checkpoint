export declare enum ErrorNumber {
    EPERM = 1,
    ENOENT = 2,
    ESRCH = 3,
    EINTR = 4,
    EIO = 5,
    ENXIO = 6,
    E2BIG = 7,
    ENOEXEC = 8,
    EBADF = 9,
    ECHILD = 10,
    EAGAIN = 11,
    ENOMEM = 12,
    EACCES = 13,
    EFAULT = 14,
    EBUSY = 16,
    EEXIST = 17,
    EXDEV = 18,
    ENODEV = 19,
    ENOTDIR = 20,
    EISDIR = 21,
    ENFILE = 23,
    EMFILE = 24,
    ENOTTY = 25,
    EFBIG = 27,
    ENOSPC = 28,
    ESPIPE = 29,
    EROFS = 30,
    EMLINK = 31,
    EPIPE = 32,
    EDOM = 33,
    EDEADLK = 36,
    ENAMETOOLONG = 38,
    ENOLCK = 39,
    ENOSYS = 40,
    ENOTEMPTY = 41,
    EINVAL = 22,
    ERANGE = 34,
    EILSEQ = 42,
    STRUNCATE = 80,
    EADDRINUSE = 100,
    EADDRNOTAVAIL = 101,
    EAFNOSUPPORT = 102,
    EALREADY = 103,
    EBADMSG = 104,
    ECANCELED = 105,
    ECONNABORTED = 106,
    ECONNREFUSED = 107,
    ECONNRESET = 108,
    EDESTADDRREQ = 109,
    EHOSTUNREACH = 110,
    EIDRM = 111,
    EINPROGRESS = 112,
    EISCONN = 113,
    ELOOP = 114,
    EMSGSIZE = 115,
    ENETDOWN = 116,
    ENETRESET = 117,
    ENETUNREACH = 118,
    ENOBUFS = 119,
    ENODATA = 120,
    ENOLINK = 121,
    ENOMSG = 122,
    ENOPROTOOPT = 123,
    ENOSR = 124,
    ENOSTR = 125,
    ENOTCONN = 126,
    ENOTRECOVERABLE = 127,
    ENOTSOCK = 128,
    ENOTSUP = 129,
    EOPNOTSUPP = 130,
    EOTHER = 131,
    EOVERFLOW = 132,
    EOWNERDEAD = 133,
    EPROTO = 134,
    EPROTONOSUPPORT = 135,
    EPROTOTYPE = 136,
    ETIME = 137,
    ETIMEDOUT = 138,
    ETXTBSY = 139,
    EWOULDBLOCK = 140
}
export declare const ErrorToString: {
    7: string;
    13: string;
    100: string;
    101: string;
    102: string;
    11: string;
    103: string;
    9: string;
    104: string;
    16: string;
    105: string;
    10: string;
    106: string;
    107: string;
    108: string;
    36: string;
    109: string;
    33: string;
    17: string;
    14: string;
    27: string;
    110: string;
    111: string;
    42: string;
    112: string;
    4: string;
    22: string;
    5: string;
    113: string;
    21: string;
    114: string;
    24: string;
    31: string;
    115: string;
    38: string;
    116: string;
    117: string;
    118: string;
    23: string;
    119: string;
    120: string;
    19: string;
    2: string;
    8: string;
    39: string;
    121: string;
    12: string;
    122: string;
    123: string;
    28: string;
    124: string;
    125: string;
    40: string;
    126: string;
    20: string;
    41: string;
    128: string;
    129: string;
    25: string;
    6: string;
    132: string;
    1: string;
    32: string;
    134: string;
    135: string;
    136: string;
    34: string;
    30: string;
    29: string;
    3: string;
    137: string;
    138: string;
    139: string;
    18: string;
};
export interface IErrorResult {
    error: ErrorNumber;
}
//# sourceMappingURL=error.d.ts.map