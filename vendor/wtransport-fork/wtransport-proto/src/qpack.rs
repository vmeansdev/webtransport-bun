use crate::bytes::BufferReader;
use crate::bytes::BytesReader;
use crate::bytes::BytesWriter;
use crate::bytes::EndOfBuffer;
use std::collections::HashMap;
use std::collections::VecDeque;

/// Usage: `const_assert!(Var1: Ty, Var2: Ty, ... => expression)`
macro_rules! const_assert {
    ($($list:ident : $ty:ty),* => $expr:expr) => {{
        struct Assert<$(const $list: usize,)*>;
        impl<$(const $list: $ty,)*> Assert<$($list,)*> {
            const OK: u8 = 0 - !($expr) as u8;
        }
        Assert::<$($list,)*>::OK
    }};
    ($expr:expr) => {
        const OK: u8 = 0 - !($expr) as u8;
    };
}

/// Error during decoding operation.
///
/// Generated from [`Decoder::decode`].
#[derive(Debug, thiserror::Error)]
pub enum DecodingError {
    /// During decoding input data raeched unexpected EOF.
    #[error("end of stream reached prematurely")]
    UnexpectedFin,

    /// Integer decoding produced an overflow.
    #[error("integer overflow")]
    IntegerOverflow,

    /// String decoding is invalid (UTF-8 fail or Huffman).
    #[error("invalid string decoding")]
    InvalidString,

    /// Encoded data requires dynamic table. It is not supported.
    ///
    /// Returned when decoding against a table whose capacity is zero, that is
    /// when dynamic QPACK has not been negotiated.
    #[error("dynamic table is not supported")]
    DynamicNotSupported,

    /// Index is out-of-bound in the static table.
    #[error("index not found in the static table")]
    IndexNotfound,

    /// Index refers to a dynamic entry that was never inserted or was evicted.
    #[error("index not found in the dynamic table")]
    DynamicIndexNotFound,

    /// The encoded required insert count is not a valid value.
    #[error("invalid required insert count")]
    InvalidRequiredInsertCount,

    /// The field section references inserts the decoder has not received yet.
    ///
    /// Since `SETTINGS_QPACK_BLOCKED_STREAMS` is always advertised as zero, a
    /// peer must never send such a section: this is a connection error.
    #[error("field section is blocked on missing dynamic table inserts")]
    Blocked,
}

/// Error during a dynamic table operation.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DynamicTableError {
    /// A *Set Dynamic Table Capacity* asked for more than the advertised maximum.
    #[error("capacity exceeds the advertised maximum")]
    CapacityExceeded,

    /// An entry does not fit in the table, or would evict an entry that must be kept.
    #[error("entry does not fit in the dynamic table")]
    EntryDoesNotFit,

    /// An instruction referenced an entry that is not in the table.
    #[error("index not found in the dynamic table")]
    IndexNotFound,
}

/// Error while applying an encoder stream instruction.
#[derive(Debug, thiserror::Error)]
pub enum EncoderStreamError {
    /// The instruction is malformed.
    #[error(transparent)]
    Decoding(#[from] DecodingError),

    /// The instruction cannot be applied to the dynamic table.
    #[error(transparent)]
    Table(#[from] DynamicTableError),
}

/// An encoder stream instruction (RFC 9204 Section 4.3).
enum EncoderInstruction {
    InsertWithNameReference {
        is_static: bool,
        index: usize,
        value: String,
    },
    InsertWithLiteralName {
        name: String,
        value: String,
    },
    SetCapacity {
        capacity: usize,
    },
    Duplicate {
        index: usize,
    },
}

/// A decoder stream instruction (RFC 9204 Section 4.4).
enum DecoderInstruction {
    SectionAcknowledgement(usize),
    StreamCancellation(usize),
    InsertCountIncrement(usize),
}

/// How one header field is represented in a field section.
enum PlannedField {
    /// A dynamic table entry, by absolute index.
    Dynamic(u64),
    /// A static table entry holding both the name and the value.
    Static(usize),
    /// A static table entry holding the name, with the value sent literally.
    StaticName(usize),
    /// Name and value both sent literally.
    Literal,
}

/// A field section, with the encoder stream instructions that must accompany it.
#[derive(Debug)]
pub struct EncodedSection {
    /// The field section itself, to be carried in a `HEADERS` frame.
    pub payload: Vec<u8>,

    /// Inserts to replicate on the encoder stream, so later sections can index them.
    /// Nothing in `payload` depends on these having arrived.
    pub instructions: Vec<u8>,
}

/// Instructions received on the peer's decoder stream (RFC 9204 Section 4.4).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct DecoderInstructions {
    /// Streams whose field section the peer has fully decoded.
    pub section_acknowledgements: Vec<u64>,

    /// Streams the peer has abandoned without decoding their field sections.
    pub stream_cancellations: Vec<u64>,

    /// Total increase of the peer's known received count.
    pub insert_count_increment: u64,
}

#[derive(Debug, Clone)]
struct DynamicEntry {
    name: String,
    value: String,
}

impl DynamicEntry {
    /// Entry size as defined by RFC 9204 Section 3.2.1.
    fn size(name: &str, value: &str) -> usize {
        name.len().saturating_add(value.len()).saturating_add(32)
    }
}

/// QPACK dynamic table (RFC 9204 Section 3.2).
///
/// The table is bounded by `max_capacity`, the value advertised in
/// `SETTINGS_QPACK_MAX_TABLE_CAPACITY`. Its working capacity starts at zero and
/// is raised by the peer with a *Set Dynamic Table Capacity* instruction.
#[derive(Debug, Clone)]
pub struct DynamicTable {
    /// Oldest entry at the front, newest at the back.
    entries: VecDeque<DynamicEntry>,
    capacity: usize,
    max_capacity: usize,
    size: usize,
    insert_count: u64,
}

impl DynamicTable {
    /// Constructs an empty table bounded by `max_capacity` bytes.
    ///
    /// A `max_capacity` of zero disables the dynamic table.
    pub fn new(max_capacity: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            capacity: 0,
            max_capacity,
            size: 0,
            insert_count: 0,
        }
    }

    /// Total number of entries ever inserted.
    ///
    /// This is also the absolute index of the newest entry, as absolute indexes
    /// are one-based (RFC 9204 Section 3.2.4).
    pub fn insert_count(&self) -> u64 {
        self.insert_count
    }

    /// Current capacity, in bytes.
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Maximum capacity the table may be set to, in bytes.
    pub fn max_capacity(&self) -> usize {
        self.max_capacity
    }

    /// Sum of the sizes of the entries currently in the table.
    pub fn size(&self) -> usize {
        self.size
    }

    /// Number of entries currently in the table.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the table holds no entry.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// `MaxEntries` as defined by RFC 9204 Section 3.2.4.
    pub fn max_entries(&self) -> u64 {
        (self.max_capacity / 32) as u64
    }

    /// Applies a *Set Dynamic Table Capacity* instruction (RFC 9204 Section 4.3.1).
    pub fn set_capacity(&mut self, capacity: usize) -> Result<(), DynamicTableError> {
        self.set_capacity_with_ack_floor(capacity, None)
    }

    /// Like [`Self::set_capacity`], but refuses to evict entries with an absolute
    /// index greater than `ack_floor` (the Known Received Count).
    pub fn set_capacity_with_ack_floor(
        &mut self,
        capacity: usize,
        ack_floor: Option<u64>,
    ) -> Result<(), DynamicTableError> {
        if capacity > self.max_capacity {
            return Err(DynamicTableError::CapacityExceeded);
        }

        self.capacity = capacity;
        self.evict_to_fit(0, ack_floor)
    }

    /// Inserts an entry, evicting the oldest ones as needed.
    pub fn insert(&mut self, name: String, value: String) -> Result<(), DynamicTableError> {
        self.insert_with_ack_floor(name, value, None)
    }

    /// Like [`Self::insert`], but refuses to evict entries with an absolute index
    /// greater than `ack_floor` (RFC 9204 Section 2.1.1).
    ///
    /// Encoders must not evict entries the peer might still reference.
    pub fn insert_with_ack_floor(
        &mut self,
        name: String,
        value: String,
        ack_floor: Option<u64>,
    ) -> Result<(), DynamicTableError> {
        let size = DynamicEntry::size(&name, &value);

        if size > self.capacity {
            return Err(DynamicTableError::EntryDoesNotFit);
        }

        self.evict_to_fit(size, ack_floor)?;

        self.entries.push_back(DynamicEntry { name, value });
        self.size = self.size.saturating_add(size);
        self.insert_count = self.insert_count.saturating_add(1);

        Ok(())
    }

    /// Duplicates the entry at `relative` from the newest one (RFC 9204 Section 4.3.4).
    pub fn duplicate(&mut self, relative: u64) -> Result<(), DynamicTableError> {
        let absolute = self
            .insert_count
            .checked_sub(relative)
            .ok_or(DynamicTableError::IndexNotFound)?;

        let (name, value) = self
            .get_absolute(absolute)
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .ok_or(DynamicTableError::IndexNotFound)?;

        self.insert(name, value)
    }

    fn evict_to_fit(
        &mut self,
        additional: usize,
        ack_floor: Option<u64>,
    ) -> Result<(), DynamicTableError> {
        while !self.entries.is_empty() && self.size.saturating_add(additional) > self.capacity {
            let oldest = self.oldest_absolute().expect("table is not empty");

            if let Some(floor) = ack_floor {
                if oldest > floor {
                    return Err(DynamicTableError::EntryDoesNotFit);
                }
            }

            let entry = self.entries.pop_front().expect("table is not empty");
            self.size = self
                .size
                .saturating_sub(DynamicEntry::size(&entry.name, &entry.value));
        }

        if self.size.saturating_add(additional) > self.capacity {
            return Err(DynamicTableError::EntryDoesNotFit);
        }

        Ok(())
    }

