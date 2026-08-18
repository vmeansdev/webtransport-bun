//! Native error definitions and conversion utilities.

use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WtCode {
    EInvalidArgument,
    EUnsupportedArgument,
    ETls,
    EHandshakeTimeout,
    ESessionClosed,
    ESessionIdleTimeout,
    EStreamReset,
    EStopSending,
    EQueueFull,
    EBackpressureTimeout,
    ELimitExceeded,
    ERateLimited,
    EInternal,
}

impl WtCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::EInvalidArgument => "E_INVALID_ARGUMENT",
            Self::EUnsupportedArgument => "E_UNSUPPORTED_ARGUMENT",
            Self::ETls => "E_TLS",
            Self::EHandshakeTimeout => "E_HANDSHAKE_TIMEOUT",
            Self::ESessionClosed => "E_SESSION_CLOSED",
            Self::ESessionIdleTimeout => "E_SESSION_IDLE_TIMEOUT",
            Self::EStreamReset => "E_STREAM_RESET",
            Self::EStopSending => "E_STOP_SENDING",
            Self::EQueueFull => "E_QUEUE_FULL",
            Self::EBackpressureTimeout => "E_BACKPRESSURE_TIMEOUT",
            Self::ELimitExceeded => "E_LIMIT_EXCEEDED",
            Self::ERateLimited => "E_RATE_LIMITED",
            Self::EInternal => "E_INTERNAL",
        }
    }

    fn parse(message: &str) -> Option<Self> {
        const CODES: [WtCode; 13] = [
            WtCode::EInvalidArgument,
            WtCode::EUnsupportedArgument,
            WtCode::ETls,
            WtCode::EHandshakeTimeout,
            WtCode::ESessionClosed,
            WtCode::ESessionIdleTimeout,
            WtCode::EStreamReset,
            WtCode::EStopSending,
            WtCode::EQueueFull,
            WtCode::EBackpressureTimeout,
            WtCode::ELimitExceeded,
            WtCode::ERateLimited,
            WtCode::EInternal,
        ];
        for code in CODES {
            let marker = code.as_str();
            if message == marker {
                return Some(code);
            }
            if let Some(suffix) = message.strip_prefix(marker) {
                if suffix.starts_with(':') {
                    return Some(code);
                }
            }
        }
        None
    }
}

#[derive(Debug, Clone)]
pub struct WtError {
    pub code: WtCode,
    pub detail: String,
}

const INTERNAL_MESSAGE_PREFIX: &str = "codeless: ";

impl WtError {
    pub fn new(code: WtCode, detail: String) -> Self {
        Self { code, detail }
    }

    pub fn from_detail(detail: String) -> Self {
        let code = WtCode::parse(&detail).unwrap_or(WtCode::EInternal);
        let detail = match code {
            WtCode::EInternal => format!("{INTERNAL_MESSAGE_PREFIX}{detail}"),
            _ => detail,
        };
        Self::new(code, detail)
    }

    pub fn with_code(code: WtCode, detail: String) -> Self {
        let detail = match code {
            WtCode::EInternal => {
                if detail.starts_with(INTERNAL_MESSAGE_PREFIX) {
                    detail
                } else {
                    format!("{INTERNAL_MESSAGE_PREFIX}{detail}")
                }
            }
            _ => detail,
        };
        Self::new(code, detail)
    }
}

impl WtError {
    /// The `E_CODE: detail` wire message, built in one exact-size allocation.
    fn napi_message(&self) -> String {
        let code = self.code.as_str();
        let mut msg = String::with_capacity(code.len() + 2 + self.detail.len());
        msg.push_str(code);
        msg.push_str(": ");
        msg.push_str(&self.detail);
        msg
    }
}

impl fmt::Display for WtError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.detail)
    }
}

pub type WtResult<T> = std::result::Result<T, napi::Error>;

impl From<WtError> for napi::Error {
    fn from(err: WtError) -> Self {
        // Sync napi entrypoints require `Error` (Status), not `Error<String>`.
        // Preserve `E_CODE: detail` so JS classification stays message-stable.
        napi::Error::from_reason(err.napi_message())
    }
}

pub fn from_reason(detail: impl std::fmt::Display) -> napi::Error {
    WtError::from_detail(detail.to_string()).into()
}

/// A bare `&'static` code as the whole detail (`E_CODE: E_CODE`), skipping the
/// parse walk and building the message in one allocation.
pub fn from_static_code(code: &'static str) -> napi::Error {
    debug_assert!(WtCode::parse(code).is_some(), "unknown wire code {code}");
    let mut msg = String::with_capacity(code.len() * 2 + 2);
    msg.push_str(code);
    msg.push_str(": ");
    msg.push_str(code);
    napi::Error::from_reason(msg)
}

pub fn from_code(code: WtCode, detail: impl std::fmt::Display) -> napi::Error {
    WtError::with_code(code, detail.to_string()).into()
}

fn contains_ignore_ascii_case(haystack: &str, needle: &str) -> bool {
    let h = haystack.as_bytes();
    let n = needle.as_bytes();
    if n.is_empty() || h.len() < n.len() {
        return n.is_empty();
    }
    h.windows(n.len()).any(|w| w.eq_ignore_ascii_case(n))
}

/// The final wire message for an upstream error, without the intermediate
/// lowercase copy or double `Display` pass.
pub fn upstream_error_message(detail: impl std::fmt::Display) -> String {
    let detail = detail.to_string();
    let err = if contains_ignore_ascii_case(&detail, "connection locally closed")
        || contains_ignore_ascii_case(&detail, "connection closed by peer")
    {
        WtError::with_code(WtCode::ESessionClosed, detail)
    } else {
        WtError::from_detail(detail)
    };
    err.napi_message()
}

pub fn from_upstream_error(detail: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(upstream_error_message(detail))
}
