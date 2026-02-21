use napi_derive::napi;
use napi::Result;

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
        // Pull data from stream
        Ok(None)
    }

    #[napi]
    pub async fn write(&self, chunk: napi::bindgen_prelude::Buffer) -> Result<()> {
        // Send data
        Ok(())
    }

    #[napi]
    pub fn reset(&self, code: u32) -> Result<()> {
        // Reset stream
        Ok(())
    }

    #[napi]
    pub fn stop_sending(&self, code: u32) -> Result<()> {
        // Send STOP_SENDING
        Ok(())
    }
}