    /// Absolute index of the oldest entry, if any.
    fn oldest_absolute(&self) -> Option<u64> {
        if self.entries.is_empty() {
            None
        } else {
            Some(self.insert_count - self.entries.len() as u64 + 1)
        }
    }

    /// Looks up an entry by absolute index (one-based).
    ///
    /// Returns `None` if the entry was evicted or was never inserted.
    pub fn get_absolute(&self, absolute: u64) -> Option<(&str, &str)> {
        if absolute == 0 {
            return None;
        }

        let oldest = self.oldest_absolute()?;

        if absolute < oldest || absolute > self.insert_count {
            return None;
        }

        let entry = self.entries.get((absolute - oldest) as usize)?;

        Some((entry.name.as_str(), entry.value.as_str()))
    }

    /// Looks up an entry by index relative to `base` (RFC 9204 Section 3.2.5).
    ///
    /// Relative index 0 is the entry inserted just before `base`. The RFC numbers
    /// absolute indexes from zero and so writes this as `base - relative - 1`; here
    /// they are numbered from one, which cancels the offset out.
    pub fn get_relative(&self, relative: u64, base: u64) -> Option<(&str, &str)> {
        let absolute = base.checked_sub(relative)?;
        self.get_absolute(absolute)
    }

    /// Looks up an entry by post-base index (RFC 9204 Section 3.2.6).
    pub fn get_post_base(&self, post_base: u64, base: u64) -> Option<(&str, &str)> {
        let absolute = base.checked_add(post_base)?.checked_add(1)?;
        self.get_absolute(absolute)
    }

    /// Absolute index of the newest entry matching `name` and `value`, if any.
    pub fn find_absolute(&self, name: &str, value: &str) -> Option<u64> {
        let oldest = self.oldest_absolute()?;

        self.entries
            .iter()
            .rposition(|entry| entry.name == name && entry.value == value)
            .map(|position| oldest + position as u64)
    }
}

/// Encodes a required insert count for the wire (RFC 9204 Section 4.5.1.1).
///
/// `max_entries` must be derived from the *decoder's* advertised maximum table
/// capacity. Returns `None` when the value cannot be represented, that is when
/// a non-zero count is encoded against a zero-capacity table.
pub(crate) fn encode_required_insert_count(
    required_insert_count: u64,
    max_entries: u64,
) -> Option<u64> {
    if required_insert_count == 0 {
        return Some(0);
    }

    if max_entries == 0 {
        return None;
    }

    Some((required_insert_count % (2 * max_entries)) + 1)
}

/// Reconstructs a required insert count from the wire (RFC 9204 Section 4.5.1.1).
///
/// `total_inserts` is the number of inserts the decoder has received so far.
pub(crate) fn decode_required_insert_count(
    encoded: u64,
    max_entries: u64,
    total_inserts: u64,
) -> Result<u64, DecodingError> {
    if encoded == 0 {
        return Ok(0);
    }

    if max_entries == 0 {
        return Err(DecodingError::InvalidRequiredInsertCount);
    }

    let full_range = 2u64
        .checked_mul(max_entries)
        .ok_or(DecodingError::InvalidRequiredInsertCount)?;

    let max_value = total_inserts
        .checked_add(max_entries)
        .ok_or(DecodingError::InvalidRequiredInsertCount)?;

    let max_wrapped = (max_value / full_range) * full_range;

    let mut required_insert_count = max_wrapped
        .checked_add(encoded)
        .ok_or(DecodingError::InvalidRequiredInsertCount)?
        .checked_sub(1)
        .ok_or(DecodingError::InvalidRequiredInsertCount)?;

    if required_insert_count > max_value {
        if required_insert_count <= max_value.saturating_add(max_entries) {
            required_insert_count = required_insert_count
                .checked_sub(full_range)
                .ok_or(DecodingError::InvalidRequiredInsertCount)?;
        } else {
            return Err(DecodingError::InvalidRequiredInsertCount);
        }
    }

    if required_insert_count == 0 {
        return Err(DecodingError::InvalidRequiredInsertCount);
    }

    Ok(required_insert_count)
}

enum FieldLineType {
    Indexed,
    IndexedPost,
    LiteralRefName,
    LiteralPostRefName,
    LiteralLitName,
}

/// Outcome of decoding a field section.
#[derive(Debug)]
pub struct DecodedHeaders {
    /// The decoded fields.
    pub headers: HashMap<String, String>,

    /// Required insert count of the section.
    ///
    /// A non-zero value means the section referenced the dynamic table and must
    /// be acknowledged on the decoder stream (RFC 9204 Section 4.4.1).
    pub required_insert_count: u64,
}

/// QPACK decoder.
///
/// Field sections are decoded against a [`DynamicTable`]. Decoding with a table
/// of zero capacity is stateless: any data requiring the dynamic table ends up
/// in a [`DecodingError::DynamicNotSupported`] error.
pub struct Decoder;

impl Decoder {
    /// Decodes a field section without a dynamic table.
    ///
    /// Result is an hash-map of headers.
    pub fn decode<D>(data: D) -> Result<HashMap<String, String>, DecodingError>
    where
        D: AsRef<[u8]>,
    {
        Self::decode_with(&DynamicTable::new(0), data).map(|decoded| decoded.headers)
    }

    /// Decodes a field section against the dynamic `table`.
    pub fn decode_with<D>(table: &DynamicTable, data: D) -> Result<DecodedHeaders, DecodingError>
    where
        D: AsRef<[u8]>,
    {
        let mut buffer_reader = BufferReader::new(data.as_ref());

        let encoded_ric = Self::decode_integer::<8, _>(&mut buffer_reader)?.1 as u64;
        let required_insert_count =
            decode_required_insert_count(encoded_ric, table.max_entries(), table.insert_count())?;

        if required_insert_count > table.insert_count() {
            // `SETTINGS_QPACK_BLOCKED_STREAMS` is zero: the peer must not send
            // a section that cannot be decoded right away.
            return Err(DecodingError::Blocked);
        }

        let (sign, delta_base) = Self::decode_integer::<7, _>(&mut buffer_reader)?;
        let base = if sign & 0b1 == 0 {
            required_insert_count
                .checked_add(delta_base as u64)
                .ok_or(DecodingError::IntegerOverflow)?
        } else {
            required_insert_count
                .checked_sub(delta_base as u64)
                .and_then(|base| base.checked_sub(1))
                .ok_or(DecodingError::InvalidRequiredInsertCount)?
        };

        let mut headers = HashMap::new();

        while buffer_reader.capacity() > 0 {
            let field = buffer_reader.buffer_remaining()[0];

            match Self::decode_field_line_type(field) {
                FieldLineType::Indexed => {
                    let is_dynamic = field & 0b0100_0000 == 0;
                    let index = Self::decode_integer::<6, _>(&mut buffer_reader)?.1;

                    let (key, value) = if is_dynamic {
                        Self::lookup_relative(table, index as u64, base)?
                    } else {
                        StaticTable::lookup_field(index)
                            .map(|(key, value)| (key.to_string(), value.to_string()))
                            .ok_or(DecodingError::IndexNotfound)?
                    };

                    headers.insert(key, value);
                }
                FieldLineType::IndexedPost => {
                    let index = Self::decode_integer::<4, _>(&mut buffer_reader)?.1;
                    let (key, value) = Self::lookup_post_base(table, index as u64, base)?;

                    headers.insert(key, value);
                }
                FieldLineType::LiteralRefName => {
                    let is_dynamic = field & 0b0001_0000 == 0;
                    let index = Self::decode_integer::<4, _>(&mut buffer_reader)?.1;

                    let key = if is_dynamic {
                        Self::lookup_relative(table, index as u64, base)?.0
                    } else {
                        StaticTable::lookup_field(index)
                            .map(|(key, _)| key.to_string())
                            .ok_or(DecodingError::IndexNotfound)?
                    };

                    let value = Self::decode_string::<7, _>(&mut buffer_reader)?;

                    headers.insert(key, value);
                }
                FieldLineType::LiteralPostRefName => {
                    let index = Self::decode_integer::<3, _>(&mut buffer_reader)?.1;
                    let key = Self::lookup_post_base(table, index as u64, base)?.0;
                    let value = Self::decode_string::<7, _>(&mut buffer_reader)?;

                    headers.insert(key, value);
                }
                FieldLineType::LiteralLitName => {
                    let key = Self::decode_string::<3, _>(&mut buffer_reader)?;
                    let value = Self::decode_string::<7, _>(&mut buffer_reader)?;

                    headers.insert(key, value);
                }
            }
        }

        Ok(DecodedHeaders {
            headers,
            required_insert_count,
        })
    }

    /// Applies encoder stream instructions to the dynamic `table`
    /// (RFC 9204 Section 4.3).
    ///
    /// Returns how many bytes were consumed. A trailing partial instruction is
    /// left unconsumed, so the caller can retry once more data arrives.
    pub fn feed_encoder_stream(
        table: &mut DynamicTable,
        data: &[u8],
    ) -> Result<usize, EncoderStreamError> {
        let mut buffer_reader = BufferReader::new(data);

        loop {
            if buffer_reader.capacity() == 0 {
                break;
            }

            let first = buffer_reader.buffer_remaining()[0];
            let mut instruction = buffer_reader.child();

            match Self::decode_encoder_instruction(&mut *instruction, first) {
                Ok(instruction_decoded) => {
                    instruction.commit();
                    Self::apply_encoder_instruction(table, instruction_decoded)?;
                }
                // The instruction is incomplete: leave it for the next read.
                Err(DecodingError::UnexpectedFin) => break,
                Err(error) => return Err(error.into()),
            }
        }

        Ok(buffer_reader.offset())
    }

