# Protocol edge cases (Phase 8.2)

Expected behavior for protocol edge-case tests:

## Peer resets mid-write
- Outgoing stream: writer receives stream reset; Promise/write rejects with E_STREAM_RESET
- Incoming stream: reader gets end/error; stopSending sent if applicable

## Half-close (FIN)
- One direction closed while other remains active: connection stays open until both sides close or idle timeout

## stopSending / reset codes
- stopSending(code): receiver signals it will not read more; sender should stop writing
- reset(code): sender aborts stream; receiver gets error with code
- Codes must propagate through JS API

## Idle timeout
- See docs/OPERATIONS.md "Idle timeout behavior"
