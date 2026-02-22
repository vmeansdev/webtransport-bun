use napi::Result;
use napi_derive::napi;

use crate::panic_guard;

#[napi]
pub struct StreamHandle {
    id: u32,
}

#[napi]
impl StreamHandle {
    #[napi(constructor)]
    pub fn new(id: u32) -> Self {
        Self { id }
    }

    #[napi(getter)]
    pub fn id(&self) -> u32 {
        self.id
    }

    #[napi]
    pub async fn read(&self) -> Result<Option<napi::bindgen_prelude::Buffer>> {
        panic_guard::catch_panic(|| Ok(None))
    }

    #[napi]
    pub async fn write(&self, _chunk: napi::bindgen_prelude::Buffer) -> Result<()> {
        panic_guard::catch_panic(|| Ok(()))
    }

    #[napi]
    pub fn reset(&self, _code: u32) -> Result<()> {
        panic_guard::catch_panic(|| Ok(()))
    }

    #[napi]
    pub fn stop_sending(&self, _code: u32) -> Result<()> {
        panic_guard::catch_panic(|| Ok(()))
    }
}
