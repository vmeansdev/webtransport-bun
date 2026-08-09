//! Resolve Rust-owned receive payloads as engine-owned `Uint8Array` values.
//!
//! The value carried across `.await` contains Rust data only. napi-rs invokes
//! `ToNapiValue` from its promise resolver on the JavaScript/N-API thread; that
//! is the only place this module allocates or touches JavaScript memory.

use napi::bindgen_prelude::{ToNapiValue, TypeName};
use napi::{Env, Error, Result, TypedArrayType, ValueType};

pub(crate) trait EnginePayloadSource: Send + 'static {
    fn payload_len(&self) -> usize;
    fn copy_payload_to(&self, destination: &mut [u8]) -> Result<()>;
}

pub struct EngineOwnedPayload(Box<dyn EnginePayloadSource>);

impl EngineOwnedPayload {
    pub(crate) fn new(source: impl EnginePayloadSource) -> Self {
        Self(Box::new(source))
    }
}

impl TypeName for EngineOwnedPayload {
    fn type_name() -> &'static str {
        "Uint8Array"
    }

    fn value_type() -> ValueType {
        ValueType::Object
    }
}

impl ToNapiValue for EngineOwnedPayload {
    unsafe fn to_napi_value(
        raw_env: napi::sys::napi_env,
        payload: Self,
    ) -> Result<napi::sys::napi_value> {
        // SAFETY: napi-rs calls this conversion from the JS-thread resolver for
        // the async method. `raw_env` is used only for this synchronous scope.
        let env = unsafe { Env::from_raw(raw_env) };
        let length = payload.0.payload_len();
        let mut arraybuffer = env.create_arraybuffer(length)?;
        if arraybuffer.len() != length {
            return Err(Error::from_reason(
                "E_INTERNAL: engine ArrayBuffer length mismatch",
            ));
        }
        payload.0.copy_payload_to(arraybuffer.as_mut())?;
        let typed = arraybuffer
            .into_raw()
            .into_typedarray(TypedArrayType::Uint8, length, 0)?;
        // SAFETY: `typed` was created in `raw_env` immediately above.
        unsafe { ToNapiValue::to_napi_value(raw_env, typed) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestPayload(Vec<u8>);

    impl EnginePayloadSource for TestPayload {
        fn payload_len(&self) -> usize {
            self.0.len()
        }

        fn copy_payload_to(&self, destination: &mut [u8]) -> Result<()> {
            if destination.len() != self.0.len() {
                return Err(Error::from_reason("length mismatch"));
            }
            destination.copy_from_slice(&self.0);
            Ok(())
        }
    }

    #[test]
    fn payload_source_copies_exact_bytes() {
        let source = TestPayload(vec![1, 2, 3]);
        let mut destination = vec![0; source.payload_len()];
        source.copy_payload_to(&mut destination).unwrap();
        assert_eq!(destination, [1, 2, 3]);
    }

    #[test]
    fn payload_source_rejects_wrong_destination_length() {
        let source = TestPayload(vec![1, 2, 3]);
        let mut destination = vec![0; 2];
        assert!(source.copy_payload_to(&mut destination).is_err());
    }
}
