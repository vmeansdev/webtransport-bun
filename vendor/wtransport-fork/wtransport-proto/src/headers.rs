use crate::error::ErrorCode;
use crate::frame::Frame;
use crate::frame::FrameKind;
use crate::qpack::Decoder;
use crate::qpack::DynamicTable;
use crate::qpack::Encoder;
use std::borrow::Cow;
use std::collections::HashMap;

/// HTTP3 headers from the request or response.
#[derive(Debug)]
pub struct Headers(HashMap<String, String>);

impl Headers {
    /// Constructs the headers from a HTTP3 [`Frame`].
    ///
    /// # Panics
    ///
    /// Panics if `frame` is not type [`FrameKind::Headers`].
    pub fn with_frame(frame: &Frame) -> Result<Self, ErrorCode> {
        Self::with_frame_dynamic(frame, &DynamicTable::new(0)).map(|(headers, _)| headers)
    }

    /// Constructs the headers from a HTTP3 [`Frame`], decoding against `table`.
    ///
    /// Also returns the required insert count of the field section: a non-zero value
    /// means the section referenced the dynamic table and has to be acknowledged on
    /// the decoder stream.
    ///
    /// # Panics
    ///
    /// Panics if `frame` is not type [`FrameKind::Headers`].
    pub fn with_frame_dynamic(
        frame: &Frame,
        table: &DynamicTable,
    ) -> Result<(Self, u64), ErrorCode> {
        assert!(matches!(frame.kind(), FrameKind::Headers));

        let decoded =
            Decoder::decode_with(table, frame.payload()).map_err(|_| ErrorCode::Decompression)?;

        Ok((Self(decoded.headers), decoded.required_insert_count))
    }

    /// Generates a [`Frame`] with these headers, using the static table only.
    pub fn generate_frame(&self) -> Frame<'static> {
        let headers = self.sorted_headers();
        let payload = Encoder::encode(headers);
        Frame::new_headers(Cow::Owned(payload.to_vec()))
    }

    /// Generates a [`Frame`] with these headers, indexing them in `table`.
    ///
    /// Also returns the encoder stream instructions that replicate the inserts, which
    /// the caller must write; the frame itself never depends on them having arrived.
    /// `table` must be sized from the peer's advertised capacity, and
    /// `known_received_count` is how many inserts it has acknowledged.
    pub fn generate_frame_dynamic(
        &self,
        table: &mut DynamicTable,
        known_received_count: u64,
    ) -> (Frame<'static>, Vec<u8>) {
        let headers = self.sorted_headers();
        let section = Encoder::encode_with(table, known_received_count, headers);

        (
            Frame::new_headers(Cow::Owned(section.payload)),
            section.instructions,
        )
    }

    /// Returns a reference to the value associated with the key.
    pub fn get<K>(&self, key: K) -> Option<&str>
    where
        K: AsRef<str>,
    {
        self.0.get(key.as_ref()).map(|s| s.as_str())
    }

    /// Inserts a field (key, value) in the headers.
    ///
    /// If the headers did have this key present, the value is updated.
    pub fn insert<K, V>(&mut self, key: K, value: V)
    where
        K: ToString,
        V: ToString,
    {
        self.0.insert(key.to_string(), value.to_string());
    }

    fn sorted_headers(&self) -> Vec<(&str, &str)> {
        let mut headers = self
            .0
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect::<Vec<_>>();

        headers.sort_by_key(|(name, _)| (!name.starts_with(':'), *name));

        headers
    }
}

impl<K, V> FromIterator<(K, V)> for Headers
where
    K: ToString,
    V: ToString,
{
    fn from_iter<T: IntoIterator<Item = (K, V)>>(iter: T) -> Self {
        Self(
            iter.into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        )
    }
}

impl AsRef<HashMap<String, String>> for Headers {
    fn as_ref(&self) -> &HashMap<String, String> {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_frame_kind() {
        let headers = [("key1", "value1"), ("key2", "value2")]
            .into_iter()
            .collect::<Headers>();

        let frame = headers.generate_frame();
        assert!(matches!(frame.kind(), FrameKind::Headers));
    }

    #[test]
    fn get() {
        let headers = [("key1", "value1"), ("key2", "value2")]
            .into_iter()
            .collect::<Headers>();

        assert_eq!(headers.get("key1"), Some("value1"));
        assert_eq!(headers.get("key2"), Some("value2"));
        assert_eq!(headers.get("key3"), None);
    }

    #[test]
    fn insert() {
        let mut headers = [("key1", "value1"), ("key2", "value2")]
            .into_iter()
            .collect::<Headers>();

        assert_eq!(headers.get("key1"), Some("value1"));
        headers.insert("key1", "value1bis");
        assert_eq!(headers.get("key1"), Some("value1bis"));

        assert_eq!(headers.get("key3"), None);
        headers.insert("key3", "value3");
        assert_eq!(headers.get("key3"), Some("value3"));
    }

    #[test]
    fn idempotence() {
        let headers = [("key1", "value1"), ("key2", "value2")]
            .into_iter()
            .collect::<Headers>();

        let frame = headers.generate_frame();

        assert_eq!(
            headers.as_ref(),
            Headers::with_frame(&frame).unwrap().as_ref()
        );
    }
}
