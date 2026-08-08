#![no_main]

use libfuzzer_sys::fuzz_target;

mod handle_impl {
    include!("../../../crates/wasm/src/handle.rs");

    pub fn allocator_from_next(next: u32) -> HandleAllocator {
        HandleAllocator { next }
    }
}

fn u32_at(data: &[u8], offset: usize) -> u32 {
    let mut bytes = [0_u8; 4];
    if let Some(slice) = data.get(offset..offset.saturating_add(4)) {
        bytes[..slice.len()].copy_from_slice(slice);
    }
    u32::from_le_bytes(bytes)
}

fuzz_target!(|data: &[u8]| {
    let start = u32_at(data, 0);
    let iterations = usize::from(*data.get(4).unwrap_or(&32)).min(128);
    let mut allocator = handle_impl::allocator_from_next(start.max(1));
    for _ in 0..iterations {
        let _ = allocator.allocate();
    }
});
