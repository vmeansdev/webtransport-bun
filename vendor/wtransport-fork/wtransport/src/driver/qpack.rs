use std::sync::Arc;
use std::sync::Mutex;
use tokio::sync::mpsc;
use wtransport_proto::error::ErrorCode;
use wtransport_proto::frame::Frame;
use wtransport_proto::headers::Headers;
use wtransport_proto::qpack::Decoder;
use wtransport_proto::qpack::DecoderInstructions;
use wtransport_proto::qpack::DynamicTable;
use wtransport_proto::qpack::Encoder;

/// Decoder state shared by everything on the connection that reads a field section.
///
/// Field sections arrive on request streams while the inserts they reference arrive on
/// the peer's encoder stream, and on the client the two are read by different tasks, so
/// the table has to be shared. `SETTINGS_QPACK_BLOCKED_STREAMS` is zero, which means a
/// section can always be decoded the moment it arrives: the lock is only ever held for
/// the length of one decode, never across a wait.
#[derive(Debug, Clone)]
pub struct QpackDecoderState {
    state: Arc<Mutex<State>>,
    instructions: mpsc::UnboundedSender<Vec<u8>>,
}

#[derive(Debug)]
struct State {
    table: DynamicTable,
    /// Inserts already reported to the peer with an insert count increment.
    acknowledged: u64,
}

impl QpackDecoderState {
    /// Builds the state for a table of `max_table_capacity` bytes, together with the
    /// receiver of the instructions to write on this endpoint's decoder stream.
    pub fn new(max_table_capacity: u64) -> (Self, mpsc::UnboundedReceiver<Vec<u8>>) {
        let instructions = mpsc::unbounded_channel();

        let state = Self {
            state: Arc::new(Mutex::new(State {
                table: DynamicTable::new(usize::try_from(max_table_capacity).unwrap_or(usize::MAX)),
                acknowledged: 0,
            })),
            instructions: instructions.0,
        };

        (state, instructions.1)
    }

    /// Whether this endpoint offered the peer a dynamic table at all.
    pub fn is_enabled(&self) -> bool {
        self.lock().table.max_capacity() > 0
    }

    /// Decodes a `HEADERS` frame received on `stream_id`.
    ///
    /// Acknowledges the section when it referenced the dynamic table, which is what
    /// lets the peer's encoder evict the entries it used.
    pub fn decode(&self, frame: &Frame, stream_id: u64) -> Result<Headers, ErrorCode> {
        let (headers, required_insert_count) = {
            let state = self.lock();
            Headers::with_frame_dynamic(frame, &state.table)?
        };

        if required_insert_count > 0 {
            self.send(Encoder::encode_section_acknowledgement(stream_id));
        }

        Ok(headers)
    }

    /// Applies what the peer wrote on its encoder stream, returning how many bytes were
    /// consumed. A trailing partial instruction is left for the next read.
    ///
    /// Every batch of inserts is reported back with an insert count increment: the peer
    /// cannot reuse an entry it does not know has arrived, and without this its table
    /// fills up and its encoder falls back to literals for good.
    pub fn feed_encoder_stream(&self, data: &[u8]) -> Result<usize, ErrorCode> {
        let (consumed, increment) = {
            let mut state = self.lock();

            let consumed = Decoder::feed_encoder_stream(&mut state.table, data)
                .map_err(|_| ErrorCode::EncoderStream)?;

            let increment = state.table.insert_count() - state.acknowledged;
            state.acknowledged = state.table.insert_count();

            (consumed, increment)
        };

        if increment > 0 {
            self.send(Encoder::encode_insert_count_increment(increment));
        }

        Ok(consumed)
    }

    /// Tells the peer a stream was abandoned without its field sections being read.
    ///
    /// The peer holds a reference for every section it sent until the section is either
    /// acknowledged or cancelled, so staying silent here stalls its eviction.
    pub fn cancel_stream(&self, stream_id: u64) {
        if self.is_enabled() {
            self.send(Encoder::encode_stream_cancellation(stream_id));
        }
    }