    fn decode_encoder_instruction<'a, R>(
        bytes_reader: &mut R,
        first: u8,
    ) -> Result<EncoderInstruction, DecodingError>
    where
        R: BytesReader<'a>,
    {
        if first & 0b1000_0000 != 0 {
            // Insert With Name Reference: 1 T index(6) value.
            let (flags, index) = Self::decode_integer::<6, _>(bytes_reader)?;
            let value = Self::decode_string::<7, _>(bytes_reader)?;

            Ok(EncoderInstruction::InsertWithNameReference {
                is_static: flags & 0b1 == 0b1,
                index,
                value,
            })
        } else if first & 0b0100_0000 != 0 {
            // Insert With Literal Name: 01 H name-len(5) name value.
            let name = Self::decode_string::<5, _>(bytes_reader)?;
            let value = Self::decode_string::<7, _>(bytes_reader)?;

            Ok(EncoderInstruction::InsertWithLiteralName { name, value })
        } else if first & 0b0010_0000 != 0 {
            // Set Dynamic Table Capacity: 001 capacity(5).
            let capacity = Self::decode_integer::<5, _>(bytes_reader)?.1;

            Ok(EncoderInstruction::SetCapacity { capacity })
        } else {
            // Duplicate: 000 index(5).
            let index = Self::decode_integer::<5, _>(bytes_reader)?.1;

            Ok(EncoderInstruction::Duplicate { index })
        }
    }

    fn apply_encoder_instruction(
        table: &mut DynamicTable,
        instruction: EncoderInstruction,
    ) -> Result<(), EncoderStreamError> {
        match instruction {
            EncoderInstruction::InsertWithNameReference {
                is_static,
                index,
                value,
            } => {
                let name = if is_static {
                    StaticTable::lookup_field(index)
                        .ok_or(DecodingError::IndexNotfound)?
                        .0
                        .to_string()
                } else {
                    let absolute = table
                        .insert_count()
                        .checked_sub(index as u64)
                        .ok_or(DynamicTableError::IndexNotFound)?;

                    table
                        .get_absolute(absolute)
                        .ok_or(DynamicTableError::IndexNotFound)?
                        .0
                        .to_string()
                };

                table.insert(name, value)?;
            }
            EncoderInstruction::InsertWithLiteralName { name, value } => {
                table.insert(name, value)?;
            }
            EncoderInstruction::SetCapacity { capacity } => {
                table.set_capacity(capacity)?;
            }
            EncoderInstruction::Duplicate { index } => {
                table.duplicate(index as u64)?;
            }
        }

        Ok(())
    }

    fn lookup_relative(
        table: &DynamicTable,
        index: u64,
        base: u64,
    ) -> Result<(String, String), DecodingError> {
        if table.max_capacity() == 0 {
            return Err(DecodingError::DynamicNotSupported);
        }

        table
            .get_relative(index, base)
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .ok_or(DecodingError::DynamicIndexNotFound)
    }

    fn lookup_post_base(
        table: &DynamicTable,
        index: u64,
        base: u64,
    ) -> Result<(String, String), DecodingError> {
        if table.max_capacity() == 0 {
            return Err(DecodingError::DynamicNotSupported);
        }

        table
            .get_post_base(index, base)
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .ok_or(DecodingError::DynamicIndexNotFound)
    }

    fn decode_field_line_type(byte: u8) -> FieldLineType {
        const MASK_INDEXED: u8 = 0b0000_0001;
        const MASK_INDEXED_POST: u8 = 0b0000_0001;
        const MASK_LITERAL_REF_NAME: u8 = 0b0000_0001;
        const MASK_LITERAL_POST_REF_NAME: u8 = 0b0000_0000;
        const MASK_LITERAL_LIT_NAME: u8 = 0b0000_0001;

        if byte >> 7 == MASK_INDEXED {
            FieldLineType::Indexed
        } else if byte >> 4 == MASK_INDEXED_POST {
            FieldLineType::IndexedPost
        } else if byte >> 6 == MASK_LITERAL_REF_NAME {
            FieldLineType::LiteralRefName
        } else if byte >> 4 == MASK_LITERAL_POST_REF_NAME {
            FieldLineType::LiteralPostRefName
        } else if byte >> 5 == MASK_LITERAL_LIT_NAME {
            FieldLineType::LiteralLitName
        } else {
            unreachable!()
        }
    }

    fn decode_integer<'a, const N: usize, R>(
        bytes_reader: &mut R,
    ) -> Result<(u8, usize), DecodingError>
    where
        R: BytesReader<'a>,
    {
        const_assert!(N: usize => N <= 8 && N >= 1);

        let byte = bytes_reader
            .get_bytes(1)
            .ok_or(DecodingError::UnexpectedFin)?[0] as usize;

        let mask = (0x01 << N) - 1;
        let flags = (byte >> N) as u8;
        let mut value = byte & mask;

        if value != mask {
            return Ok((flags, value));
        }

        let mut power = 0;
        loop {
            let byte = bytes_reader
                .get_bytes(1)
                .ok_or(DecodingError::UnexpectedFin)?[0] as usize;

            value = value
                .checked_add((byte & 0x7F) << power)
                .ok_or(DecodingError::IntegerOverflow)?;

            power += 7;

            if byte & 0x80 == 0 {
                break;
            }

            // A continuation run this long cannot encode anything representable, and
            // the shift below would be wider than the integer itself.
            if power >= usize::BITS as usize {
                return Err(DecodingError::IntegerOverflow);
            }
        }

        Ok((flags, value))
    }

    fn decode_string<'a, const N: usize, R>(bytes_reader: &mut R) -> Result<String, DecodingError>
    where
        R: BytesReader<'a>,
    {
        let (flags, string_len) = Self::decode_integer::<N, R>(bytes_reader)?;

        let is_huffman = flags & 0x1 == 0x1;

        let string_data = bytes_reader
            .get_bytes(string_len)
            .ok_or(DecodingError::UnexpectedFin)?;

        let string_data = if is_huffman {
            let mut string_dec = Vec::with_capacity(string_len);

            httlib_huffman::decode(
                string_data,
                &mut string_dec,
                httlib_huffman::DecoderSpeed::OneBit,
            )
            .map_err(|_| DecodingError::InvalidString)?;

            string_dec
        } else {
            string_data.to_vec()
        };

        String::from_utf8(string_data).map_err(|_| DecodingError::InvalidString)
    }
}

/// QPACK encoder.
///
/// It only supports stateless decoding, so all encoding
/// will be performed by means of the static table.
pub struct Encoder;

impl Encoder {
    /// Encodes headers into data to be transmitted.
    pub fn encode<H, K, V>(headers: H) -> Box<[u8]>
    where
        H: IntoIterator<Item = (K, V)>,
        K: AsRef<str>,
        V: AsRef<str>,
    {
        let mut buffer = Vec::new();

        Self::encode_field_section_prefix(0, 0, 0, &mut buffer).expect("static section prefix");

        for (key, value) in headers.into_iter() {
            match StaticTable::lookup_index(key.as_ref(), value.as_ref()) {
                Some(LookupIndexFound::KeyValue(index)) => {
                    Self::encode_integer::<6, _>(0b11, index as u64, &mut buffer)
                        .expect("vec does not eof");
                }
                Some(LookupIndexFound::KeyOnly(index)) => {
                    Self::encode_integer::<4, _>(0b0101, index as u64, &mut buffer)
                        .expect("vec does not eof");
                    Self::encode_string::<7, _, _>(0, value, &mut buffer)
                        .expect("vec does not eof");
                }
                None => {
                    Self::encode_string::<3, _, _>(0b10, key, &mut buffer)
                        .expect("vec does not eof");
                    Self::encode_string::<7, _, _>(0, value, &mut buffer)
                        .expect("vec does not eof");
                }
            }
        }

        buffer.into_boxed_slice()
    }

    /// Encodes headers against a dynamic table, for a peer that offered one.
    ///
    /// `table` must have been sized from the *peer's* advertised capacity, since it is
    /// the peer that has to hold it and the required insert count is encoded modulo its
    /// `MaxEntries` (RFC 9204 Sections 3.2.3 and 4.5.1.1).
    ///
    /// Only entries the peer has acknowledged are referenced. `known_received_count` is
    /// the number of inserts it has confirmed: with `SETTINGS_QPACK_BLOCKED_STREAMS` at
    /// zero, referencing anything beyond that risks a section arriving before the insert
    /// it needs, which the peer would have to treat as a connection error. Fields that
    /// cannot be referenced yet are sent literally and inserted for a later section.
    pub fn encode_with<H, K, V>(
        table: &mut DynamicTable,
        known_received_count: u64,
        headers: H,
    ) -> EncodedSection
    where
        H: IntoIterator<Item = (K, V)>,
        K: AsRef<str>,
        V: AsRef<str>,
    {
        let headers = headers
            .into_iter()
            .map(|(key, value)| (key.as_ref().to_string(), value.as_ref().to_string()))
            .collect::<Vec<_>>();

        let fields = headers
            .iter()
            .map(|(name, value)| Self::plan_field(table, known_received_count, name, value))
            .collect::<Vec<_>>();

        // The required insert count is the largest absolute index referenced, and the
        // base is put right there so every reference is a plain relative index.
        let required_insert_count = fields
            .iter()
            .filter_map(|field| match field {
                PlannedField::Dynamic(absolute) => Some(*absolute),
                _ => None,
            })
            .max()
            .unwrap_or(0);

        let mut payload = Vec::new();

        if Self::encode_field_section_prefix(
            required_insert_count,
            required_insert_count,
            table.max_entries(),
            &mut payload,
        )
        .is_none()
        {
            // Not representable against this peer's table: fall back to the static one.
            return EncodedSection {
                payload: Self::encode(headers.iter().map(|(name, value)| (name, value))).to_vec(),
                instructions: Vec::new(),
            };
        }

        for (field, (name, value)) in fields.iter().zip(headers.iter()) {
            match field {
                PlannedField::Dynamic(absolute) => {
                    let relative = required_insert_count - absolute;
                    Self::encode_integer::<6, _>(0b10, relative, &mut payload)
                        .expect("vec does not eof");
                }
                PlannedField::Static(index) => {
                    Self::encode_integer::<6, _>(0b11, *index as u64, &mut payload)
                        .expect("vec does not eof");
                }
                PlannedField::StaticName(index) => {
                    Self::encode_integer::<4, _>(0b0101, *index as u64, &mut payload)
                        .expect("vec does not eof");
                    Self::encode_string::<7, _, _>(0, value, &mut payload)
                        .expect("vec does not eof");
                }
                PlannedField::Literal => {
                    Self::encode_string::<3, _, _>(0b10, name, &mut payload)
                        .expect("vec does not eof");
                    Self::encode_string::<7, _, _>(0, value, &mut payload)
                        .expect("vec does not eof");
                }
            }
        }

        let instructions = Self::insert_for_later(table, known_received_count, &fields, &headers);

        EncodedSection {
            payload,
            instructions,
        }
    }

