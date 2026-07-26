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
            Self::E_INVALID_ARGUMENT,
            Self::E_UNSUPPORTED_ARGUMENT,
            Self::E_TLS,
            Self::E_HANDSHAKE_TIMEOUT,
            Self::E_SESSION_CLOSED,
            Self::E_SESSION_IDLE_TIMEOUT,
            Self::E_STREAM_RESET,
            Self::E_STOP_SENDING,
            Self::E_QUEUE_FULL,
            Self::E_BACKPRESSURE_TIMEOUT,
            Self::E_LIMIT_EXCEEDED,
            Self::E_RATE_LIMITED,
            Self::E_INTERNAL,
        ];
        for code in CODES {
            let marker = code.as_str();
            if message == marker {
                return Some(code);
            }
            if message.starts_with(marker) {
                let suffix = &message[marker.len()..];
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

pub type WtResult<T> = std::result::Result<T, napi::Error<String>>;

impl From<WtError> for napi::Error<String> {
    fn from(err: WtError) -> Self {
        napi::Error::new(err.code.as_str().to_string(), err.detail)
    }
}

pub fn from_reason(detail: impl Into<String>) -> napi::Error<String> {
    WtError::from_detail(detail.into()).into()
}

pub fn from_code(code: WtCode, detail: impl Into<String>) -> napi::Error<String> {
    WtError::with_code(code, detail.into()).into()
}
