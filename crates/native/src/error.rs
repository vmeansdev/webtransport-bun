//! Native error definitions and conversion utilities.

use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WtCode {
    E_INVALID_ARGUMENT,
    E_UNSUPPORTED_ARGUMENT,
    E_TLS,
    E_HANDSHAKE_TIMEOUT,
    E_SESSION_CLOSED,
    E_SESSION_IDLE_TIMEOUT,
    E_STREAM_RESET,
    E_STOP_SENDING,
    E_QUEUE_FULL,
    E_BACKPRESSURE_TIMEOUT,
    E_LIMIT_EXCEEDED,
    E_RATE_LIMITED,
    E_INTERNAL,
}

impl WtCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::E_INVALID_ARGUMENT => "E_INVALID_ARGUMENT",
            Self::E_UNSUPPORTED_ARGUMENT => "E_UNSUPPORTED_ARGUMENT",
            Self::E_TLS => "E_TLS",
            Self::E_HANDSHAKE_TIMEOUT => "E_HANDSHAKE_TIMEOUT",
            Self::E_SESSION_CLOSED => "E_SESSION_CLOSED",
            Self::E_SESSION_IDLE_TIMEOUT => "E_SESSION_IDLE_TIMEOUT",
            Self::E_STREAM_RESET => "E_STREAM_RESET",
            Self::E_STOP_SENDING => "E_STOP_SENDING",
            Self::E_QUEUE_FULL => "E_QUEUE_FULL",
            Self::E_BACKPRESSURE_TIMEOUT => "E_BACKPRESSURE_TIMEOUT",
            Self::E_LIMIT_EXCEEDED => "E_LIMIT_EXCEEDED",
            Self::E_RATE_LIMITED => "E_RATE_LIMITED",
            Self::E_INTERNAL => "E_INTERNAL",
        }
    }

    fn parse(message: &str) -> Option<Self> {
        const CODES: [WtCode; 13] = [
            WtCode::E_INVALID_ARGUMENT,
            WtCode::E_UNSUPPORTED_ARGUMENT,
            WtCode::E_TLS,
            WtCode::E_HANDSHAKE_TIMEOUT,
            WtCode::E_SESSION_CLOSED,
            WtCode::E_SESSION_IDLE_TIMEOUT,
            WtCode::E_STREAM_RESET,
            WtCode::E_STOP_SENDING,
            WtCode::E_QUEUE_FULL,
            WtCode::E_BACKPRESSURE_TIMEOUT,
            WtCode::E_LIMIT_EXCEEDED,
            WtCode::E_RATE_LIMITED,
            WtCode::E_INTERNAL,
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
        let code = WtCode::parse(&detail).unwrap_or(WtCode::E_INTERNAL);
        let detail = match code {
            WtCode::E_INTERNAL => format!("{INTERNAL_MESSAGE_PREFIX}{detail}"),
            _ => detail,
        };
        Self::new(code, detail)
    }

    pub fn with_code(code: WtCode, detail: String) -> Self {
        let detail = match code {
            WtCode::E_INTERNAL => {
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
        napi::Error::from_reason(err.to_string())
    }
}

pub fn from_reason(detail: impl std::fmt::Display) -> napi::Error {
    WtError::from_detail(detail.to_string()).into()
}

pub fn from_code(code: WtCode, detail: impl std::fmt::Display) -> napi::Error {
    WtError::with_code(code, detail.to_string()).into()
}

pub fn from_upstream_error(detail: impl std::fmt::Display) -> napi::Error {
    let detail = detail.to_string();
    let lower = detail.to_ascii_lowercase();
    if lower.contains("connection locally closed") || lower.contains("connection closed by peer") {
        return from_code(WtCode::E_SESSION_CLOSED, detail);
    }
    from_reason(detail)
}