    fn plan_field(
        table: &DynamicTable,
        known_received_count: u64,
        name: &str,
        value: &str,
    ) -> PlannedField {
        if let Some(absolute) = table.find_absolute(name, value) {
            if absolute <= known_received_count {
                return PlannedField::Dynamic(absolute);
            }
        }

        match StaticTable::lookup_index(name, value) {
            Some(LookupIndexFound::KeyValue(index)) => PlannedField::Static(index),
            Some(LookupIndexFound::KeyOnly(index)) => PlannedField::StaticName(index),
            None => PlannedField::Literal,
        }
    }

    /// Inserts the fields this section had to send literally, so a later one can index
    /// them, and returns the encoder stream instructions that replicate the inserts.
    ///
    /// Nothing the section just referenced may be evicted to make room: the peer applies
    /// these inserts on a different stream and could otherwise drop an entry before
    /// reading the section that needs it.
    fn insert_for_later(
        table: &mut DynamicTable,
        known_received_count: u64,
        fields: &[PlannedField],
        headers: &[(String, String)],
    ) -> Vec<u8> {
        let mut instructions = Vec::new();

        if table.max_capacity() == 0 {
            return instructions;
        }

        let referenced_floor = fields
            .iter()
            .filter_map(|field| match field {
                PlannedField::Dynamic(absolute) => Some(*absolute),
                _ => None,
            })
            .min()
            .map(|lowest| lowest - 1)
            .unwrap_or(known_received_count);

        let floor = referenced_floor.min(known_received_count);

        for (field, (name, value)) in fields.iter().zip(headers.iter()) {
            if matches!(field, PlannedField::Dynamic(_)) {
                continue;
            }

            if table.find_absolute(name, value).is_some() {
                continue;
            }

            let instruction = match StaticTable::lookup_index(name, value) {
                Some(LookupIndexFound::KeyValue(index))
                | Some(LookupIndexFound::KeyOnly(index)) => {
                    Self::encode_insert_with_name_reference(true, index as u64, value)
                }
                None => Self::encode_insert_with_literal_name(name, value),
            };

            // An entry that does not fit is simply not indexed; the section already
            // carries it literally.
            if table
                .insert_with_ack_floor(name.clone(), value.clone(), Some(floor))
                .is_ok()
            {
                instructions.extend(instruction);
            }
        }

        instructions
    }

    /// Encodes the prefix a field section starts with (RFC 9204 Section 4.5.1).
    ///
    /// `max_entries` must be derived from the *peer's* advertised maximum table
    /// capacity, since the required insert count is encoded modulo it. Returns `None`
    /// when a non-zero count is encoded against a peer that offered no table.
    pub fn encode_section_prefix(
        required_insert_count: u64,
        base: u64,
        max_entries: u64,
    ) -> Option<Vec<u8>> {
        let mut buffer = Vec::new();

        Self::encode_field_section_prefix(required_insert_count, base, max_entries, &mut buffer)?;

        Some(buffer)
    }

    /// Encodes a *Set Dynamic Table Capacity* instruction (RFC 9204 Section 4.3.1).
    pub fn encode_set_capacity(capacity: usize) -> Vec<u8> {
        let mut buffer = Vec::new();
        Self::encode_integer::<5, _>(0b001, capacity as u64, &mut buffer)
            .expect("vec does not eof");
        buffer
    }

    /// Encodes an *Insert With Name Reference* instruction (RFC 9204 Section 4.3.2).
    ///
    /// `index` is a static table index when `is_static`, otherwise an index
    /// relative to the newest entry of the dynamic table.
    pub fn encode_insert_with_name_reference(is_static: bool, index: u64, value: &str) -> Vec<u8> {
        let mut buffer = Vec::new();
        let flags = if is_static { 0b11 } else { 0b10 };

        Self::encode_integer::<6, _>(flags, index, &mut buffer).expect("vec does not eof");
        Self::encode_string::<7, _, _>(0, value, &mut buffer).expect("vec does not eof");

        buffer
    }

    /// Encodes an *Insert With Literal Name* instruction (RFC 9204 Section 4.3.3).
    pub fn encode_insert_with_literal_name(name: &str, value: &str) -> Vec<u8> {
        let mut buffer = Vec::new();

        Self::encode_string::<5, _, _>(0b01, name, &mut buffer).expect("vec does not eof");
        Self::encode_string::<7, _, _>(0, value, &mut buffer).expect("vec does not eof");

        buffer
    }

    /// Encodes a *Duplicate* instruction (RFC 9204 Section 4.3.4).
    pub fn encode_duplicate(index: u64) -> Vec<u8> {
        let mut buffer = Vec::new();
        Self::encode_integer::<5, _>(0b000, index, &mut buffer).expect("vec does not eof");
        buffer
    }

    /// Encodes a *Section Acknowledgement* instruction (RFC 9204 Section 4.4.1).
    pub fn encode_section_acknowledgement(stream_id: u64) -> Vec<u8> {
        let mut buffer = Vec::new();
        Self::encode_integer::<7, _>(0b1, stream_id, &mut buffer).expect("vec does not eof");
        buffer
    }

    /// Encodes a *Stream Cancellation* instruction (RFC 9204 Section 4.4.2).
    ///
    /// Must be sent when a stream carrying field sections that have not been
    /// acknowledged is reset or abandoned: it releases the references the peer
    /// encoder is holding, which would otherwise stall its eviction.
    pub fn encode_stream_cancellation(stream_id: u64) -> Vec<u8> {
        let mut buffer = Vec::new();
        Self::encode_integer::<6, _>(0b01, stream_id, &mut buffer).expect("vec does not eof");
        buffer
    }

    /// Encodes an *Insert Count Increment* instruction (RFC 9204 Section 4.4.3).
    pub fn encode_insert_count_increment(increment: u64) -> Vec<u8> {
        let mut buffer = Vec::new();
        Self::encode_integer::<6, _>(0b00, increment, &mut buffer).expect("vec does not eof");
        buffer
    }

    /// Parses instructions from the peer's decoder stream (RFC 9204 Section 4.4).
    ///
    /// Returns how many bytes were consumed together with the instructions. A
    /// trailing partial instruction is left unconsumed.
    pub fn feed_decoder_stream(data: &[u8]) -> Result<(usize, DecoderInstructions), DecodingError> {
        let mut buffer_reader = BufferReader::new(data);
        let mut instructions = DecoderInstructions::default();

        loop {
            if buffer_reader.capacity() == 0 {
                break;
            }

            let first = buffer_reader.buffer_remaining()[0];
            let mut instruction = buffer_reader.child();

            let decoded = if first & 0b1000_0000 != 0 {
                Decoder::decode_integer::<7, _>(&mut *instruction)
                    .map(|(_, stream_id)| DecoderInstruction::SectionAcknowledgement(stream_id))
            } else if first & 0b0100_0000 != 0 {
                Decoder::decode_integer::<6, _>(&mut *instruction)
                    .map(|(_, stream_id)| DecoderInstruction::StreamCancellation(stream_id))
            } else {
                Decoder::decode_integer::<6, _>(&mut *instruction)
                    .map(|(_, increment)| DecoderInstruction::InsertCountIncrement(increment))
            };

            match decoded {
                Ok(decoded) => {
                    instruction.commit();

                    match decoded {
                        DecoderInstruction::SectionAcknowledgement(stream_id) => {
                            instructions.section_acknowledgements.push(stream_id as u64)
                        }
                        DecoderInstruction::StreamCancellation(stream_id) => {
                            instructions.stream_cancellations.push(stream_id as u64)
                        }
                        DecoderInstruction::InsertCountIncrement(increment) => {
                            instructions.insert_count_increment = instructions
                                .insert_count_increment
                                .saturating_add(increment as u64)
                        }
                    }
                }
                // The instruction is incomplete: leave it for the next read.
                Err(DecodingError::UnexpectedFin) => break,
                Err(error) => return Err(error),
            }
        }

        Ok((buffer_reader.offset(), instructions))
    }

    /// Encodes the required insert count and base of a field section
    /// (RFC 9204 Section 4.5.1).
    ///
    /// `max_entries` must be derived from the *peer's* advertised maximum table
    /// capacity. Returns `None` when the count cannot be represented.
    fn encode_field_section_prefix<W>(
        required_insert_count: u64,
        base: u64,
        max_entries: u64,
        bytes_writer: &mut W,
    ) -> Option<()>
    where
        W: BytesWriter,
    {
        let encoded = encode_required_insert_count(required_insert_count, max_entries)?;

        Self::encode_integer::<8, _>(0, encoded, bytes_writer).ok()?;

        let (sign, delta_base) = if base >= required_insert_count {
            (0, base - required_insert_count)
        } else {
            (1, required_insert_count - base - 1)
        };

        Self::encode_integer::<7, _>(sign, delta_base, bytes_writer).ok()?;

        Some(())
    }

