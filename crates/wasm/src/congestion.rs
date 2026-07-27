//! Congestion-control preference mapping for quinn-proto TransportConfig.

use std::sync::Arc;

use quinn_proto::congestion::{BbrConfig, ControllerFactory, CubicConfig, NewRenoConfig};
use quinn_proto::TransportConfig;

/// W3C-shaped congestion preference (matches native addon labels).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CongestionControlMode {
    #[default]
    Default,
    Throughput,
    LowLatency,
}

impl CongestionControlMode {
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.unwrap_or("default") {
			"default" => Ok(Self::Default),
			"throughput" => Ok(Self::Throughput),
			"low-latency" => Ok(Self::LowLatency),
			other => Err(format!(
				"E_INVALID_ARGUMENT: congestionControl must be \"default\", \"throughput\", or \"low-latency\", got \"{other}\""
			)),
		}
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Throughput => "throughput",
            Self::LowLatency => "low-latency",
        }
    }

    pub fn apply(self, tc: &mut TransportConfig) {
        let factory: Arc<dyn ControllerFactory + Send + Sync + 'static> = match self {
            Self::Default => Arc::new(CubicConfig::default()),
            Self::Throughput => Arc::new(BbrConfig::default()),
            Self::LowLatency => Arc::new(NewRenoConfig::default()),
        };
        tc.congestion_controller_factory(factory);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_maps_supported_values() {
        assert_eq!(
            CongestionControlMode::parse(Some("throughput")).unwrap(),
            CongestionControlMode::Throughput
        );
        assert_eq!(
            CongestionControlMode::parse(Some("low-latency")).unwrap(),
            CongestionControlMode::LowLatency
        );
        assert_eq!(
            CongestionControlMode::parse(None).unwrap(),
            CongestionControlMode::Default
        );
        assert!(CongestionControlMode::parse(Some("invalid")).is_err());
    }
}
