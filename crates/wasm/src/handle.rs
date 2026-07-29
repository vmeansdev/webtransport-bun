const HANDLE_SPACE_EXHAUSTED: &str = "E_LIMIT_EXCEEDED: endpoint handle space exhausted";

pub(crate) struct HandleAllocator {
    next: u32,
}

impl HandleAllocator {
    pub(crate) const fn new() -> Self {
        Self { next: 1 }
    }

    pub(crate) fn allocate(&mut self) -> Result<u32, &'static str> {
        if self.next == 0 {
            return Err(HANDLE_SPACE_EXHAUSTED);
        }
        let id = self.next;
        self.next = self.next.checked_add(1).unwrap_or(0);
        Ok(id)
    }
}

#[cfg(test)]
mod tests {
    use super::{HandleAllocator, HANDLE_SPACE_EXHAUSTED};

    #[test]
    fn allocate_from_initial_state_should_start_at_one() {
        let mut allocator = HandleAllocator::new();
        assert_eq!(allocator.allocate(), Ok(1));
        assert_eq!(allocator.allocate(), Ok(2));
    }

    #[test]
    fn allocate_at_u32_boundary_should_never_wrap_or_return_zero() {
        let mut allocator = HandleAllocator { next: u32::MAX };
        assert_eq!(allocator.allocate(), Ok(u32::MAX));
        assert_eq!(allocator.allocate(), Err(HANDLE_SPACE_EXHAUSTED));
        assert_eq!(allocator.allocate(), Err(HANDLE_SPACE_EXHAUSTED));
    }
}