    fn encode_integer<const N: usize, W>(
        flags: u8,
        value: u64,
        bytes_writer: &mut W,
    ) -> Result<(), EndOfBuffer>
    where
        W: BytesWriter,
    {
        const_assert!(N: usize => N <= 8 && N >= 1);

        let mask = (0x01u64 << N) - 1;
        let flags = ((flags as u64) << N) as u8;

        if value < mask {
            bytes_writer.put_bytes(&[flags | value as u8])?;
            return Ok(());
        }

        bytes_writer.put_bytes(&[flags | mask as u8])?;

        let mut rem = value - mask;
        while rem >= 0x80 {
            let byte = rem as u8 | 0x80;
            bytes_writer.put_bytes(&[byte])?;
            rem >>= 7;
        }

        bytes_writer.put_bytes(&[rem as u8])?;

        Ok(())
    }

    fn encode_string<const N: usize, S, W>(
        flags: u8,
        value: S,
        bytes_writer: &mut W,
    ) -> Result<(), EndOfBuffer>
    where
        S: AsRef<str>,
        W: BytesWriter,
    {
        let value = value.as_ref().as_bytes();

        let mut huffman_buffer = Vec::new();

        let (is_huffman, string_data) = match httlib_huffman::encode(value, &mut huffman_buffer) {
            Ok(()) => {
                if huffman_buffer.len() < value.len() {
                    (true, huffman_buffer.as_slice())
                } else {
                    (false, value)
                }
            }
            Err(_) => (false, value),
        };

        let flags = (flags << 1) | (is_huffman as u8);

        Self::encode_integer::<N, _>(flags, string_data.len() as u64, bytes_writer)?;
        bytes_writer.put_bytes(string_data)
    }
}

enum LookupIndexFound {
    KeyValue(usize),
    KeyOnly(usize),
}

struct StaticTable;

