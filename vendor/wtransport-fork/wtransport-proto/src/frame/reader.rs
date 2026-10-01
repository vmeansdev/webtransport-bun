use super::*;
use std::future::poll_fn;
use std::pin::Pin;
use std::task::{ready, Context, Poll};

/// A cancellation-safe asynchronous frame reader.
///
/// Retain this value and pass the same underlying stream to each [`Self::read`]
/// call. Dropping a pending read preserves all consumed header and body bytes.
/// Use a new reader when replacing the underlying stream. A completed frame or
/// terminal error clears the state; resuming a stream after an error is not
/// supported. Unknown frame IDs retain [`Frame::read_async`]'s behavior: only
/// the type varint is consumed before returning [`ParseError::UnknownFrame`].
///
/// Payload storage is allocated only after checking the 4096-byte parse limit.
/// No bytes beyond the current frame are read.
#[derive(Debug, Default)]
pub struct FrameReader {
    kind: Option<FrameKind>,
    varint: [u8; VarInt::MAX_SIZE],
    varint_offset: usize,
    varint_size: usize,
    payload: Option<Vec<u8>>,
    payload_offset: usize,
}

impl FrameReader {
    /// Reads one frame, retaining partial progress if this future is cancelled.
    pub async fn read<R>(&mut self, reader: &mut R) -> Result<FrameOwned, IoReadError>
    where
        R: AsyncRead + Unpin + ?Sized,
    {
        poll_fn(|cx| match self.poll_frame(reader, cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(result) => {
                *self = Self::default();
                Poll::Ready(result)
            }
        })
        .await
    }

    fn poll_frame<R>(
        &mut self,
        reader: &mut R,
        cx: &mut Context<'_>,
    ) -> Poll<Result<FrameOwned, IoReadError>>
    where
        R: AsyncRead + Unpin + ?Sized,
    {
        loop {
            if let Some(payload) = self.payload.as_mut() {
                while self.payload_offset < payload.len() {
                    let count =
                        ready!(Pin::new(&mut *reader)
                            .poll_read(cx, &mut payload[self.payload_offset..]))
                        .map_err(bytes::IoReadError::from)?;
                    if count == 0 {
                        return Poll::Ready(Err(bytes::IoReadError::UnexpectedFin.into()));
                    }
                    self.payload_offset += count;
                }
                return Poll::Ready(Ok(Frame::new(
                    self.kind.expect("payload follows a frame kind"),
                    Cow::Owned(self.payload.take().expect("payload is present")),
                    None,
                )));
            }

            let value = ready!(self.poll_varint(reader, cx))?;
            match self.kind {
                None => {
                    self.kind = Some(
                        FrameKind::parse(value)
                            .ok_or(IoReadError::Parse(ParseError::UnknownFrame))?,
                    );
                }
                Some(FrameKind::WebTransport) => {
                    let session =
                        SessionId::try_from_varint(value).map_err(|InvalidSessionId| {
                            IoReadError::Parse(ParseError::InvalidSessionId)
                        })?;
                    return Poll::Ready(Ok(Frame::new_webtransport(session)));
                }
                Some(_) => {
                    let length = value.into_inner();
                    if length > Frame::MAX_PARSE_PAYLOAD_ALLOWED as u64 {
                        return Poll::Ready(Err(IoReadError::Parse(ParseError::PayloadTooBig)));
                    }
                    self.payload = Some(vec![0; length as usize]);
                }
            }
        }
    }

    fn poll_varint<R>(
        &mut self,
        reader: &mut R,
        cx: &mut Context<'_>,
    ) -> Poll<Result<VarInt, IoReadError>>
    where
        R: AsyncRead + Unpin + ?Sized,
    {
        // Read just the first byte until its two tag bits give the full width.
        loop {
            let end = self.varint_size.max(1);
            let count = ready!(
                Pin::new(&mut *reader).poll_read(cx, &mut self.varint[self.varint_offset..end])
            )
            .map_err(bytes::IoReadError::from)?;
            if count == 0 {
                let error = if self.kind.is_none() && self.varint_offset == 0 {
                    bytes::IoReadError::ImmediateFin
                } else {
                    bytes::IoReadError::UnexpectedFin
                };
                return Poll::Ready(Err(error.into()));
            }
            self.varint_offset += count;
            self.varint_size = VarInt::parse_size(self.varint[0]);
            if self.varint_offset == self.varint_size {
                let value = BufferReader::new(&self.varint[..self.varint_size])
                    .get_varint()
                    .expect("complete varint");
                self.varint_offset = 0;
                self.varint_size = 0;
                return Poll::Ready(Ok(value));
            }
        }
    }
}