    fn send(&self, instruction: Vec<u8>) {
        // A closed receiver means the connection is going away; there is nothing left
        // to tell the peer.
        let _ = self.instructions.send(instruction);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// Encoder state for the connection.
///
/// The table mirrors one the *peer* holds, so it is sized from the capacity the peer
/// advertised rather than from anything configured here, and stays empty until that
/// setting arrives (RFC 9204 Section 3.2.3).
#[derive(Debug, Clone)]
pub struct QpackEncoderState {
    state: Arc<Mutex<EncoderState>>,
    instructions: mpsc::UnboundedSender<Vec<u8>>,
}

#[derive(Debug)]
struct EncoderState {
    table: DynamicTable,
    /// Inserts the peer has confirmed receiving.
    known_received_count: u64,
    configured: bool,
}

impl QpackEncoderState {
    /// Builds the state, together with the receiver of the instructions to write on
    /// this endpoint's encoder stream.
    pub fn new() -> (Self, mpsc::UnboundedReceiver<Vec<u8>>) {
        let instructions = mpsc::unbounded_channel();

        let state = Self {
            state: Arc::new(Mutex::new(EncoderState {
                table: DynamicTable::new(0),
                known_received_count: 0,
                configured: false,
            })),
            instructions: instructions.0,
        };

        (state, instructions.1)
    }

    /// Takes up the peer's offer of a dynamic table, once its settings have arrived.
    ///
    /// The capacity is the peer's, bounded by what this endpoint is willing to mirror:
    /// the table is held on both sides, so an extravagant offer is not one to accept.
    /// Asking for more than the peer allowed would be an encoder stream error.
    pub fn configure(&self, peer_max_table_capacity: u64, limit: u64) {
        let capacity = peer_max_table_capacity.min(limit);
        let capacity = usize::try_from(capacity).unwrap_or(usize::MAX);

        let mut state = self.lock();

        if state.configured {
            return;
        }

        state.configured = true;

        if capacity == 0 {
            return;
        }

        state.table = DynamicTable::new(capacity);

        if state.table.set_capacity(capacity).is_ok() {
            drop(state);
            self.send(Encoder::encode_set_capacity(capacity));
        }
    }

    /// Encodes `headers` into a `HEADERS` frame, indexing what it can.
    pub fn encode(&self, headers: &Headers) -> Frame<'static> {
        let (frame, instructions) = {
            let mut state = self.lock();
            let known_received_count = state.known_received_count;

            headers.generate_frame_dynamic(&mut state.table, known_received_count)
        };

        if !instructions.is_empty() {
            self.send(instructions);
        }

        frame
    }

    /// Applies what the peer wrote on its decoder stream.
    ///
    /// Only an insert count increment raises the known received count. A section
    /// acknowledgement implies as much, but recovering how much would mean tracking a
    /// required insert count per stream; under-counting only costs compression, while
    /// over-counting would reference an entry the peer might not hold.
    pub fn note_peer_instructions(&self, instructions: &DecoderInstructions) {
        let mut state = self.lock();

        let known_received_count = state
            .known_received_count
            .saturating_add(instructions.insert_count_increment)
            .min(state.table.insert_count());

        state.known_received_count = known_received_count;
    }

    fn send(&self, instruction: Vec<u8>) {
        let _ = self.instructions.send(instruction);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, EncoderState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instructions(receiver: &mut mpsc::UnboundedReceiver<Vec<u8>>) -> DecoderInstructions {
        let mut data = Vec::new();

        while let Ok(instruction) = receiver.try_recv() {
            data.extend(instruction);
        }

        Encoder::feed_decoder_stream(&data).unwrap().1
    }

    fn insert(state: &QpackDecoderState, name: &str, value: &str) {
        let mut stream = Encoder::encode_set_capacity(4096);
        stream.extend(Encoder::encode_insert_with_literal_name(name, value));

        assert_eq!(state.feed_encoder_stream(&stream).unwrap(), stream.len());
    }

    #[test]
    fn inserts_are_reported_to_the_peer() {
        let (state, mut receiver) = QpackDecoderState::new(4096);

        insert(&state, ":protocol", "webtransport");

        assert_eq!(instructions(&mut receiver).insert_count_increment, 1);

        // Nothing new to report on an empty read.
        assert_eq!(state.feed_encoder_stream(&[]).unwrap(), 0);
        assert_eq!(instructions(&mut receiver).insert_count_increment, 0);
    }

    #[test]
    fn a_dynamic_section_is_acknowledged() {
        let (state, mut receiver) = QpackDecoderState::new(4096);

        insert(&state, ":protocol", "webtransport");
        let _ = instructions(&mut receiver);

        let mut payload = Encoder::encode_section_prefix(1, 1, 128).unwrap();
        payload.push(0x80); // Indexed field line, dynamic, relative index 0.

        let frame = Frame::new_headers(std::borrow::Cow::Owned(payload));
        let headers = state.decode(&frame, 12).unwrap();

        assert_eq!(headers.get(":protocol"), Some("webtransport"));
        assert_eq!(
            instructions(&mut receiver).section_acknowledgements,
            vec![12]
        );
    }

    #[test]
    fn a_static_section_is_not_acknowledged() {
        let (state, mut receiver) = QpackDecoderState::new(4096);

        let headers = [(":method", "CONNECT")]
            .into_iter()
            .collect::<Headers>()
            .generate_frame();

        state.decode(&headers, 12).unwrap();

        assert!(instructions(&mut receiver)
            .section_acknowledgements
            .is_empty());
    }

    #[test]
    fn a_broken_encoder_stream_is_an_encoder_stream_error() {
        let (state, _receiver) = QpackDecoderState::new(4096);

        // Set Dynamic Table Capacity above what was advertised.
        assert!(matches!(
            state.feed_encoder_stream(&Encoder::encode_set_capacity(8192)),
            Err(ErrorCode::EncoderStream)
        ));
    }

    /// Drains an encoder stream into a peer's decoder, returning what it consumed.
    fn deliver(
        from: &mut mpsc::UnboundedReceiver<Vec<u8>>,
        to: &QpackDecoderState,
    ) -> Result<usize, ErrorCode> {
        let mut data = Vec::new();

        while let Ok(instruction) = from.try_recv() {
            data.extend(instruction);
        }

        to.feed_encoder_stream(&data)
    }

    fn headers() -> Headers {
        [
            (":method", "CONNECT"),
            (":protocol", "webtransport"),
            (":authority", "example.com"),
        ]
        .into_iter()
        .collect()
    }

    #[test]
    fn the_encoder_sizes_its_table_from_the_peers_capacity() {
        // The peer offers less than this endpoint would have been willing to hold.
        let (encoder, mut instructions) = QpackEncoderState::new();
        encoder.configure(4096, 65536);

        assert_eq!(
            instructions.try_recv().unwrap(),
            Encoder::encode_set_capacity(4096)
        );

        // And the other way round, the peer's larger offer is bounded by the limit.
        let (encoder, mut instructions) = QpackEncoderState::new();
        encoder.configure(65536, 4096);

        assert_eq!(
            instructions.try_recv().unwrap(),
            Encoder::encode_set_capacity(4096)
        );
    }

    #[test]
    fn a_peer_offering_no_table_is_not_inserted_into() {
        let (encoder, mut instructions) = QpackEncoderState::new();
        encoder.configure(0, 65536);

        assert!(instructions.try_recv().is_err());

        // Encoding still works, against the static table.
        let frame = encoder.encode(&headers());
        let decoded = QpackDecoderState::new(0).0.decode(&frame, 0).unwrap();

        assert_eq!(decoded.get(":method"), Some("CONNECT"));
        assert!(instructions.try_recv().is_err());
    }

    /// The whole loop: this endpoint inserts, the peer applies and acknowledges, and the
    /// next section indexes what was acknowledged.
    ///
    /// A WebTransport connection never gets this far on its own, since it carries one
    /// header exchange and nothing can be acknowledged before it. Everything here is
    /// what the encoder would do the moment a connection carried a second section.
    #[test]
    fn an_acknowledged_insert_is_referenced_by_the_next_section() {
        let (encoder, mut encoder_stream) = QpackEncoderState::new();
        let (peer, mut peer_stream) = QpackDecoderState::new(4096);

        encoder.configure(4096, 65536);

        // First section: nothing acknowledged, so it is literal, but it seeds the table.
        let first = encoder.encode(&headers());
        assert_eq!(first.payload()[0], 0, "nothing may be referenced yet");

        deliver(&mut encoder_stream, &peer).unwrap();
        assert_eq!(
            peer.decode(&first, 0).unwrap().get(":authority"),
            Some("example.com")
        );

        // The peer acknowledges the inserts on its decoder stream.
        let mut acknowledgements = Vec::new();
        while let Ok(instruction) = peer_stream.try_recv() {
            acknowledgements.extend(instruction);
        }

        let (_, instructions) = Encoder::feed_decoder_stream(&acknowledgements).unwrap();
        assert!(
            instructions.insert_count_increment > 0,
            "the peer must acknowledge"
        );

        encoder.note_peer_instructions(&instructions);

        // Second section: now the acknowledged entries are indexed.
        let second = encoder.encode(&headers());

        assert_ne!(
            second.payload()[0],
            0,
            "the section must reference the table"
        );
        assert!(second.payload().len() < first.payload().len());
        assert!(
            deliver(&mut encoder_stream, &peer).unwrap() == 0,
            "nothing new to insert"
        );

        let decoded = peer.decode(&second, 4).unwrap();

        assert_eq!(decoded.get(":method"), Some("CONNECT"));
        assert_eq!(decoded.get(":protocol"), Some("webtransport"));
        assert_eq!(decoded.get(":authority"), Some("example.com"));
    }

    /// What a peer that advertised less would do if the encoder ignored its limit.
    #[test]
    fn a_capacity_beyond_the_peers_is_an_encoder_stream_error() {
        let (peer, _peer_stream) = QpackDecoderState::new(4096);

        // The value a table sized from local settings would have asked for.
        assert!(matches!(
            peer.feed_encoder_stream(&Encoder::encode_set_capacity(65536)),
            Err(ErrorCode::EncoderStream)
        ));
    }

    #[test]
    fn a_cancellation_is_only_sent_with_a_table() {
        let (state, mut receiver) = QpackDecoderState::new(0);

        state.cancel_stream(4);
        assert!(receiver.try_recv().is_err());

        let (state, mut receiver) = QpackDecoderState::new(4096);

        state.cancel_stream(4);
        assert_eq!(instructions(&mut receiver).stream_cancellations, vec![4]);
    }
}