impl StaticTable {
    const STATIC_TABLE: &'static [(&'static str, &'static str); 99] = &[
        (":authority", ""),
        (":path", "/"),
        ("age", "0"),
        ("content-disposition", ""),
        ("content-length", "0"),
        ("cookie", ""),
        ("date", ""),
        ("etag", ""),
        ("if-modified-since", ""),
        ("if-none-match", ""),
        ("last-modified", ""),
        ("link", ""),
        ("location", ""),
        ("referer", ""),
        ("set-cookie", ""),
        (":method", "CONNECT"),
        (":method", "DELETE"),
        (":method", "GET"),
        (":method", "HEAD"),
        (":method", "OPTIONS"),
        (":method", "POST"),
        (":method", "PUT"),
        (":scheme", "http"),
        (":scheme", "https"),
        (":status", "103"),
        (":status", "200"),
        (":status", "304"),
        (":status", "404"),
        (":status", "503"),
        ("accept", "*/*"),
        ("accept", "application/dns-message"),
        ("accept-encoding", "gzip, deflate, br"),
        ("accept-ranges", "bytes"),
        ("access-control-allow-headers", "cache-control"),
        ("access-control-allow-headers", "content-type"),
        ("access-control-allow-origin", "*"),
        ("cache-control", "max-age=0"),
        ("cache-control", "max-age=2592000"),
        ("cache-control", "max-age=604800"),
        ("cache-control", "no-cache"),
        ("cache-control", "no-store"),
        ("cache-control", "public, max-age=31536000"),
        ("content-encoding", "br"),
        ("content-encoding", "gzip"),
        ("content-type", "application/dns-message"),
        ("content-type", "application/javascript"),
        ("content-type", "application/json"),
        ("content-type", "application/x-www-form-urlencoded"),
        ("content-type", "image/gif"),
        ("content-type", "image/jpeg"),
        ("content-type", "image/png"),
        ("content-type", "text/css"),
        ("content-type", "text/html; charset=utf-8"),
        ("content-type", "text/plain"),
        ("content-type", "text/plain;charset=utf-8"),
        ("range", "bytes=0-"),
        ("strict-transport-security", "max-age=31536000"),
        (
            "strict-transport-security",
            "max-age=31536000; includesubdomains",
        ),
        (
            "strict-transport-security",
            "max-age=31536000; includesubdomains; preload",
        ),
        ("vary", "accept-encoding"),
        ("vary", "origin"),
        ("x-content-type-options", "nosniff"),
        ("x-xss-protection", "1; mode=block"),
        (":status", "100"),
        (":status", "204"),
        (":status", "206"),
        (":status", "302"),
        (":status", "400"),
        (":status", "403"),
        (":status", "421"),
        (":status", "425"),
        (":status", "500"),
        ("accept-language", ""),
        ("access-control-allow-credentials", "FALSE"),
        ("access-control-allow-credentials", "TRUE"),
        ("access-control-allow-headers", "*"),
        ("access-control-allow-methods", "get"),
        ("access-control-allow-methods", "get, post, options"),
        ("access-control-allow-methods", "options"),
        ("access-control-expose-headers", "content-length"),
        ("access-control-request-headers", "content-type"),
        ("access-control-request-method", "get"),
        ("access-control-request-method", "post"),
        ("alt-svc", "clear"),
        ("authorization", ""),
        (
            "content-security-policy",
            "script-src 'none'; object-src 'none'; base-uri 'none'",
        ),
        ("early-data", "1"),
        ("expect-ct", ""),
        ("forwarded", ""),
        ("if-range", ""),
        ("origin", ""),
        ("purpose", "prefetch"),
        ("server", ""),
        ("timing-allow-origin", "*"),
        ("upgrade-insecure-requests", "1"),
        ("user-agent", ""),
        ("x-forwarded-for", ""),
        ("x-frame-options", "deny"),
        ("x-frame-options", "sameorigin"),
    ];

    fn lookup_field(index: usize) -> Option<(&'static str, &'static str)> {
        Self::STATIC_TABLE.get(index).cloned()
    }

    fn lookup_index<K, V>(key: K, value: V) -> Option<LookupIndexFound>
    where
        K: AsRef<str>,
        V: AsRef<str>,
    {
        Self::STATIC_TABLE
            .iter()
            .enumerate()
            .find(|(_index, entry)| key.as_ref() == entry.0)
            .map(|(index, entry)| {
                if value.as_ref() == entry.1 {
                    LookupIndexFound::KeyValue(index)
                } else {
                    LookupIndexFound::KeyOnly(index)
                }
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::random;
    use rand::rng;
    use rand::Rng;

    #[test]
    fn decode_field_line_type() {
        for i in 0..=u8::MAX {
            Decoder::decode_field_line_type(i);
        }
    }

    #[test]
    fn encode_decode() {
        let headers = HashMap::from([
            ("key1", "value1"),
            (":status", "200"),
            ("key2", "value2"),
            (":status", "not_found"),
        ]);

        let enc_data = Encoder::encode(&headers);
        let headers_dec = Decoder::decode(enc_data).unwrap();
        let headers_dec = headers_dec
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();

        assert_eq!(headers, headers_dec);
    }

    #[test]
    fn integer() {
        const PREFIX_LEN: usize = 5;

        let mut buffer = Vec::new();

        for _ in 0..1_000_000 {
            buffer.clear();

            let flags = random::<u8>() & ((0x1 << (8 - PREFIX_LEN)) - 1);
            let value = random::<u64>() as usize;

            Encoder::encode_integer::<PREFIX_LEN, _>(flags, value as u64, &mut buffer).unwrap();

            let (flags_dec, value_dec) =
                Decoder::decode_integer::<PREFIX_LEN, _>(&mut buffer.as_slice()).unwrap();

            assert_eq!(flags, flags_dec);
            assert_eq!(value, value_dec);
        }
    }

    #[test]
    fn integer_max() {
        let mut buffer = Vec::new();
        Encoder::encode_integer::<1, _>(0, usize::MAX as u64, &mut buffer).unwrap();
        let (_, value) = Decoder::decode_integer::<1, _>(&mut buffer.as_slice()).unwrap();
        assert_eq!(value, usize::MAX);
    }

    #[test]
    fn integer_overflow() {
        let mut buffer = Vec::new();

        for len in 0.. {
            buffer.clear();
            buffer.resize(len, 0xFF);

            if let Err(DecodingError::IntegerOverflow) =
                Decoder::decode_integer::<1, _>(&mut buffer.as_slice())
            {
                break;
            }
        }
    }

    #[test]
    fn integer_eof() {
        assert!(matches!(
            Decoder::decode_integer::<1, _>(&mut [0b0000_0001].as_slice()),
            Err(DecodingError::UnexpectedFin)
        ));

        assert!(matches!(
            Decoder::decode_integer::<1, _>(&mut [0b0000_0001, 0b1000_0000].as_slice()),
            Err(DecodingError::UnexpectedFin)
        ));
    }

    #[test]
    fn string() {
        const PREFIX_LEN: usize = 5;

        let mut buffer = Vec::new();

        for _ in 0..10_000 {
            buffer.clear();

            let flags = random::<u8>() & ((0x1 << (8 - PREFIX_LEN)) - 1);

            let string_len = rng().random_range(0..1024);
            let value = rng()
                .sample_iter(rand::distr::Alphanumeric)
                .take(string_len)
                .map(char::from)
                .collect::<String>();

            Encoder::encode_string::<PREFIX_LEN, _, _>(flags, &value, &mut buffer).unwrap();

            let value_dec =
                Decoder::decode_string::<PREFIX_LEN, _>(&mut buffer.as_slice()).unwrap();

            assert_eq!(value, value_dec);
        }
    }

    /// Builds a section prefix followed by field lines produced by `fields`.
    fn section<F>(required_insert_count: u64, base: u64, max_entries: u64, fields: F) -> Vec<u8>
    where
        F: FnOnce(&mut Vec<u8>),
    {
        let mut buffer = Vec::new();

        Encoder::encode_field_section_prefix(required_insert_count, base, max_entries, &mut buffer)
            .unwrap();

        fields(&mut buffer);

        buffer
    }

    fn table_with(capacity: usize, entries: &[(&str, &str)]) -> DynamicTable {
        let mut table = DynamicTable::new(capacity);
        table.set_capacity(capacity).unwrap();

        for (name, value) in entries {
            table.insert(name.to_string(), value.to_string()).unwrap();
        }

        table
    }

    #[test]
    fn dynamic_table_insert_and_lookup() {
        let table = table_with(4096, &[("a", "1"), ("b", "2")]);

        assert_eq!(table.insert_count(), 2);
        assert_eq!(table.len(), 2);
        assert_eq!(table.size(), 2 * (1 + 1 + 32));
        assert_eq!(table.get_absolute(1), Some(("a", "1")));
        assert_eq!(table.get_absolute(2), Some(("b", "2")));
        assert_eq!(table.get_absolute(0), None);
        assert_eq!(table.get_absolute(3), None);

        // Relative 0 is the entry inserted just before Base.
        assert_eq!(table.get_relative(0, 2), Some(("b", "2")));
        assert_eq!(table.get_relative(1, 2), Some(("a", "1")));
        assert_eq!(table.get_relative(2, 2), None);

        // Post-base indexes count forward from base.
        assert_eq!(table.get_post_base(0, 1), Some(("b", "2")));
        assert_eq!(table.get_post_base(1, 1), None);

        assert_eq!(table.find_absolute("a", "1"), Some(1));
        assert_eq!(table.find_absolute("a", "2"), None);
    }

    #[test]
    fn dynamic_table_evicts_oldest() {
        // Room for exactly two entries of 34 bytes.
        let mut table = table_with(68, &[("a", "1"), ("b", "2")]);
        table.insert("c".to_string(), "3".to_string()).unwrap();

        assert_eq!(table.insert_count(), 3);
        assert_eq!(table.len(), 2);
        assert_eq!(table.get_absolute(1), None);
        assert_eq!(table.get_absolute(2), Some(("b", "2")));
        assert_eq!(table.get_absolute(3), Some(("c", "3")));
    }

    #[test]
    fn dynamic_table_entry_larger_than_capacity() {
        let mut table = table_with(34, &[]);

        assert_eq!(
            table.insert("name".to_string(), "value".to_string()),
            Err(DynamicTableError::EntryDoesNotFit)
        );
        assert_eq!(table.insert_count(), 0);
    }

    #[test]
    fn dynamic_table_capacity_is_bounded() {
        let mut table = DynamicTable::new(4096);

        assert_eq!(
            table.set_capacity(4097),
            Err(DynamicTableError::CapacityExceeded)
        );
        assert_eq!(table.capacity(), 0);

        table.set_capacity(4096).unwrap();
        assert_eq!(table.capacity(), 4096);
    }

    #[test]
    fn dynamic_table_shrinking_capacity_evicts() {
        let mut table = table_with(4096, &[("a", "1"), ("b", "2")]);

        table.set_capacity(34).unwrap();
        assert_eq!(table.len(), 1);
        assert_eq!(table.get_absolute(2), Some(("b", "2")));
    }

    #[test]
    fn dynamic_table_never_evicts_unacknowledged() {
        let mut table = table_with(68, &[("a", "1"), ("b", "2")]);

        // Nothing acknowledged yet: evicting entry 1 is forbidden.
        assert_eq!(
            table.insert_with_ack_floor("c".to_string(), "3".to_string(), Some(0)),
            Err(DynamicTableError::EntryDoesNotFit)
        );
        assert_eq!(table.len(), 2);

        // Once entry 1 is acknowledged it may be evicted.
        table
            .insert_with_ack_floor("c".to_string(), "3".to_string(), Some(1))
            .unwrap();
        assert_eq!(table.get_absolute(3), Some(("c", "3")));
    }

    #[test]
    fn dynamic_table_duplicate() {
        let mut table = table_with(4096, &[("a", "1"), ("b", "2")]);

        table.duplicate(0).unwrap();
        assert_eq!(table.get_absolute(3), Some(("b", "2")));

        // Relative index counts back from the newest entry: 2 is the oldest.
        table.duplicate(2).unwrap();
        assert_eq!(table.get_absolute(4), Some(("a", "1")));

        assert_eq!(table.duplicate(9), Err(DynamicTableError::IndexNotFound));
    }

    #[test]
    fn required_insert_count_roundtrip() {
        let max_entries = 128;

        for count in 0..1000 {
            let encoded = encode_required_insert_count(count, max_entries).unwrap();

            // The decoder knows about every insert the section may reference.
            let decoded = decode_required_insert_count(encoded, max_entries, count).unwrap();

            assert_eq!(decoded, count);
        }
    }

    #[test]
    fn required_insert_count_wraps() {
        let max_entries = 4;
        let full_range = 2 * max_entries;

        // The encoding wraps at 2 * MaxEntries, so the same encoded value maps
        // to different counts depending on what the decoder has received.
        let encoded = encode_required_insert_count(full_range, max_entries).unwrap();
        assert_eq!(encoded, 1);

        assert_eq!(
            decode_required_insert_count(encoded, max_entries, full_range).unwrap(),
            full_range
        );
        assert_eq!(
            decode_required_insert_count(encoded, max_entries, 2 * full_range).unwrap(),
            2 * full_range
        );
    }

    #[test]
    fn required_insert_count_invalid() {
        // A non-zero count against a zero-capacity table is not representable.
        assert!(encode_required_insert_count(1, 0).is_none());

        assert!(matches!(
            decode_required_insert_count(1, 0, 0),
            Err(DecodingError::InvalidRequiredInsertCount)
        ));

        // Too far in the future to be a wrapped value.
        assert!(matches!(
            decode_required_insert_count(u64::MAX, 4, 0),
            Err(DecodingError::InvalidRequiredInsertCount)
        ));
    }

    #[test]
    fn decode_dynamic_indexed_field_line() {
        let table = table_with(
            4096,
            &[(":method", "CONNECT"), (":protocol", "webtransport")],
        );
        let max_entries = table.max_entries();

        let data = section(2, 2, max_entries, |buffer| {
            // Indexed Field Line, dynamic, relative index 1 then 0.
            Encoder::encode_integer::<6, _>(0b10, 1, buffer).unwrap();
            Encoder::encode_integer::<6, _>(0b10, 0, buffer).unwrap();
        });

        let decoded = Decoder::decode_with(&table, data).unwrap();

        assert_eq!(decoded.required_insert_count, 2);
        assert_eq!(decoded.headers.get(":method").unwrap(), "CONNECT");
        assert_eq!(decoded.headers.get(":protocol").unwrap(), "webtransport");
    }

    #[test]
    fn decode_dynamic_literal_with_name_reference() {
        let table = table_with(4096, &[(":authority", "example.com")]);
        let max_entries = table.max_entries();

        let data = section(1, 1, max_entries, |buffer| {
            // Literal Field Line With Name Reference, dynamic, relative index 0.
            Encoder::encode_integer::<4, _>(0b0100, 0, buffer).unwrap();
            Encoder::encode_string::<7, _, _>(0, "other.example", buffer).unwrap();
        });

        let decoded = Decoder::decode_with(&table, data).unwrap();

        assert_eq!(decoded.headers.get(":authority").unwrap(), "other.example");
    }

    #[test]
    fn decode_post_base_field_lines() {
        let table = table_with(4096, &[("a", "1"), ("b", "2")]);
        let max_entries = table.max_entries();

        // Base of 0 puts both entries past the base.
        let data = section(2, 0, max_entries, |buffer| {
            // Indexed Field Line With Post-Base Index: absolute 1.
            Encoder::encode_integer::<4, _>(0b0001, 0, buffer).unwrap();
            // Literal Field Line With Post-Base Name Reference: absolute 2.
            Encoder::encode_integer::<3, _>(0b00000, 1, buffer).unwrap();
            Encoder::encode_string::<7, _, _>(0, "value", buffer).unwrap();
        });

        let decoded = Decoder::decode_with(&table, data).unwrap();

        assert_eq!(decoded.headers.get("a").unwrap(), "1");
        assert_eq!(decoded.headers.get("b").unwrap(), "value");
    }

    #[test]
    fn decode_blocked_section_is_rejected() {
        let table = table_with(4096, &[("a", "1")]);
        let max_entries = table.max_entries();

        // The section requires two inserts, the table holds one.
        let data = section(2, 2, max_entries, |buffer| {
            Encoder::encode_integer::<6, _>(0b10, 0, buffer).unwrap();
        });

        assert!(matches!(
            Decoder::decode_with(&table, data),
            Err(DecodingError::Blocked)
        ));
    }

    #[test]
    fn decode_evicted_reference_is_rejected() {
        // Two entries fit; the first is evicted by the third insert.
        let mut table = table_with(68, &[("a", "1"), ("b", "2")]);
        table.insert("c".to_string(), "3".to_string()).unwrap();

        let max_entries = table.max_entries();
        let data = section(3, 3, max_entries, |buffer| {
            // Relative index 2 is the oldest insert, which was evicted.
            Encoder::encode_integer::<6, _>(0b10, 2, buffer).unwrap();
        });

        assert!(matches!(
            Decoder::decode_with(&table, data),
            Err(DecodingError::DynamicIndexNotFound)
        ));
    }

    #[test]
    fn decode_dynamic_reference_without_table() {
        let table = DynamicTable::new(0);

        // Required insert count of zero, but a dynamic field line.
        let data = section(0, 0, 0, |buffer| {
            Encoder::encode_integer::<6, _>(0b10, 0, buffer).unwrap();
        });

        assert!(matches!(
            Decoder::decode_with(&table, data),
            Err(DecodingError::DynamicNotSupported)
        ));
    }

    #[test]
    fn encoder_stream_instructions_roundtrip() {
        let mut table = DynamicTable::new(4096);
        let mut stream = Vec::new();

        stream.extend(Encoder::encode_set_capacity(4096));
        stream.extend(Encoder::encode_insert_with_literal_name(
            ":protocol",
            "webtransport",
        ));
        // Static index 15 is (":method", "CONNECT").
        stream.extend(Encoder::encode_insert_with_name_reference(
            true, 15, "TRACE",
        ));
        // Dynamic index 1 counts back from the newest entry: ":protocol".
        stream.extend(Encoder::encode_insert_with_name_reference(
            false, 1, "unknown",
        ));
        stream.extend(Encoder::encode_duplicate(0));

        let consumed = Decoder::feed_encoder_stream(&mut table, &stream).unwrap();

        assert_eq!(consumed, stream.len());
        assert_eq!(table.capacity(), 4096);
        assert_eq!(table.insert_count(), 4);
        assert_eq!(table.get_absolute(1), Some((":protocol", "webtransport")));
        assert_eq!(table.get_absolute(2), Some((":method", "TRACE")));
        assert_eq!(table.get_absolute(3), Some((":protocol", "unknown")));
        assert_eq!(table.get_absolute(4), Some((":protocol", "unknown")));
    }

    #[test]
    fn encoder_stream_keeps_partial_instruction() {
        let mut stream = Encoder::encode_set_capacity(4096);
        stream.extend(Encoder::encode_insert_with_literal_name("name", "value"));

        let truncated = stream.len() - 3;
        let capacity_len = Encoder::encode_set_capacity(4096).len();

        let mut table = DynamicTable::new(4096);
        let consumed = Decoder::feed_encoder_stream(&mut table, &stream[..truncated]).unwrap();

        // Only the complete Set Capacity is applied; the insert is left behind.
        assert_eq!(consumed, capacity_len);
        assert_eq!(table.capacity(), 4096);
        assert_eq!(table.insert_count(), 0);

        // The caller retries from the unconsumed offset once the rest arrives.
        let consumed = Decoder::feed_encoder_stream(&mut table, &stream[consumed..]).unwrap();

        assert_eq!(consumed, stream.len() - capacity_len);
        assert_eq!(table.get_absolute(1), Some(("name", "value")));
    }

    #[test]
    fn encoder_stream_rejects_capacity_over_maximum() {
        let mut table = DynamicTable::new(4096);

        assert!(matches!(
            Decoder::feed_encoder_stream(&mut table, &Encoder::encode_set_capacity(4097)),
            Err(EncoderStreamError::Table(
                DynamicTableError::CapacityExceeded
            ))
        ));
    }

    #[test]
    fn encoder_stream_rejects_unknown_dynamic_index() {
        let mut table = DynamicTable::new(4096);
        let mut stream = Encoder::encode_set_capacity(4096);
        stream.extend(Encoder::encode_insert_with_name_reference(
            false, 0, "value",
        ));

        assert!(matches!(
            Decoder::feed_encoder_stream(&mut table, &stream),
            Err(EncoderStreamError::Table(DynamicTableError::IndexNotFound))
        ));
    }

    #[test]
    fn decoder_stream_instructions_roundtrip() {
        let mut stream = Vec::new();

        stream.extend(Encoder::encode_section_acknowledgement(4));
        stream.extend(Encoder::encode_stream_cancellation(8));
        stream.extend(Encoder::encode_insert_count_increment(3));
        stream.extend(Encoder::encode_insert_count_increment(2));
        stream.extend(Encoder::encode_section_acknowledgement(1000));

        let (consumed, instructions) = Encoder::feed_decoder_stream(&stream).unwrap();

        assert_eq!(consumed, stream.len());
        assert_eq!(instructions.section_acknowledgements, vec![4, 1000]);
        assert_eq!(instructions.stream_cancellations, vec![8]);
        assert_eq!(instructions.insert_count_increment, 5);
    }

    #[test]
    fn decoder_stream_keeps_partial_instruction() {
        // A stream id large enough to need continuation bytes.
        let stream = Encoder::encode_section_acknowledgement(1 << 20);
        assert!(stream.len() > 1);

        let (consumed, instructions) = Encoder::feed_decoder_stream(&stream[..1]).unwrap();

        assert_eq!(consumed, 0);
        assert!(instructions.section_acknowledgements.is_empty());

        let (consumed, instructions) = Encoder::feed_decoder_stream(&stream).unwrap();
        assert_eq!(consumed, stream.len());
        assert_eq!(instructions.section_acknowledgements, vec![1 << 20]);
    }

    /// An encoder table sized from what the peer advertised, and the peer's own table.
    fn encoder_and_peer(peer_capacity: usize) -> (DynamicTable, DynamicTable) {
        let mut encoder = DynamicTable::new(peer_capacity);
        encoder.set_capacity(peer_capacity).unwrap();

        // The peer applies the same Set Dynamic Table Capacity off the encoder stream.
        let mut peer = DynamicTable::new(peer_capacity);
        Decoder::feed_encoder_stream(&mut peer, &Encoder::encode_set_capacity(peer_capacity))
            .unwrap();

        (encoder, peer)
    }

    fn decode_against(peer: &DynamicTable, section: &EncodedSection) -> Vec<(String, String)> {
        let mut headers = Decoder::decode_with(peer, &section.payload)
            .unwrap()
            .headers
            .into_iter()
            .collect::<Vec<_>>();

        headers.sort();
        headers
    }

    #[test]
    fn a_first_section_is_literal_and_seeds_the_table() {
        let (mut encoder, mut peer) = encoder_and_peer(4096);

        let headers = [(":method", "CONNECT"), (":authority", "example.com")];
        let section = Encoder::encode_with(&mut encoder, 0, headers);

        // Nothing has been acknowledged, so nothing may be referenced.
        assert_eq!(section.payload[0], 0, "required insert count must be zero");
        assert!(!section.instructions.is_empty(), "the table must be seeded");

        Decoder::feed_encoder_stream(&mut peer, &section.instructions).unwrap();

        assert_eq!(
            decode_against(&peer, &section),
            vec![
                (":authority".to_string(), "example.com".to_string()),
                (":method".to_string(), "CONNECT".to_string()),
            ]
        );
        assert_eq!(encoder.insert_count(), peer.insert_count());
    }

    #[test]
    fn a_later_section_references_what_the_peer_acknowledged() {
        let (mut encoder, mut peer) = encoder_and_peer(4096);

        let headers = [(":method", "CONNECT"), (":authority", "example.com")];
        let first = Encoder::encode_with(&mut encoder, 0, headers);
        Decoder::feed_encoder_stream(&mut peer, &first.instructions).unwrap();

        // The peer acknowledges the inserts with an Insert Count Increment.
        let known_received_count = peer.insert_count();
        assert_eq!(known_received_count, 2);

        let second = Encoder::encode_with(&mut encoder, known_received_count, headers);

        assert_ne!(
            second.payload[0], 0,
            "the acknowledged entries must be referenced"
        );
        assert!(
            second.instructions.is_empty(),
            "nothing new to insert the second time"
        );
        assert!(
            second.payload.len() < first.payload.len(),
            "referencing must be smaller than repeating"
        );

        assert_eq!(
            decode_against(&peer, &second),
            decode_against(&peer, &first)
        );
    }

    #[test]
    fn an_unacknowledged_entry_is_never_referenced() {
        let (mut encoder, _peer) = encoder_and_peer(4096);

        let headers = [("custom-key", "custom-value")];

        // Seed the table, then encode again with the peer still not acknowledging.
        let _ = Encoder::encode_with(&mut encoder, 0, headers);
        assert_eq!(encoder.insert_count(), 1);

        let second = Encoder::encode_with(&mut encoder, 0, headers);

        // The entry exists but is not acknowledged, so the section stays literal and
        // the entry is not inserted twice.
        assert_eq!(second.payload[0], 0);
        assert!(second.instructions.is_empty());
    }

    /// The required insert count is encoded modulo the *peer's* `MaxEntries`, not this
    /// endpoint's. Sizing from local settings is a mistake symmetric tests cannot see,
    /// so this pins the value the peer will actually be able to reconstruct.
    #[test]
    fn the_required_insert_count_uses_the_peers_max_entries() {
        let peer_capacity = 4096;
        let (mut encoder, mut peer) = encoder_and_peer(peer_capacity);

        // Enough inserts for the count to exceed the peer's wrap range of 2 * 128.
        for index in 0..300 {
            let headers = [(format!("key{index}"), format!("value{index}"))];
            let known_received_count = encoder.insert_count();
            let section = Encoder::encode_with(&mut encoder, known_received_count, headers);
            Decoder::feed_encoder_stream(&mut peer, &section.instructions).unwrap();
        }

        assert_eq!(encoder.insert_count(), 300);
        assert_eq!(peer.insert_count(), 300);

        let newest = [("key299", "value299")];
        let section = Encoder::encode_with(&mut encoder, 300, newest);

        let peer_max_entries = (peer_capacity / 32) as u64;
        let local_max_entries = 65536 / 32;
        assert_ne!(peer_max_entries, local_max_entries);

        let encoded = Decoder::decode_integer::<8, _>(&mut section.payload.as_slice())
            .unwrap()
            .1 as u64;

        assert_eq!(
            encoded,
            encode_required_insert_count(300, peer_max_entries).unwrap()
        );
        assert_ne!(
            encoded,
            encode_required_insert_count(300, local_max_entries).unwrap()
        );

        // And the peer reconstructs it, which is the point of the modulus.
        assert_eq!(
            decode_against(&peer, &section),
            vec![("key299".to_string(), "value299".to_string())]
        );
    }

    #[test]
    fn a_peer_without_a_table_gets_static_encoding() {
        let mut encoder = DynamicTable::new(0);
        let peer = DynamicTable::new(0);

        let headers = [(":method", "CONNECT"), ("custom-key", "custom-value")];
        let section = Encoder::encode_with(&mut encoder, 0, headers);

        assert!(section.instructions.is_empty());
        assert_eq!(section.payload, Encoder::encode(headers).to_vec());
        assert_eq!(decode_against(&peer, &section).len(), 2);
    }

    /// Deterministic xorshift64*, so a failure is reproducible.
    struct Fuzz(u64);

    impl Fuzz {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545_f491_4f6c_dd1d)
        }

        fn bytes(&mut self, max_len: usize) -> Vec<u8> {
            let len = (self.next() as usize) % (max_len + 1);
            (0..len).map(|_| self.next() as u8).collect()
        }
    }

    /// Every QPACK parser reads what a peer sends before anything has authenticated it,
    /// so the property under test is that hostile input is rejected rather than fatal.
    /// What comes back does not matter; not panicking does.
    #[test]
    fn parsers_never_panic_on_random_input() {
        let mut fuzz = Fuzz(0x9e37_79b9_7f4a_7c15);

        for _ in 0..100_000 {
            let data = fuzz.bytes(64);

            let mut table = table_with(4096, &[("a", "1"), (":path", "/x")]);

            let _ = Decoder::decode(&data);
            let _ = Decoder::decode_with(&table, &data);
            let _ = Encoder::feed_decoder_stream(&data);

            // Decode again once the same bytes have been let loose on the table, so
            // sections are also read against state a peer managed to influence.
            let _ = Decoder::feed_encoder_stream(&mut table, &data);
            let _ = Decoder::decode_with(&table, &data);
        }
    }

    #[test]
    fn a_required_insert_count_at_the_wrap_boundary_is_rejected() {
        let table = table_with(4096, &[("a", "1")]);
        let max_entries = table.max_entries();

        // The largest value the wrap can legally produce, and one past it.
        for encoded in [2 * max_entries, 2 * max_entries + 1, u64::MAX] {
            let mut data = Vec::new();
            Encoder::encode_integer::<8, _>(0, encoded, &mut data).unwrap();
            Encoder::encode_integer::<7, _>(0, 0, &mut data).unwrap();

            assert!(Decoder::decode_with(&table, data).is_err());
        }
    }

    #[test]
    fn a_base_below_zero_is_rejected() {
        let table = table_with(4096, &[("a", "1")]);
        let max_entries = table.max_entries();

        let mut data = Vec::new();
        let encoded = encode_required_insert_count(1, max_entries).unwrap();
        Encoder::encode_integer::<8, _>(0, encoded, &mut data).unwrap();
        // Sign bit set with a delta larger than the required insert count.
        Encoder::encode_integer::<7, _>(1, 5, &mut data).unwrap();

        assert!(matches!(
            Decoder::decode_with(&table, data),
            Err(DecodingError::InvalidRequiredInsertCount)
        ));
    }

    #[test]
    fn a_post_base_reference_past_the_table_is_rejected() {
        let table = table_with(4096, &[("a", "1")]);
        let max_entries = table.max_entries();

        let data = section(1, 1, max_entries, |buffer| {
            // Post-base index 4 is well past the newest insert.
            Encoder::encode_integer::<4, _>(0b0001, 4, buffer).unwrap();
        });

        assert!(matches!(
            Decoder::decode_with(&table, data),
            Err(DecodingError::DynamicIndexNotFound)
        ));
    }

    #[test]
    fn a_huffman_string_that_expands_hugely_is_bounded() {
        let table = DynamicTable::new(4096);

        // A maximal Huffman-coded literal: every bit set decodes to a long run, and
        // the declared length is all that can be allocated from.
        let mut data = Vec::new();
        Encoder::encode_integer::<8, _>(0, 0, &mut data).unwrap();
        Encoder::encode_integer::<7, _>(0, 0, &mut data).unwrap();
        Encoder::encode_integer::<3, _>(0b00101, 512, &mut data).unwrap();
        data.extend(std::iter::repeat_n(0xff, 512));

        // Either it decodes to something bounded by the input, or it is rejected.
        // What must not happen is a panic or an unbounded allocation.
        let _ = Decoder::decode_with(&table, data);
    }

    #[test]
    fn an_integer_with_an_endless_continuation_is_rejected() {
        let mut data = vec![0xff];
        data.extend(std::iter::repeat_n(0x80, 128));
        data.push(0x00);

        assert!(matches!(
            Decoder::decode_integer::<8, _>(&mut data.as_slice()),
            Err(DecodingError::IntegerOverflow)
        ));
    }

    /// RFC 9204 Appendix B, played end to end against one decoder.
    ///
    /// These are the only vectors here produced by another implementation, so they are
    /// what keeps the encoder and decoder from agreeing on something the rest of the
    /// world does not. Byte strings and table sizes are copied from the RFC.
    #[test]
    fn rfc_9204_appendix_b() {
        // The capacity the encoder sets is 220, so MaxEntries is 6.
        let mut table = DynamicTable::new(220);

        // B.1. Literal Field Line with Name Reference.
        let section = [
            0x00, 0x00, // Required Insert Count = 0, Base = 0
            0x51, 0x0b, b'/', b'i', b'n', b'd', b'e', b'x', b'.', b'h', b't', b'm', b'l',
        ];
        let decoded = Decoder::decode_with(&table, section).unwrap();
        assert_eq!(decoded.required_insert_count, 0);
        assert_eq!(decoded.headers.get(":path").unwrap(), "/index.html");

        // B.2. Dynamic Table.
        let mut encoder_stream = vec![0x3f, 0xbd, 0x01]; // Set Dynamic Table Capacity = 220
        encoder_stream.extend([0xc0, 0x0f]); // Insert With Name Reference, static index 0
        encoder_stream.extend(b"www.example.com");
        encoder_stream.extend([0xc1, 0x0c]); // Insert With Name Reference, static index 1
        encoder_stream.extend(b"/sample/path");

        assert_eq!(
            Decoder::feed_encoder_stream(&mut table, &encoder_stream).unwrap(),
            encoder_stream.len()
        );
        assert_eq!(table.capacity(), 220);
        assert_eq!(table.insert_count(), 2);
        assert_eq!(table.size(), 106);

        let section = [
            0x03, 0x81, // Required Insert Count = 2, Base = 0
            0x10, // Indexed Field Line With Post-Base Index 0
            0x11, // Indexed Field Line With Post-Base Index 1
        ];
        let decoded = Decoder::decode_with(&table, section).unwrap();
        assert_eq!(decoded.required_insert_count, 2);
        assert_eq!(
            decoded.headers.get(":authority").unwrap(),
            "www.example.com"
        );
        assert_eq!(decoded.headers.get(":path").unwrap(), "/sample/path");

        // The decoder answers with a Section Acknowledgement for stream 4.
        assert_eq!(Encoder::encode_section_acknowledgement(4), vec![0x84]);

        // B.3. Speculative Insert.
        let mut encoder_stream = vec![0x4a]; // Insert With Literal Name, 10 bytes
        encoder_stream.extend(b"custom-key");
        encoder_stream.push(0x0c);
        encoder_stream.extend(b"custom-value");

        assert_eq!(
            Decoder::feed_encoder_stream(&mut table, &encoder_stream).unwrap(),
            encoder_stream.len()
        );
        assert_eq!(table.size(), 160);
        assert_eq!(Encoder::encode_insert_count_increment(1), vec![0x01]);

        // B.4. Duplicate Instruction, Stream Cancellation.
        assert_eq!(
            Decoder::feed_encoder_stream(&mut table, &[0x02]).unwrap(),
            1
        );
        assert_eq!(table.insert_count(), 4);
        assert_eq!(table.size(), 217);

        let section = [
            0x05, 0x00, // Required Insert Count = 4, Base = 4
            0x80, // Indexed Field Line, dynamic, relative index 0
            0xc1, // Indexed Field Line, static index 1
            0x81, // Indexed Field Line, dynamic, relative index 1
        ];
        let decoded = Decoder::decode_with(&table, section).unwrap();
        assert_eq!(decoded.required_insert_count, 4);
        assert_eq!(
            decoded.headers.get(":authority").unwrap(),
            "www.example.com"
        );
        assert_eq!(decoded.headers.get(":path").unwrap(), "/");
        assert_eq!(decoded.headers.get("custom-key").unwrap(), "custom-value");

        assert_eq!(Encoder::encode_stream_cancellation(8), vec![0x48]);

        // B.5. Dynamic Table Insert, Eviction.
        let mut encoder_stream = vec![0x81, 0x0d]; // Insert With Name Reference, dynamic index 1
        encoder_stream.extend(b"custom-value2");

        assert_eq!(
            Decoder::feed_encoder_stream(&mut table, &encoder_stream).unwrap(),
            encoder_stream.len()
        );
        assert_eq!(table.insert_count(), 5);
        assert_eq!(table.size(), 215);

        // The oldest entry was evicted to make room.
        assert_eq!(table.len(), 4);
        assert_eq!(table.get_absolute(1), None);
        assert_eq!(table.get_absolute(5), Some(("custom-key", "custom-value2")));
    }

    #[test]
    fn decode_static_section_ignores_table() {
        let headers = HashMap::from([("key1", "value1"), (":status", "200")]);
        let data = Encoder::encode(&headers);

        let decoded = Decoder::decode_with(&table_with(4096, &[("a", "1")]), &data).unwrap();

        assert_eq!(decoded.required_insert_count, 0);
        assert_eq!(decoded.headers.len(), 2);
    }
}
